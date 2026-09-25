"""Unit tests for backend/openlineage_builder.py — pure OL 2.0.2 shaping + validation."""
import uuid

from backend import openlineage_builder as olb


class TestNamespace:
    def test_strips_scheme_and_trailing_slash(self):
        assert olb.dataset_namespace("https://myws.cloud.databricks.com/") == "databricks://myws.cloud.databricks.com"

    def test_falls_back_when_host_missing(self):
        assert olb.dataset_namespace(None) == "databricks://unity-catalog"
        assert olb.dataset_namespace("") == "databricks://unity-catalog"


class TestRunId:
    def test_deterministic_and_uuid(self):
        a = olb.deterministic_run_id("job/1", "2026-01-01T00:00:00Z")
        b = olb.deterministic_run_id("job/1", "2026-01-01T00:00:00Z")
        assert a == b
        uuid.UUID(a)  # parses as a UUID

    def test_differs_by_time(self):
        a = olb.deterministic_run_id("job/1", "2026-01-01T00:00:00Z")
        b = olb.deterministic_run_id("job/1", "2026-01-02T00:00:00Z")
        assert a != b


class TestSchemaFacet:
    def test_maps_columns_with_types(self):
        f = olb.schema_facet([{"name": "id", "type": "bigint", "nullable": False},
                              {"name": "amt", "type": "decimal(10,2)", "nullable": True}])
        assert f["fields"][0] == {"name": "id", "type": "bigint", "description": "NOT NULL"}
        assert f["fields"][1] == {"name": "amt", "type": "decimal(10,2)"}
        assert f["_producer"] == olb.PRODUCER

    def test_none_when_empty(self):
        assert olb.schema_facet([]) is None
        assert olb.schema_facet([{"type": "int"}]) is None  # no name


class TestColumnLineageFacet:
    def test_builds_input_fields(self):
        f = olb.column_lineage_facet({"tc1": [{"namespace": "databricks://h", "name": "c.s.src", "field": "c1"}]})
        assert f["fields"]["tc1"]["inputFields"][0]["field"] == "c1"
        assert f["fields"]["tc1"]["transformationType"] == "INDIRECT"

    def test_drops_incomplete_inputs(self):
        assert olb.column_lineage_facet({"tc1": [{"namespace": "x", "name": ""}]}) is None
        assert olb.column_lineage_facet({}) is None


class TestDatasetAndDQ:
    def test_dataset_has_core_facets(self):
        ds = olb.build_dataset("databricks://h", "c", "s", "t",
                               columns=[{"name": "a", "type": "int"}], comment="hi", owner="me")
        assert ds["name"] == "c.s.t"
        assert ds["namespace"] == "databricks://h"
        assert set(ds["facets"]).issuperset({"dataSource", "symlinks", "schema", "documentation", "ownership"})
        assert ds["facets"]["symlinks"]["identifiers"][0]["name"] == "c.s.t"

    def test_dq_facet_custom(self):
        f = olb.data_quality_rules_facet([{"column_name": "amt", "rule_type": "NOT_NULL", "severity": "ERROR"}])
        assert f["rules"][0]["ruleType"] == "NOT_NULL"
        assert f["_producer"] == olb.PRODUCER
        assert olb.data_quality_rules_facet([]) is None


class TestRunEvent:
    def test_shape_and_defaults(self):
        ev = olb.build_run_event(event_type="complete", job_namespace="databricks", job_name="job/1",
                                 event_time="2026-01-01T00:00:00Z", inputs=[], outputs=[])
        assert ev["eventType"] == "COMPLETE"
        assert ev["producer"] == olb.PRODUCER
        assert ev["schemaURL"] == olb.SCHEMA_URL
        uuid.UUID(ev["run"]["runId"])  # deterministic UUID filled in

    def test_prunes_empty_facets(self):
        ev = olb.build_run_event(event_type="COMPLETE", job_namespace="databricks", job_name="j",
                                 job_facets={"jobType": None, "sql": {"query": "x"}})
        assert "jobType" not in ev["job"]["facets"]
        assert "sql" in ev["job"]["facets"]


class TestValidation:
    def _good(self):
        return olb.build_run_event(
            event_type="COMPLETE", job_namespace="databricks", job_name="job/1",
            event_time="2026-01-01T00:00:00Z",
            outputs=[{"namespace": "databricks://h", "name": "c.s.t"}])

    def test_valid_event_has_no_issues(self):
        assert olb.validate_event(self._good()) == []

    def test_flags_bad_event_type(self):
        ev = self._good(); ev["eventType"] = "DONE"
        assert any("eventType" in i for i in olb.validate_event(ev))

    def test_flags_non_uuid_run_id(self):
        ev = self._good(); ev["run"]["runId"] = "job-1"
        assert any("UUID" in i for i in olb.validate_event(ev))

    def test_flags_dataset_missing_name(self):
        ev = self._good(); ev["outputs"] = [{"namespace": "x"}]
        assert any("namespace + name" in i for i in olb.validate_event(ev))

    def test_batch_summary(self):
        good, bad = self._good(), self._good()
        bad["eventType"] = "NOPE"
        summary = olb.validate_events([good, bad])
        assert summary["valid"] is False
        assert summary["event_count"] == 2
        assert summary["invalid_count"] == 1
