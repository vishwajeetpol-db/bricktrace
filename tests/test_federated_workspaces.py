"""Tests for backend/federated_workspaces.py (Phase 2 — cross-workspace source
fetch). Everything is mocked; no live workspace or secret scope."""
from unittest.mock import patch, MagicMock

import pytest

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


class TestEntitlementPrecheck:
    def _acl(self, principal, level):
        return {"access_control_list": [
            {"user_name": principal, "all_permissions": [{"permission_level": level}]}
        ]}

    def test_user_with_view_ok(self):
        client = MagicMock()
        client.api_client.do.return_value = self._acl("u@x.com", "CAN_VIEW")
        with patch.object(fw, "get_workspace_client", return_value=client):
            assert fw.user_can_view_in_peer("222", "u@x.com", "PIPELINE", "p1") is True

    def test_user_without_access_denied(self):
        client = MagicMock()
        client.api_client.do.return_value = self._acl("other@x.com", "CAN_MANAGE")
        with patch.object(fw, "get_workspace_client", return_value=client):
            assert fw.user_can_view_in_peer("222", "u@x.com", "PIPELINE", "p1") is False

    def test_unknown_entity_type_denied(self):
        # NOTEBOOK uses numeric object ids, not id-addressable here -> fail closed.
        assert fw.user_can_view_in_peer("222", "u@x.com", "NOTEBOOK", "/Users/x/nb") is False

    def test_error_fails_closed(self):
        client = MagicMock()
        client.api_client.do.side_effect = RuntimeError("403 permission denied")
        with patch.object(fw, "get_workspace_client", return_value=client):
            assert fw.user_can_view_in_peer("222", "u@x.com", "JOB", "1") is False

    def test_no_user_name_denied(self):
        assert fw.user_can_view_in_peer("222", "", "JOB", "1") is False
