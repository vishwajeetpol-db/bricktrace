"""Federated Workspaces — cross-workspace producer-source fetch (Phase 2).

Lineage is metastore-wide, so a producer (notebook/job/pipeline) recorded in
system.access.* may run in a DIFFERENT workspace than the app. The graph already
spans workspaces (Phase 0); this module lets the LLM producer-source path fetch
that producer's source from the workspace where it actually lives.

Design: docs/FEDERATED_LINEAGE_DESIGN.md §7. Everything here is gated by the
`federated_sync.live_source_fetch` feature flag (default OFF).

Pieces:
  - An admin-curated registry (`federated_workspaces` table) mapping a peer
    workspace_id -> deployment host + a reference to its OAuth credential in a
    secret scope. The table NEVER stores secret values, only scope/key names.
  - `get_workspace_client(workspace_id)` — the app's own client for the local
    workspace, else an OAuth-M2M client for a registered peer (cached). The host
    comes from the registry and is SSRF-validated; it is never caller-supplied.
  - `user_can_view_in_peer(...)` — the per-user entitlement precheck. The fetch
    runs as the account SP (broader than any user), so before fetching we verify
    the REQUESTING user is entitled to the object in the peer. Fails CLOSED.

Credential model (design §7.2): one account-level service principal with an
OAuth (M2M) secret, added as a member of each peer workspace. One client_id/
secret pair works for every workspace the SP belongs to, so credentials are
O(1); only membership + per-object grants scale. Per-workspace SPs also work —
they are just distinct registry rows pointing at distinct secret keys.
"""
from __future__ import annotations

import os
import base64
import logging
import threading

from databricks.sdk import WorkspaceClient
from databricks.sdk.core import Config as SdkConfig
from databricks.sdk.service.sql import StatementState

from backend.lineage_service import _get_client, _app_workspace_id
from backend.feature_flags import get_flag_state
from backend.validators import UnsafeOutboundURL, assert_databricks_workspace_url

logger = logging.getLogger(__name__)

LINEAGE_CATALOG = os.environ.get("LINEAGE_CATALOG", "lattice_lineage")
LINEAGE_SCHEMA = os.environ.get("LINEAGE_SCHEMA", "lineage")
WORKSPACES_TABLE = f"{LINEAGE_CATALOG}.{LINEAGE_SCHEMA}.federated_workspaces"
WAREHOUSE_ID = os.environ.get("DATABRICKS_WAREHOUSE_ID", "")
SQL_WAIT_TIMEOUT = os.environ.get("SQL_WAIT_TIMEOUT", "50s")

FLAG = "federated_sync.live_source_fetch"

# Per-process cache of built peer clients, keyed by workspace_id. The SDK handles
# token refresh; we evict on registry change or an auth error.
_peer_clients: dict[str, WorkspaceClient] = {}
_peer_clients_lock = threading.Lock()


class PeerNotRegistered(Exception):
    """No enabled registry row for a cross-workspace producer's workspace_id."""


class CrossWorkspaceDisabled(Exception):
    """The live_source_fetch flag is off."""


def _execute_sql(sql: str) -> list[dict]:
    if not WAREHOUSE_ID:
        raise RuntimeError("No SQL warehouse available. Set DATABRICKS_WAREHOUSE_ID.")
    client = _get_client()
    resp = client.statement_execution.execute_statement(
        statement=sql, warehouse_id=WAREHOUSE_ID, wait_timeout=SQL_WAIT_TIMEOUT,
    )
    if resp.status.state != StatementState.SUCCEEDED:
        err = resp.status.error.message if resp.status.error else resp.status.state
        raise RuntimeError(f"SQL failed: {err}")
    if not resp.result or not resp.result.data_array:
        return []
    columns = [c.name for c in resp.manifest.schema.columns]
    return [dict(zip(columns, row)) for row in resp.result.data_array]


def _ensure_table() -> None:
    _execute_sql(
        f"CREATE TABLE IF NOT EXISTS {WORKSPACES_TABLE} ("
        f"workspace_id STRING, deployment_host STRING, display_name STRING, "
        f"auth_kind STRING, secret_scope STRING, client_id_key STRING, "
        f"client_secret_key STRING, enabled BOOLEAN, "
        f"registered_by STRING, registered_at TIMESTAMP"
        f") USING DELTA"
    )


def list_peer_workspaces() -> list[dict]:
    """Registered peer workspaces. Read path: returns [] (never raises) when the
    flag is off or the table isn't reachable."""
    if not get_flag_state(FLAG):
        return []
    try:
        _ensure_table()
        return _execute_sql(f"SELECT * FROM {WORKSPACES_TABLE} ORDER BY registered_at DESC")
    except Exception as e:
        logger.info(f"federated_workspaces: no peers readable yet: {e}")
        return []


def get_peer(workspace_id: str) -> dict | None:
    """One enabled registry row for a workspace_id, or None."""
    wid = str(workspace_id or "").strip()
    if not wid:
        return None
    for row in list_peer_workspaces():
        if str(row.get("workspace_id")) == wid and bool(row.get("enabled", True)):
            return row
    return None


def register_peer_workspace(workspace_id: str, deployment_host: str, actor: str,
                            secret_scope: str = "", client_id_key: str = "",
                            client_secret_key: str = "", display_name: str = "",
                            auth_kind: str = "app_sp", enabled: bool = True) -> dict:
    """Admin-curated registration. Caller MUST admin-gate this.

    The host is SSRF-validated at registration AND again at connect time (the row
    could be edited out of band).

    auth_kind:
      - "app_sp" (default): the app's OWN service principal is an account SP that's
        also a member of the peer; the factory reuses the app's ambient OAuth
        credentials (DATABRICKS_CLIENT_ID/SECRET) against the peer host. No secret
        scope needed — nothing extra is stored.
      - "account_sp" / "workspace_sp": read a distinct SP's OAuth credential from a
        secret scope. Secret VALUES are never stored — only the scope and key names.
    """
    host = assert_databricks_workspace_url(deployment_host, "peer deployment host")
    _ensure_table()
    safe = lambda s: (str(s) or "").replace("'", "")
    _execute_sql(
        f"INSERT INTO {WORKSPACES_TABLE} VALUES ("
        f"'{safe(workspace_id)}', '{safe(host)}', '{safe(display_name)}', "
        f"'{safe(auth_kind)}', '{safe(secret_scope)}', '{safe(client_id_key)}', "
        f"'{safe(client_secret_key)}', {'true' if enabled else 'false'}, "
        f"'{safe(actor)}', current_timestamp())"
    )
    return {"workspace_id": str(workspace_id), "deployment_host": host,
            "auth_kind": auth_kind, "enabled": enabled}


def _read_secret(scope: str, key: str) -> str:
    """Read a secret value as text (the app SP needs READ on the scope)."""
    resp = _get_client().secrets.get_secret(scope=scope, key=key)
    raw = resp.value
    if raw is None:
        raise RuntimeError(f"secret {scope}/{key} has no value")
    return base64.b64decode(raw).decode("utf-8")


def get_workspace_client(workspace_id: str | None) -> WorkspaceClient:
    """Client for reading a producer's source in `workspace_id`.

    - None or the app's own workspace -> the app SP client (unchanged local path).
    - a registered peer -> an OAuth-M2M client for that peer (cached).
    Raises CrossWorkspaceDisabled (flag off) or PeerNotRegistered (no row).
    """
    wid = str(workspace_id) if workspace_id is not None else None
    if not wid or wid == _app_workspace_id():
        return _get_client()

    if not get_flag_state(FLAG):
        raise CrossWorkspaceDisabled(
            f"producer runs in workspace {wid}; cross-workspace source fetch is disabled "
            f"(enable the '{FLAG}' flag)."
        )

    with _peer_clients_lock:
        cached = _peer_clients.get(wid)
        if cached is not None:
            return cached

    peer = get_peer(wid)
    if not peer:
        raise PeerNotRegistered(
            f"workspace {wid} is not a registered peer. An admin must register it "
            f"(host + credentials) before its producers' source can be read."
        )
    host = assert_databricks_workspace_url(peer["deployment_host"], "peer deployment host")
    client_id, client_secret = _peer_credentials(peer)
    client = WorkspaceClient(config=SdkConfig(
        host=host, client_id=client_id, client_secret=client_secret, auth_type="oauth-m2m",
    ))
    with _peer_clients_lock:
        _peer_clients[wid] = client
    return client


def _peer_credentials(peer: dict) -> tuple[str, str]:
    """OAuth (client_id, client_secret) for a peer, per its auth_kind.

    - "app_sp": the app's OWN service principal is an account SP and a member of the
      peer, so reuse the ambient OAuth credentials the Apps runtime injected
      (DATABRICKS_CLIENT_ID/SECRET). Nothing to store or read from a scope.
    - otherwise: a distinct SP whose credential lives in a secret scope.
    """
    auth_kind = (peer.get("auth_kind") or "app_sp").lower()
    if auth_kind == "app_sp":
        client_id = os.environ.get("DATABRICKS_CLIENT_ID", "")
        client_secret = os.environ.get("DATABRICKS_CLIENT_SECRET", "")
        if not client_id or not client_secret:
            raise RuntimeError(
                "app_sp auth needs the app's own OAuth credentials in the environment "
                "(DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET); they were not found."
            )
        return client_id, client_secret
    return (_read_secret(peer["secret_scope"], peer["client_id_key"]),
            _read_secret(peer["secret_scope"], peer["client_secret_key"]))


def evict_peer_client(workspace_id: str) -> None:
    """Drop a cached peer client (call on auth error or registry change)."""
    with _peer_clients_lock:
        _peer_clients.pop(str(workspace_id), None)


# ---------------------------------------------------------------------------
# Per-user entitlement precheck (design §7.6)
# ---------------------------------------------------------------------------

# object_type -> permissions API path segment. Notebook/file use numeric object
# ids (resolved separately); job/pipeline/query use their ids directly.
_PERM_PATH = {"JOB": "jobs", "PIPELINE": "pipelines", "QUERY": "queries"}
# Permission levels that imply the user may view the object's definition/source.
_VIEW_LEVELS = {"CAN_VIEW", "CAN_READ", "CAN_RUN", "CAN_MANAGE", "CAN_MANAGE_RUN", "IS_OWNER"}


def user_can_view_in_peer(workspace_id: str, user_name: str,
                          entity_type: str, entity_id: str) -> bool:
    """Does `user_name` have >= view access to (entity_type, entity_id) in the peer?

    The fetch runs as the account SP, which can read more than the user; this
    precheck stops the SP becoming an exfiltration path. Checked by reading the
    object's ACL in the peer (as the SP) and looking for the user principal.

    Fails CLOSED: any error, unknown object type, or missing principal -> False.
    """
    et = (entity_type or "").strip().upper()
    seg = _PERM_PATH.get(et)
    if not seg or not user_name:
        return False
    try:
        client = get_workspace_client(workspace_id)
        acl = client.api_client.do("GET", f"/api/2.0/permissions/{seg}/{entity_id}")
    except Exception as e:
        logger.warning(f"entitlement precheck failed for {user_name} on {et} {entity_id} "
                       f"in ws {workspace_id}: {e}")
        return False
    for entry in (acl or {}).get("access_control_list", []) or []:
        principal = entry.get("user_name") or entry.get("service_principal_name") or entry.get("group_name")
        if principal != user_name:
            continue
        for perm in entry.get("all_permissions", []) or []:
            if (perm.get("permission_level") or "").upper() in _VIEW_LEVELS:
                return True
    return False
