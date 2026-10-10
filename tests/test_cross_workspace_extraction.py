"""Tests for cross-workspace deterministic extraction: the per-workspace client
provider (transformation_lineage/extraction/workspace_clients.py) and the
extraction phase routing each producer through its own workspace's client.
Everything is mocked; no live workspace, registry table or secret scope."""
import base64
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# Importing transformation_lineage pulls in pyspark (the package __init__ imports
# the pipeline), which isn't in requirements-dev.txt.
pytest.importorskip("pyspark")

from transformation_lineage.extraction import workspace_clients as wc  # noqa: E402


def _row(**kw):
    return SimpleNamespace(asDict=lambda: kw)


def _spark_with_registry(rows):
    spark = MagicMock()
    spark.sql.return_value.collect.return_value = rows
    return spark


PEER = dict(
    workspace_id="222", deployment_host="https://peer.cloud.databricks.com",
    auth_kind="account_sp", secret_scope="lineage", client_id_key="cid",
    client_secret_key="csec", enabled=True,
)


def _local_client_with_secrets():
    local = MagicMock()
    local.secrets.get_secret.side_effect = lambda scope, key: SimpleNamespace(
        value=base64.b64encode(f"{key}-value".encode()).decode()
    )
    return local


class TestWorkspaceClientProvider:
    def test_local_and_missing_workspace_use_local_client(self):
        local = MagicMock()
        p = wc.WorkspaceClientProvider(local, "111")
        assert p.get(None) is local
        assert p.get("111") is local
        assert p.is_local("") and not p.is_local("222")

    def test_unknown_local_id_treats_everything_as_local(self):
        local = MagicMock()
        p = wc.WorkspaceClientProvider(local, None)
        assert p.get("222") is local

    def test_disabled_skips_peer(self):
        p = wc.WorkspaceClientProvider(MagicMock(), "111", enabled=False)
        with pytest.raises(wc.PeerUnavailable) as e:
            p.get("222")
        assert e.value.reason == "cross_workspace_disabled"

    def test_unregistered_peer(self):
        p = wc.WorkspaceClientProvider(
            MagicMock(), "111", spark=_spark_with_registry([]),
            registry_table="c.s.federated_workspaces", enabled=True,
        )
        with pytest.raises(wc.PeerUnavailable) as e:
            p.get("222")
        assert e.value.reason == "peer_workspace_unregistered"

    def test_disabled_registry_row_does_not_resolve(self):
        p = wc.WorkspaceClientProvider(
            MagicMock(), "111", spark=_spark_with_registry([_row(**{**PEER, "enabled": False})]),
            registry_table="c.s.federated_workspaces", enabled=True,
        )
        with pytest.raises(wc.PeerUnavailable) as e:
            p.get("222")
        assert e.value.reason == "peer_workspace_unregistered"

    def test_registered_peer_builds_oauth_client_from_secret_scope(self):
        local = _local_client_with_secrets()
        p = wc.WorkspaceClientProvider(
            local, "111", spark=_spark_with_registry([_row(**PEER)]),
            registry_table="c.s.federated_workspaces", enabled=True,
        )
        with patch.object(wc, "WorkspaceClient") as WC, patch.object(wc, "SdkConfig") as Cfg:
            c1 = p.get("222")
            c2 = p.get("222")
        assert c1 is c2 is WC.return_value
        WC.assert_called_once()
        Cfg.assert_called_once_with(
            host="https://peer.cloud.databricks.com", client_id="cid-value",
            client_secret="csec-value", auth_type="oauth-m2m",
        )

    def test_non_databricks_host_rejected(self):
        bad = {**PEER, "deployment_host": "https://evil.example.com"}
        p = wc.WorkspaceClientProvider(
            _local_client_with_secrets(), "111", spark=_spark_with_registry([_row(**bad)]),
            registry_table="c.s.federated_workspaces", enabled=True,
        )
        with pytest.raises(wc.PeerUnavailable) as e:
            p.get("222")
        assert e.value.reason == "peer_host_invalid"

    def test_app_sp_peer_without_ambient_credentials_is_unsupported(self, monkeypatch):
        monkeypatch.delenv("DATABRICKS_CLIENT_ID", raising=False)
        monkeypatch.delenv("DATABRICKS_CLIENT_SECRET", raising=False)
        p = wc.WorkspaceClientProvider(
            MagicMock(), "111",
            spark=_spark_with_registry([_row(**{**PEER, "auth_kind": "app_sp"})]),
            registry_table="c.s.federated_workspaces", enabled=True,
        )
        with pytest.raises(wc.PeerUnavailable) as e:
            p.get("222")
        assert e.value.reason == "peer_auth_unsupported"

    def test_resolve_local_workspace_id(self):
        client = MagicMock()
        client.get_workspace_id.return_value = 111
        assert wc.resolve_local_workspace_id(client) == "111"
        client.get_workspace_id.side_effect = RuntimeError("no")
        assert wc.resolve_local_workspace_id(client) is None


class TestExtractionRouting:
    """run_extraction_phase picks the client for each producer's workspace."""

    def _run(self, run_ids, notebooks, provider, nb_paths=None):
        from transformation_lineage.config import LineageJobConfig
        from transformation_lineage.extraction import pipeline as xp

        cfg = LineageJobConfig(
            target_catalog="c", target_schema="s", kpi_tables=("c.s.t",),
            databricks_host="https://h.cloud.databricks.com", databricks_token="t",
        )
        disc = MagicMock()
        disc.select.return_value.distinct.return_value.count.return_value = len(run_ids)
        disc.select.return_value.distinct.return_value.collect.return_value = []
        seen = {}

        def fake_run(client, rid, cfg_, id_scope=""):
            seen[rid] = (client, id_scope)
            return []

        def fake_fetch(client, path):
            seen[path] = client
            return "# Databricks notebook source\nx = 1\n"

        with patch.object(xp, "discover_lineage_runs", return_value=disc), \
             patch.object(xp, "distinct_run_ids", return_value=run_ids), \
             patch.object(xp, "distinct_notebook_entities", return_value=notebooks), \
             patch.object(xp, "distinct_pipeline_entities", return_value=[]), \
             patch.object(xp, "_extract_object_definitions", return_value=[]), \
             patch.object(xp, "_extract_from_query_history", return_value=[]), \
             patch.object(xp, "_resolve_notebook_paths_batch", return_value=nb_paths or {}), \
             patch.object(xp, "_process_single_run", side_effect=fake_run), \
             patch.object(xp, "fetch_workspace_source", side_effect=fake_fetch):
            artifacts, report = xp.run_extraction_phase(
                MagicMock(), cfg, workspace_client_factory=MagicMock,
                client_provider=provider,
            )
        return artifacts, report, seen

    def test_job_runs_use_their_workspace_client(self):
        local, peer = MagicMock(name="local"), MagicMock(name="peer")
        provider = wc.WorkspaceClientProvider(local, "111", enabled=True)
        provider._clients["222"] = peer
        _, _, seen = self._run([("111", 1), ("222", 2)], [], provider)
        assert seen[1] == (local, "")
        assert seen[2] == (peer, "ws:222:")

    def test_peer_without_client_is_skipped_not_read_locally(self):
        local = MagicMock(name="local")
        provider = wc.WorkspaceClientProvider(local, "111", enabled=False)
        nb_paths = {("222", "9"): "/Shared/etl/load"}
        artifacts, report, seen = self._run(
            [("222", 2)], [("222", "9")], provider, nb_paths=nb_paths,
        )
        assert 2 not in seen and "/Shared/etl/load" not in seen
        assert artifacts == []
        assert report.skip_reasons.get("cross_workspace_disabled") == 2

    def test_same_path_in_two_workspaces_yields_two_artifacts(self):
        local, peer = MagicMock(name="local"), MagicMock(name="peer")
        provider = wc.WorkspaceClientProvider(local, "111", enabled=True)
        provider._clients["222"] = peer
        nb_paths = {("111", "5"): "/Shared/etl/load", ("222", "5"): "/Shared/etl/load"}
        artifacts, _, _ = self._run(
            [], [("111", "5"), ("222", "5")], provider, nb_paths=nb_paths,
        )
        assert len({a.extraction_id for a in artifacts}) == 2
