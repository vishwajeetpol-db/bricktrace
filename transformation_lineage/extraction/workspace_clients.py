"""Per-workspace SDK clients for cross-workspace source extraction.

Discovery reads `system.access.column_lineage`, which is metastore-wide, so a
producing job / notebook / pipeline may live in a DIFFERENT workspace than the one
this job runs in. Its run, path and source can only be read through a client for
THAT workspace — the local client would 404, or worse, export an unrelated
notebook that happens to sit at the same path locally.

Peers come from the same admin-curated `federated_workspaces` registry the app
uses (`backend/federated_workspaces.py`), read here through Spark so this package
keeps no dependency on `backend/` (the build job only ships `transformation_lineage`).
The registry stores only secret scope/key NAMES; the OAuth credential is read from
the secret scope at connect time (the job's identity needs READ on the scope).

`auth_kind = "app_sp"` peers reuse the app's ambient OAuth credentials, which only
exist inside the Apps runtime — not in the build job — so they resolve only when
DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET are present in the environment.
"""

from __future__ import annotations

import base64
import logging
import os
import threading
from typing import Any
from urllib.parse import urlsplit

from databricks.sdk import WorkspaceClient
from databricks.sdk.core import Config as SdkConfig

logger = logging.getLogger(__name__)

REGISTRY_TABLE_NAME = "federated_workspaces"

# Databricks workspace control-plane domains, per cloud (mirrors
# backend/validators.py — that module imports fastapi, so it can't be used here).
_DATABRICKS_WORKSPACE_SUFFIXES = (
    ".azuredatabricks.net",
    ".cloud.databricks.com",
    ".gcp.databricks.com",
)


class PeerUnavailable(Exception):
    """No usable client for a peer workspace. `reason` is a skip-reason key."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def _validated_host(raw: object) -> str:
    """Admin-registered peer host: https, no credentials, Databricks domain."""
    url = str(raw or "").strip()
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if (
        parts.scheme.lower() != "https"
        or parts.username
        or parts.password
        or not any(host.endswith(s) for s in _DATABRICKS_WORKSPACE_SUFFIXES)
    ):
        raise PeerUnavailable(
            "peer_host_invalid", f"peer host {url!r} is not an https Databricks workspace URL"
        )
    return url


def resolve_local_workspace_id(client: WorkspaceClient, spark: Any = None) -> str | None:
    """Workspace id this job runs in, or None if it can't be determined."""
    try:
        wid = client.get_workspace_id()
        if isinstance(wid, (int, str)) and str(wid).strip():
            return str(wid).strip()
    except Exception as e:  # noqa: BLE001
        logger.info("get_workspace_id failed: %s", e)
    if spark is not None:
        try:
            wid = spark.conf.get("spark.databricks.clusterUsageTags.clusterOwnerOrgId", None)
            if wid:
                return str(wid)
        except Exception:  # noqa: BLE001
            pass
    return None


class WorkspaceClientProvider:
    """Hands out the right `WorkspaceClient` for a discovered `workspace_id`.

    - None / the local workspace -> the local client (unchanged behavior).
    - a registered, enabled peer -> an OAuth-M2M client for it (cached).
    - anything else -> `PeerUnavailable`, so the caller skips that producer
      instead of reading it through the wrong workspace.
    """

    def __init__(
        self,
        local_client: WorkspaceClient,
        local_workspace_id: str | None,
        *,
        spark: Any = None,
        registry_table: str | None = None,
        enabled: bool = False,
    ):
        self._local = local_client
        self._local_wid = str(local_workspace_id) if local_workspace_id else None
        self._spark = spark
        self._registry_table = registry_table
        self._enabled = enabled
        self._peers: dict[str, dict] | None = None
        self._clients: dict[str, WorkspaceClient] = {}
        self._lock = threading.Lock()
        if self._local_wid is None:
            logger.warning(
                "Local workspace id unknown — treating every discovered producer as local"
            )

    def is_local(self, workspace_id: str | None) -> bool:
        wid = str(workspace_id).strip() if workspace_id is not None else ""
        return not wid or self._local_wid is None or wid == self._local_wid

    def get(self, workspace_id: str | None) -> WorkspaceClient:
        if self.is_local(workspace_id):
            return self._local
        wid = str(workspace_id).strip()
        if not self._enabled:
            raise PeerUnavailable(
                "cross_workspace_disabled",
                f"producer runs in workspace {wid}; cross-workspace fetch is disabled",
            )
        with self._lock:
            cached = self._clients.get(wid)
            if cached is not None:
                return cached
            peer = self._load_peers().get(wid)
            if not peer:
                raise PeerUnavailable(
                    "peer_workspace_unregistered",
                    f"workspace {wid} is not a registered, enabled peer",
                )
            host = _validated_host(peer.get("deployment_host"))
            client_id, client_secret = self._credentials(peer)
            try:
                client = WorkspaceClient(config=SdkConfig(
                    host=host, client_id=client_id, client_secret=client_secret,
                    auth_type="oauth-m2m",
                ))
            except Exception as e:  # noqa: BLE001
                raise PeerUnavailable("peer_client_error", f"workspace {wid}: {e}") from e
            self._clients[wid] = client
            return client

    def _load_peers(self) -> dict[str, dict]:
        """Enabled registry rows keyed by workspace_id (read once; caller holds lock)."""
        if self._peers is not None:
            return self._peers
        peers: dict[str, dict] = {}
        if self._spark is not None and self._registry_table:
            try:
                rows = self._spark.sql(
                    f"SELECT * FROM {self._registry_table} ORDER BY registered_at DESC"
                ).collect()
                for r in rows:
                    row = r.asDict()
                    wid = str(row.get("workspace_id") or "").strip()
                    enabled = str(row.get("enabled", "true")).strip().lower() == "true"
                    # Newest registration wins (same as the app's get_peer).
                    if wid and wid not in peers and enabled:
                        peers[wid] = row
            except Exception as e:  # noqa: BLE001
                logger.info("federated_workspaces registry not readable: %s", e)
        self._peers = peers
        return peers

    def _credentials(self, peer: dict) -> tuple[str, str]:
        auth_kind = (peer.get("auth_kind") or "app_sp").lower()
        wid = peer.get("workspace_id")
        if auth_kind == "app_sp":
            client_id = os.environ.get("DATABRICKS_CLIENT_ID", "")
            client_secret = os.environ.get("DATABRICKS_CLIENT_SECRET", "")
            if not client_id or not client_secret:
                raise PeerUnavailable(
                    "peer_auth_unsupported",
                    f"workspace {wid} uses auth_kind=app_sp, whose credentials only exist "
                    "in the Apps runtime; register it with a secret-scope credential",
                )
            return client_id, client_secret
        try:
            return (
                self._read_secret(peer["secret_scope"], peer["client_id_key"]),
                self._read_secret(peer["secret_scope"], peer["client_secret_key"]),
            )
        except PeerUnavailable:
            raise
        except Exception as e:  # noqa: BLE001
            raise PeerUnavailable(
                "peer_credentials_unreadable", f"workspace {wid}: {e}"
            ) from e

    def _read_secret(self, scope: str, key: str) -> str:
        resp = self._local.secrets.get_secret(scope=scope, key=key)
        if resp.value is None:
            raise PeerUnavailable("peer_credentials_unreadable", f"secret {scope}/{key} is empty")
        return base64.b64decode(resp.value).decode("utf-8")
