"""Pure builders for spec-compliant OpenLineage 2.0.2 events and facets.

Kept dependency-free and side-effect-free so it is unit-testable without a
warehouse or SDK. The route layer (`routes/openlineage.py`) pulls data from UC
and the lineage graph; this module only shapes it into canonical OpenLineage
JSON and validates it.

Why this exists: the previous inline exporter emitted non-canonical namespaces
(`databricks://catalog.schema`), faked every column type as STRING, and carried
no column-level lineage — so downstream catalogs (Marquez, DataHub, Atlan,
OpenMetadata) either rejected or duplicated the datasets. These builders emit
the OpenLineage naming convention (`databricks://<workspace-host>` namespace +
fully-qualified `catalog.schema.table` name), real SchemaDatasetFacets, and the
ColumnLineageDatasetFacet that field-level consumers key on.

Spec: https://openlineage.io/spec/2-0-2/OpenLineage.json
Naming: https://openlineage.io/docs/spec/naming
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Iterable, Optional

PRODUCER = "https://github.com/databricks/lineage-explorer"
SPEC_VERSION = "2-0-2"
SCHEMA_URL = f"https://openlineage.io/spec/{SPEC_VERSION}/OpenLineage.json"
# Custom-facet docs anchor — OpenLineage facets are extensible, so app-specific
# facets are spec-legal as long as they carry _producer + _schemaURL.
CUSTOM_FACET_DOC = "https://github.com/databricks/lineage-explorer/facets"

VALID_EVENT_TYPES = ("START", "RUNNING", "COMPLETE", "ABORT", "FAIL", "OTHER")

# UUIDv5 namespace for deriving stable run ids from (job, event_time). Fixed so
# the same logical run maps to the same runId across exports (idempotent ingest).
_RUN_NS = uuid.uuid5(uuid.NAMESPACE_URL, "databricks-lineage-explorer/openlineage/run")

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _facet_url(defn: str) -> str:
    return f"{SCHEMA_URL}#/$defs/{defn}"


def _base_facet(defn: str) -> dict:
    return {"_producer": PRODUCER, "_schemaURL": _facet_url(defn)}


def dataset_namespace(host: Optional[str]) -> str:
    """OpenLineage Databricks dataset namespace: ``databricks://<workspace-host>``.

    Consumers dedupe datasets by (namespace, name); a stable, host-scoped
    namespace is what lets the same table reconcile across events. Falls back to
    a fixed sentinel when the host is unknown so the value is never empty.
    """
    h = (host or "").replace("https://", "").replace("http://", "").rstrip("/")
    return f"databricks://{h}" if h else "databricks://unity-catalog"


def deterministic_run_id(job_name: str, event_time: str) -> str:
    """Stable UUIDv5 run id from job identity + event time (idempotent re-export)."""
    return str(uuid.uuid5(_RUN_NS, f"{job_name}:{event_time}"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------- #
# Dataset facets
# --------------------------------------------------------------------------- #
def schema_facet(columns: Iterable[dict]) -> Optional[dict]:
    """SchemaDatasetFacet from UC column dicts ({name, type, nullable})."""
    fields = []
    for c in columns or []:
        name = c.get("name")
        if not name:
            continue
        field = {"name": name, "type": str(c.get("type", "")) or "unknown"}
        # OpenLineage SchemaDatasetFacet fields carry an optional description;
        # nullability isn't a first-class field, so fold it into the description
        # rather than inventing a non-spec key.
        if c.get("nullable") is False:
            field["description"] = "NOT NULL"
        fields.append(field)
    if not fields:
        return None
    return {**_base_facet("SchemaDatasetFacet"), "fields": fields}


def documentation_facet(description: Optional[str]) -> Optional[dict]:
    if not description:
        return None
    return {**_base_facet("DocumentationDatasetFacet"), "description": description}


def ownership_facet(owner: Optional[str]) -> Optional[dict]:
    if not owner:
        return None
    return {**_base_facet("OwnershipDatasetFacet"), "owners": [{"name": owner}]}


def symlinks_facet(namespace: str, fqn: str) -> dict:
    """SymlinksDatasetFacet carrying the fully-qualified UC name as a TABLE symlink."""
    return {
        **_base_facet("SymlinksDatasetFacet"),
        "identifiers": [{"namespace": namespace, "name": fqn, "type": "TABLE"}],
    }


def datasource_facet(namespace: str, fqn: str) -> dict:
    return {**_base_facet("DatasourceDatasetFacet"), "name": namespace, "uri": f"{namespace}/{fqn}"}


def column_lineage_facet(fields_map: dict[str, list[dict]]) -> Optional[dict]:
    """ColumnLineageDatasetFacet.

    ``fields_map`` maps an output column name to a list of input-field dicts,
    each ``{"namespace", "name", "field"}``. Empty input lists are dropped.
    """
    fields = {}
    for out_col, inputs in (fields_map or {}).items():
        clean = [i for i in inputs if i.get("namespace") and i.get("name") and i.get("field")]
        if not clean:
            continue
        fields[out_col] = {
            "inputFields": clean,
            # We know the edge exists but not (here) the expression kind; INDIRECT
            # is the honest, spec-valid default when a transform type is unknown.
            "transformationType": "INDIRECT",
            "transformationDescription": "Derived via Unity Catalog column lineage",
        }
    if not fields:
        return None
    return {**_base_facet("ColumnLineageDatasetFacet"), "fields": fields}


def data_quality_rules_facet(rules: list[dict]) -> Optional[dict]:
    """Custom (spec-legal, extensible) facet listing app-managed DQ rules.

    We use a custom facet rather than the standard ``dataQualityAssertions``
    because that facet requires a boolean ``success`` per assertion — which we
    don't have without executing the rule. Listing the *defined* rules honestly,
    under our own namespaced facet, keeps the event conformant.
    """
    clean = [r for r in (rules or []) if r.get("rule_type")]
    if not clean:
        return None
    return {
        "_producer": PRODUCER,
        "_schemaURL": f"{CUSTOM_FACET_DOC}/DataQualityRulesDatasetFacet.json",
        "rules": [
            {
                "column": r.get("column_name") or None,
                "ruleType": r.get("rule_type"),
                "severity": r.get("severity") or "ERROR",
                "expression": r.get("expression") or None,
            }
            for r in clean
        ],
    }


def build_dataset(
    namespace: str,
    catalog: str,
    schema: str,
    table: str,
    *,
    columns: Optional[Iterable[dict]] = None,
    comment: Optional[str] = None,
    owner: Optional[str] = None,
    column_lineage: Optional[dict[str, list[dict]]] = None,
    dq_rules: Optional[list[dict]] = None,
) -> dict:
    """Build an OpenLineage Dataset with whichever facets have data."""
    fqn = f"{catalog}.{schema}.{table}"
    facets: dict = {
        "dataSource": datasource_facet(namespace, fqn),
        "symlinks": symlinks_facet(namespace, fqn),
    }
    for key, facet in (
        ("schema", schema_facet(columns or [])),
        ("documentation", documentation_facet(comment)),
        ("ownership", ownership_facet(owner)),
        ("columnLineage", column_lineage_facet(column_lineage or {})),
        ("dataQualityRules", data_quality_rules_facet(dq_rules or [])),
    ):
        if facet:
            facets[key] = facet
    return {"namespace": namespace, "name": fqn, "facets": facets}


# --------------------------------------------------------------------------- #
# Job / run facets + event
# --------------------------------------------------------------------------- #
def job_type_facet(entity_type: str) -> dict:
    return {
        **_base_facet("JobTypeJobFacet"),
        "processingType": "BATCH",
        "integration": "DATABRICKS",
        "jobType": (entity_type or "JOB").upper(),
    }


def sql_job_facet(query: Optional[str]) -> Optional[dict]:
    if not query:
        return None
    return {**_base_facet("SQLJobFacet"), "query": query}


def source_code_facet(source: Optional[str], language: str = "python") -> Optional[dict]:
    if not source:
        return None
    return {**_base_facet("SourceCodeJobFacet"), "language": language, "sourceCode": source}


def documentation_job_facet(description: Optional[str]) -> Optional[dict]:
    if not description:
        return None
    return {**_base_facet("DocumentationJobFacet"), "description": description}


def nominal_time_run_facet(start: Optional[str], end: Optional[str] = None) -> Optional[dict]:
    if not start:
        return None
    facet = {**_base_facet("NominalTimeRunFacet"), "nominalStartTime": start}
    if end:
        facet["nominalEndTime"] = end
    return facet


def error_message_run_facet(message: Optional[str]) -> Optional[dict]:
    if not message:
        return None
    return {**_base_facet("ErrorMessageRunFacet"), "message": message, "programmingLanguage": "SQL"}


def build_run_event(
    *,
    event_type: str,
    job_namespace: str,
    job_name: str,
    event_time: Optional[str] = None,
    run_id: Optional[str] = None,
    job_facets: Optional[dict] = None,
    run_facets: Optional[dict] = None,
    inputs: Optional[list[dict]] = None,
    outputs: Optional[list[dict]] = None,
) -> dict:
    """Build one canonical OpenLineage RunEvent."""
    et = (event_type or "COMPLETE").upper()
    when = event_time or now_iso()
    rid = run_id or deterministic_run_id(job_name, when)
    return {
        "eventType": et,
        "eventTime": when,
        "producer": PRODUCER,
        "schemaURL": SCHEMA_URL,
        "run": {"runId": rid, "facets": {k: v for k, v in (run_facets or {}).items() if v}},
        "job": {
            "namespace": job_namespace,
            "name": job_name,
            "facets": {k: v for k, v in (job_facets or {}).items() if v},
        },
        "inputs": inputs or [],
        "outputs": outputs or [],
    }


# --------------------------------------------------------------------------- #
# Conformance validation
# --------------------------------------------------------------------------- #
def validate_event(event: dict) -> list[str]:
    """Structural conformance check against the OpenLineage RunEvent shape.

    Returns a list of human-readable issues (empty = conformant). This is a
    fast structural validator (required fields, enums, id shape, dataset
    identity) rather than a full JSON-Schema pass — enough to trust an export
    or catch a bad import without bundling the 2.0.2 schema + a validator lib.
    """
    issues: list[str] = []
    if not isinstance(event, dict):
        return ["event is not an object"]

    et = event.get("eventType")
    if et not in VALID_EVENT_TYPES:
        issues.append(f"eventType must be one of {', '.join(VALID_EVENT_TYPES)} (got {et!r})")
    if not event.get("eventTime"):
        issues.append("eventTime is required")
    if not event.get("producer"):
        issues.append("producer is required")
    if not event.get("schemaURL"):
        issues.append("schemaURL is required")

    run = event.get("run")
    if not isinstance(run, dict) or not run.get("runId"):
        issues.append("run.runId is required")
    elif not _UUID_RE.match(str(run.get("runId"))):
        issues.append(f"run.runId must be a UUID (got {run.get('runId')!r})")

    job = event.get("job")
    if not isinstance(job, dict):
        issues.append("job is required")
    else:
        if not job.get("namespace"):
            issues.append("job.namespace is required")
        if not job.get("name"):
            issues.append("job.name is required")

    for side in ("inputs", "outputs"):
        items = event.get(side, [])
        if not isinstance(items, list):
            issues.append(f"{side} must be a list")
            continue
        for i, ds in enumerate(items):
            if not isinstance(ds, dict) or not ds.get("namespace") or not ds.get("name"):
                issues.append(f"{side}[{i}] must have namespace + name")
    return issues


def validate_events(events: list[dict]) -> dict:
    """Validate a batch; returns {valid, event_count, invalid_count, issues[]}."""
    all_issues: list[dict] = []
    for i, ev in enumerate(events or []):
        for msg in validate_event(ev):
            all_issues.append({"event_index": i, "issue": msg})
    return {
        "valid": len(all_issues) == 0,
        "event_count": len(events or []),
        "invalid_count": len({x["event_index"] for x in all_issues}),
        "issues": all_issues[:50],  # cap so a pathological import can't flood the UI
    }
