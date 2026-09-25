"""Tests for backend/federated_workspaces.py (Phase 2 — cross-workspace source
fetch). Everything is mocked; no live workspace or secret scope."""
import base64
from unittest.mock import patch, MagicMock

import pytest
from databricks.sdk.service.sql import StatementState

import backend.federated_workspaces as fw


class TestGetWorkspaceClient:
    def setup_method(self):
        fw._peer_clients.clear()

    def test_none_returns_app_client(self):
        app = MagicMock()
        with patch.object(fw, "_get_client", return_value=app):
            assert fw.get_workspace_client(None) is app

    def test_local_workspace_returns_app_client(self):
        app = MagicMock()
        with patch.object(fw, "_get_client", return_value=app), \
             patch.object(fw, "_app_workspace_id", return_value="111"):
            assert fw.get_workspace_client("111") is app

    def test_flag_off_raises_disabled(self):
        with patch.object(fw, "_app_workspace_id", return_value="111"), \
             patch.object(fw, "get_flag_state", return_value=False):
            with pytest.raises(fw.CrossWorkspaceDisabled):
                fw.get_workspace_client("222")

    def test_no_peer_raises_not_registered(self):
        with patch.object(fw, "_app_workspace_id", return_value="111"), \
             patch.object(fw, "get_flag_state", return_value=True), \
             patch.object(fw, "get_peer", return_value=None):
            with pytest.raises(fw.PeerNotRegistered):
                fw.get_workspace_client("222")

    def test_builds_and_caches_peer_client(self):
        peer = {"workspace_id": "222", "deployment_host": "https://peer.cloud.databricks.com",
                "auth_kind": "account_sp", "secret_scope": "sc", "client_id_key": "cid_key",
                "client_secret_key": "csec_key", "enabled": True}
        built = MagicMock()
        with patch.object(fw, "_app_workspace_id", return_value="111"), \
             patch.object(fw, "get_flag_state", return_value=True), \
             patch.object(fw, "get_peer", return_value=peer), \
             patch.object(fw, "_read_secret", side_effect=["CID", "CSEC"]), \
             patch.object(fw, "assert_databricks_workspace_url", side_effect=lambda u, *a: u), \
             patch.object(fw, "SdkConfig", return_value=MagicMock()), \
             patch.object(fw, "WorkspaceClient", return_value=built) as WC:
            c1 = fw.get_workspace_client("222")
            c2 = fw.get_workspace_client("222")  # served from cache
        assert c1 is built and c2 is built
        WC.assert_called_once()  # only built once, then cached

    def test_app_sp_uses_env_credentials(self):
        # The app's own SP is the account SP (a member of the peer) — reuse the
        # ambient OAuth creds instead of a secret scope.
        peer = {"workspace_id": "222", "deployment_host": "https://peer.cloud.databricks.com",
                "auth_kind": "app_sp", "enabled": True}
        built = MagicMock()
        with patch.object(fw, "_app_workspace_id", return_value="111"), \
             patch.object(fw, "get_flag_state", return_value=True), \
             patch.object(fw, "get_peer", return_value=peer), \
             patch.object(fw, "assert_databricks_workspace_url", side_effect=lambda u, *a: u), \
             patch.object(fw, "SdkConfig", return_value=MagicMock()) as SC, \
             patch.object(fw, "WorkspaceClient", return_value=built), \
             patch.dict("os.environ", {"DATABRICKS_CLIENT_ID": "app-cid",
                                        "DATABRICKS_CLIENT_SECRET": "app-csec"}):
            client = fw.get_workspace_client("222")
        assert client is built
        # built from the app's ambient creds against the peer host
        kw = SC.call_args.kwargs
        assert kw["client_id"] == "app-cid" and kw["client_secret"] == "app-csec"
        assert kw["host"] == "https://peer.cloud.databricks.com"

    def test_app_sp_missing_env_creds_raises(self):
        peer = {"workspace_id": "222", "deployment_host": "https://peer.cloud.databricks.com",
                "auth_kind": "app_sp", "enabled": True}
        with patch.object(fw, "_app_workspace_id", return_value="111"), \
             patch.object(fw, "get_flag_state", return_value=True), \
             patch.object(fw, "get_peer", return_value=peer), \
             patch.object(fw, "assert_databricks_workspace_url", side_effect=lambda u, *a: u), \
             patch.dict("os.environ", {"DATABRICKS_CLIENT_ID": "", "DATABRICKS_CLIENT_SECRET": ""}):
            with pytest.raises(RuntimeError):
                fw.get_workspace_client("222")

    def test_ssrf_guard_rejects_bad_host(self):
        peer = {"workspace_id": "222", "deployment_host": "http://169.254.169.254",
                "secret_scope": "sc", "client_id_key": "a", "client_secret_key": "b", "enabled": True}
        with patch.object(fw, "_app_workspace_id", return_value="111"), \
             patch.object(fw, "get_flag_state", return_value=True), \
             patch.object(fw, "get_peer", return_value=peer), \
             patch.object(fw, "assert_databricks_workspace_url",
                          side_effect=fw.UnsafeOutboundURL("blocked")):
            with pytest.raises(fw.UnsafeOutboundURL):
                fw.get_workspace_client("222")


class TestTargetTableEntitlement:
    """The precheck verifies the REQUESTING user can access the TARGET table via
    information_schema, run as the user (get_read_client). No CAN_MANAGE, no
    cross-workspace ACL read. Fails closed — including when identity isn't enforced."""

    def test_user_with_access_ok(self):
        import backend.lineage_service as ls
        with patch.object(ls, "ENFORCE_USER_IDENTITY", True), \
             patch.object(ls, "get_read_client", return_value=MagicMock()), \
             patch.object(ls, "_execute_sql", return_value=[{"1": 1}]):
            assert fw.user_can_access_target_table("cat.sch.tbl") is True

    def test_user_without_access_denied(self):
        import backend.lineage_service as ls
        with patch.object(ls, "ENFORCE_USER_IDENTITY", True), \
             patch.object(ls, "get_read_client", return_value=MagicMock()), \
             patch.object(ls, "_execute_sql", return_value=[]):  # UC hides the row
            assert fw.user_can_access_target_table("cat.sch.tbl") is False

    def test_denied_when_identity_not_enforced(self):
        # With ENFORCE_USER_IDENTITY off, the check would run as the app SP (broad)
        # and pass for everyone — so it must fail CLOSED instead.
        import backend.lineage_service as ls
        with patch.object(ls, "ENFORCE_USER_IDENTITY", False), \
             patch.object(ls, "get_read_client") as grc:
            assert fw.user_can_access_target_table("cat.sch.tbl") is False
            grc.assert_not_called()

    def test_malformed_name_denied(self):
        assert fw.user_can_access_target_table("cat.sch") is False
        assert fw.user_can_access_target_table("") is False

    def test_error_fails_closed(self):
        import backend.lineage_service as ls
        with patch.object(ls, "ENFORCE_USER_IDENTITY", True), \
             patch.object(ls, "get_read_client", return_value=MagicMock()), \
             patch.object(ls, "_execute_sql", side_effect=RuntimeError("no identity")):
            assert fw.user_can_access_target_table("cat.sch.tbl") is False


class TestExecuteSql:
    def test_no_warehouse_raises(self):
        with patch.object(fw, "WAREHOUSE_ID", ""):
            with pytest.raises(RuntimeError):
                fw._execute_sql("SELECT 1")

    def test_maps_rows_by_column_name(self):
        client = MagicMock()
        resp = MagicMock()
        resp.status.state = StatementState.SUCCEEDED
        c1 = MagicMock(); c1.name = "workspace_id"
        c2 = MagicMock(); c2.name = "deployment_host"
        resp.manifest.schema.columns = [c1, c2]
        resp.result.data_array = [["222", "https://p.azuredatabricks.net"]]
        client.statement_execution.execute_statement.return_value = resp
        with patch.object(fw, "WAREHOUSE_ID", "wh"), patch.object(fw, "_get_client", return_value=client):
            rows = fw._execute_sql("SELECT ...")
        assert rows == [{"workspace_id": "222", "deployment_host": "https://p.azuredatabricks.net"}]

    def test_failed_statement_raises(self):
        client = MagicMock()
        resp = MagicMock()
        resp.status.state = StatementState.FAILED
        resp.status.error.message = "boom"
        client.statement_execution.execute_statement.return_value = resp
        with patch.object(fw, "WAREHOUSE_ID", "wh"), patch.object(fw, "_get_client", return_value=client):
            with pytest.raises(RuntimeError):
                fw._execute_sql("SELECT 1")


class TestRegistry:
    def setup_method(self):
        fw._peers_cache = None  # the read is TTL-cached; isolate each test

    def test_list_peers_empty_when_flag_off(self):
        with patch.object(fw, "get_flag_state", return_value=False):
            assert fw.list_peer_workspaces() == []

    def test_list_peers_returns_rows(self):
        rows = [{"workspace_id": "222", "display_name": "peer", "enabled": True}]
        with patch.object(fw, "get_flag_state", return_value=True), \
             patch.object(fw, "_ensure_table"), \
             patch.object(fw, "_execute_sql", return_value=rows):
            assert fw.list_peer_workspaces() == rows

    def test_list_peers_fails_open_on_error(self):
        with patch.object(fw, "get_flag_state", return_value=True), \
             patch.object(fw, "_ensure_table"), \
             patch.object(fw, "_execute_sql", side_effect=RuntimeError("no warehouse")):
            assert fw.list_peer_workspaces() == []

    def test_get_peer_finds_enabled(self):
        rows = [{"workspace_id": "222", "enabled": True}, {"workspace_id": "333", "enabled": True}]
        with patch.object(fw, "list_peer_workspaces", return_value=rows):
            assert fw.get_peer("333")["workspace_id"] == "333"

    def test_get_peer_none_when_disabled_or_missing(self):
        with patch.object(fw, "list_peer_workspaces",
                          return_value=[{"workspace_id": "222", "enabled": False}]):
            assert fw.get_peer("222") is None   # disabled
            assert fw.get_peer("999") is None   # not present
        assert fw.get_peer("") is None          # blank id

    def test_get_peer_parses_string_enabled(self):
        # The Statement Execution API returns the BOOLEAN column as a STRING;
        # bool("false") is True, so a string "false" must NOT resolve.
        with patch.object(fw, "list_peer_workspaces",
                          return_value=[{"workspace_id": "222", "enabled": "false"}]):
            assert fw.get_peer("222") is None
        with patch.object(fw, "list_peer_workspaces",
                          return_value=[{"workspace_id": "222", "enabled": "true"}]):
            assert fw.get_peer("222")["workspace_id"] == "222"

    def test_register_peer_validates_and_inserts(self):
        with patch.object(fw, "assert_databricks_workspace_url", side_effect=lambda u, *a: u), \
             patch.object(fw, "_ensure_table"), \
             patch.object(fw, "_execute_sql", return_value=[]) as ex:
            r = fw.register_peer_workspace("222", "https://p.azuredatabricks.net", "me@x.com",
                                           display_name="Silver WS")
        assert r["workspace_id"] == "222" and r["auth_kind"] == "app_sp" and r["enabled"] is True
        sql = ex.call_args.args[0]
        assert "INSERT INTO" in sql and "222" in sql and "Silver WS" in sql

    def test_register_evicts_stale_cached_client(self):
        # A re-registration (new host/creds or a disable) must drop any cached
        # peer client, or get_workspace_client would keep returning the stale one.
        fw._peer_clients["222"] = MagicMock()
        with patch.object(fw, "assert_databricks_workspace_url", side_effect=lambda u, *a: u), \
             patch.object(fw, "_ensure_table"), \
             patch.object(fw, "_execute_sql", return_value=[]):
            fw.register_peer_workspace("222", "https://new-host.azuredatabricks.net", "me@x.com")
        assert "222" not in fw._peer_clients


class TestReadSecret:
    def test_decodes_base64_value(self):
        client = MagicMock()
        client.secrets.get_secret.return_value = MagicMock(value=base64.b64encode(b"S3CRET").decode())
        with patch.object(fw, "_get_client", return_value=client):
            assert fw._read_secret("scope", "key") == "S3CRET"

    def test_missing_value_raises(self):
        client = MagicMock()
        client.secrets.get_secret.return_value = MagicMock(value=None)
        with patch.object(fw, "_get_client", return_value=client):
            with pytest.raises(RuntimeError):
                fw._read_secret("scope", "key")


class TestEvictPeerClient:
    def test_evict_removes_cached_client(self):
        fw._peer_clients["222"] = MagicMock()
        fw.evict_peer_client("222")
        assert "222" not in fw._peer_clients

    def test_evict_missing_is_noop(self):
        fw._peer_clients.clear()
        fw.evict_peer_client("nope")  # must not raise


class TestExecuteSqlAndEnsureTableEdges:
    def test_empty_result_returns_empty_list(self):
        client = MagicMock()
        resp = MagicMock()
        resp.status.state = StatementState.SUCCEEDED
        resp.result = None  # SUCCEEDED but no rows
        client.statement_execution.execute_statement.return_value = resp
        with patch.object(fw, "WAREHOUSE_ID", "wh"), patch.object(fw, "_get_client", return_value=client):
            assert fw._execute_sql("SELECT 1") == []

    def test_ensure_table_issues_create(self):
        with patch.object(fw, "_execute_sql", return_value=[]) as ex:
            fw._ensure_table()
        sql = ex.call_args.args[0]
        assert "CREATE TABLE IF NOT EXISTS" in sql and "federated_workspaces" in sql
