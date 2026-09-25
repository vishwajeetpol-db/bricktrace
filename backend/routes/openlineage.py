"""Routes for Open Standards Export — capability 17.

Export lineage data in OpenLineage-compatible JSON format for interop
with Marquez, Atlan, DataHub, OpenMetadata, and other catalog systems.

Endpoints:
  GET  /api/export/openlineage                — export graph as OpenLineage events
  GET  /api/export/openlineage/schema         — export as OpenLineage dataset facets
  POST /api/import/openlineage                — ingest OpenLineage events into the graph
  POST /api/openlineage/producer/configure    — register an external OL-compatible endpoint
  GET  /api/openlineage/producer/config       — view producer configuration
  POST /api/openlineage/producer/produce      — detect recent writes and queue OL events
  GET  /api/openlineage/producer/events       — view queued/delivered producer events

OpenLineage spec: https://openlineage.io/spec/2-0-2/OpenLineage.json
"""
from __future__ import annotations

import os
import json
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from databricks.sdk.service.sql import StatementState
from backend.lineage_service import _get_client, get_table_lineage, get_schema_column_lineage
from backend.validators import _validate, redact_url, require_admin, sql_str
from backend import openlineage_builder as olb

logger = logging.getLogger(__name__)

router = APIRouter(tags=["openlineage"])

WAREHOUSE_ID = os.environ.get("DATABRICKS_WAREHOUSE_ID", "")
SQL_WAIT_TIMEOUT = os.environ.get("SQL_WAIT_TIMEOUT", "50s")
OPENLINEAGE_PRODUCER = "https://github.com/databricks/lineage-explorer"
OPENLINEAGE_SCHEMA_URL = "https://openlineage.io/spec/2-0-2/OpenLineage.json"

# The only statuses ever written to the producer queue: 'pending' by
# /producer/produce, 'delivered'/'failed' by the external delivery job.
# Allow-listed so status_filter can never carry SQL into the queue query.
PRODUCER_STATUSES = ("pending", "delivered", "failed")


def _execute_sql(sql: str) -> list[dict]:
    if not WAREHOUSE_ID:
        raise RuntimeError("No SQL warehouse available.")
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


def _table_to_openlineage_dataset(catalog: str, schema: str, table: str) -> dict:
    """Convert a UC table reference to an OpenLineage Dataset."""
    return {
        "namespace": f"databricks://{catalog}.{schema}",
        "name": table,
        "facets": {
            "dataSource": {
                "_producer": OPENLINEAGE_PRODUCER,
                "_schemaURL": OPENLINEAGE_SCHEMA_URL + "#/$defs/DataSourceDatasetFacet",
                "name": f"databricks://{catalog}",
                "uri": f"databricks://{catalog}.{schema}.{table}",
            }
        },
    }


def _build_openlineage_run_event(
    source_tables: list[dict], target_table: dict, entity_type: str, entity_id: str, event_time: str
) -> dict:
    """Build a single OpenLineage RunEvent."""
    return {
        "eventType": "COMPLETE",
        "eventTime": event_time,
        "producer": OPENLINEAGE_PRODUCER,
        "schemaURL": OPENLINEAGE_SCHEMA_URL,
        "run": {
            "runId": f"{entity_type}-{entity_id}",
            "facets": {},
        },
        "job": {
            "namespace": "databricks",
            "name": f"{entity_type}/{entity_id}",
            "facets": {
                "jobType": {
                    "_producer": OPENLINEAGE_PRODUCER,
                    "_schemaURL": OPENLINEAGE_SCHEMA_URL + "#/$defs/JobTypeJobFacet",
                    "processingType": "BATCH",
                    "integration": "DATABRICKS",
                    "jobType": entity_type.upper(),
                }
            },
        },
        "inputs": source_tables,
        "outputs": [target_table],
    }


def _app_host() -> Optional[str]:
    """Workspace host for the OpenLineage dataset namespace (fail-open)."""
    try:
        return _get_client().config.host
    except Exception:
        return None


def _dq_rules_for_scope(catalog: str, schema: Optional[str]) -> dict[str, list[dict]]:
    """Map table_fqn -> [rule dicts] for tables in scope. Fail-open (empty)."""
    fqn_prefix = f"{catalog}.{schema}." if schema else f"{catalog}."
    dq_table = f"{LINEAGE_CATALOG}.{LINEAGE_SCHEMA_NAME}.dq_rules"
    out: dict[str, list[dict]] = {}
    try:
        rows = _execute_sql(
            f"SELECT table_fqn, column_name, rule_type, expression, severity "
            f"FROM {dq_table} WHERE table_fqn LIKE '{sql_str(fqn_prefix)}%'"
        )
        for r in rows:
            out.setdefault(r.get("table_fqn", ""), []).append(r)
    except Exception as e:
        logger.debug(f"openlineage export: DQ rules unavailable: {e}")
    return out


@router.get("/api/export/openlineage")
async def export_openlineage(
    request: Request,
    catalog: str = Query(...),
    schema: Optional[str] = Query(None),
    # Facet toggles — let the caller choose payload richness. Defaults emit the
    # canonical, high-value facets; DQ + SQL are opt-in (extra queries / size).
    include_schema: bool = Query(True),
    include_column_lineage: bool = Query(True),
    include_ownership: bool = Query(True),
    include_docs: bool = Query(True),
    include_data_quality: bool = Query(False),
    event_type: str = Query("COMPLETE"),
    format: str = Query("json"),  # json | ndjson
    # Back-compat: the old param name still turns column facets on.
    include_columns: bool = Query(False),
):
    """Export the lineage graph as canonical OpenLineage 2.0.2 RunEvents.

    One RunEvent per (producing entity → output table): the entity's input
    tables become OpenLineage inputs, the output table becomes the output, and
    each output dataset is enriched with SchemaDatasetFacet, ColumnLineageDataset-
    Facet, documentation/ownership/symlinks and (opt-in) an app DQ-rules facet.

    `format=ndjson` streams one event per line (the shape Marquez/DataHub/Atlan/
    OpenMetadata ingestion clients expect); `format=json` returns a wrapper with
    a conformance report for previewing in the UI.
    """
    if event_type.upper() not in olb.VALID_EVENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"event_type must be one of {', '.join(olb.VALID_EVENT_TYPES)}",
        )
    if format not in ("json", "ndjson"):
        raise HTTPException(status_code=400, detail="format must be 'json' or 'ndjson'")
    want_columns = include_column_lineage or include_columns

    try:
        lineage = await asyncio.to_thread(get_table_lineage, catalog, schema, False)
        namespace = olb.dataset_namespace(_app_host())

        # Table-node lookup by full name + node id, and entity input/output sets.
        table_by_id: dict[str, object] = {}
        table_by_fqn: dict[str, object] = {}
        entity_by_id: dict[str, object] = {}
        for node in lineage.nodes:
            nt = getattr(node, "node_type", None)
            if nt == "table":
                table_by_id[node.id] = node
                table_by_fqn[getattr(node, "full_name", node.id)] = node
            elif nt == "entity":
                entity_by_id[node.id] = node

        # entity id -> {inputs: set[fqn], outputs: set[fqn]}
        io: dict[str, dict[str, set]] = {}
        for edge in lineage.edges:
            src, tgt = edge.source, edge.target
            if src in table_by_id and tgt in entity_by_id:  # table -> entity (input)
                io.setdefault(tgt, {"inputs": set(), "outputs": set()})["inputs"].add(
                    getattr(table_by_id[src], "full_name", ""))
            elif src in entity_by_id and tgt in table_by_id:  # entity -> table (output)
                io.setdefault(src, {"inputs": set(), "outputs": set()})["outputs"].add(
                    getattr(table_by_id[tgt], "full_name", ""))

        # Column lineage: target_fqn -> {target_col -> [{namespace, name, field}]}
        col_map: dict[str, dict[str, list[dict]]] = {}
        if want_columns and schema:
            try:
                col_lineage = await asyncio.to_thread(get_schema_column_lineage, catalog, schema, False)
                for ce in getattr(col_lineage, "edges", []) or []:
                    tgt_fqn = getattr(ce, "target_table", "")
                    src_fqn = getattr(ce, "source_table", "")
                    tgt_col = getattr(ce, "target_column", "")
                    src_col = getattr(ce, "source_column", "")
                    if not (tgt_fqn and tgt_col and src_fqn and src_col):
                        continue
                    col_map.setdefault(tgt_fqn, {}).setdefault(tgt_col, []).append(
                        {"namespace": namespace, "name": src_fqn, "field": src_col})
            except Exception as e:
                logger.debug(f"openlineage export: column lineage unavailable: {e}")

        dq_map = await asyncio.to_thread(_dq_rules_for_scope, catalog, schema) if include_data_quality else {}

        def _dataset(fqn: str) -> Optional[dict]:
            parts = fqn.split(".")
            if len(parts) != 3:
                return None
            node = table_by_fqn.get(fqn)
            return olb.build_dataset(
                namespace, parts[0], parts[1], parts[2],
                columns=(getattr(node, "columns", []) if (node and include_schema) else []),
                comment=(getattr(node, "comment", None) if (node and include_docs) else None),
                owner=(getattr(node, "owner", None) if (node and include_ownership) else None),
                column_lineage=(col_map.get(fqn) if want_columns else None),
                dq_rules=(dq_map.get(fqn) if include_data_quality else None),
            )

        events: list[dict] = []
        for ent_id, sets in io.items():
            ent = entity_by_id.get(ent_id)
            entity_type = getattr(ent, "entity_type", "JOB") if ent else "JOB"
            entity_key = getattr(ent, "entity_id", ent_id) if ent else ent_id
            last_run = getattr(ent, "last_run", None) if ent else None
            when = last_run or olb.now_iso()
            inputs = [d for d in (_dataset(f) for f in sorted(sets["inputs"])) if d]
            job_name = f"{str(entity_type).lower()}/{entity_key}"
            for out_fqn in sorted(sets["outputs"]):
                out_ds = _dataset(out_fqn)
                if not out_ds:
                    continue
                events.append(olb.build_run_event(
                    event_type=event_type,
                    job_namespace="databricks",
                    job_name=job_name,
                    event_time=when,
                    job_facets={"jobType": olb.job_type_facet(str(entity_type))},
                    run_facets={"nominalTime": olb.nominal_time_run_facet(when)},
                    inputs=inputs,
                    outputs=[out_ds],
                ))

        if format == "ndjson":
            body = "\n".join(json.dumps(e) for e in events)
            return PlainTextResponse(
                content=body,
                media_type="application/x-ndjson",
                headers={"Content-Disposition": f'attachment; filename="openlineage_{catalog}.ndjson"'},
            )

        conformance = olb.validate_events(events)
        return JSONResponse(content={
            "events": events,
            "count": len(events),
            "namespace": namespace,
            "schemaURL": olb.SCHEMA_URL,
            "conformance": conformance,
            "byte_size": len(json.dumps(events)),
        })
    except HTTPException:
        raise
    except Exception as e:
        # Detail stays server-side: the raw text is SQL/SDK error output.
        logger.error(f"openlineage export failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to export OpenLineage events")


@router.post("/api/import/openlineage")
async def import_openlineage(request: Request, body: dict):
    """Ingest OpenLineage RunEvents into the lineage graph.

    Accepts a list of RunEvent objects and registers them as external
    lineage edges in an app-owned table.

    Admin-gated: this is a lineage-ingest write into an app-owned table.
    Non-admins should not be able to inject lineage events that later render
    as trusted graph edges."""
    require_admin(request)
    events = body.get("events", [])
    if not events:
        raise HTTPException(status_code=400, detail="No events provided")

    LINEAGE_CATALOG = os.environ.get("LINEAGE_CATALOG", "lattice_lineage")
    LINEAGE_SCHEMA_NAME = os.environ.get("LINEAGE_SCHEMA", "lineage")
    EXT_TABLE = f"{LINEAGE_CATALOG}.{LINEAGE_SCHEMA_NAME}.external_lineage_events"

    imported = 0
    try:
        # Ensure the external events table exists
        _execute_sql(f"""CREATE TABLE IF NOT EXISTS {EXT_TABLE} (
            event_id STRING, event_type STRING, event_time TIMESTAMP,
            job_namespace STRING, job_name STRING, run_id STRING,
            input_datasets STRING, output_datasets STRING,
            raw_event STRING, imported_at TIMESTAMP
        ) USING DELTA""")

        now = datetime.now(timezone.utc).isoformat()
        for event in events[:100]:  # Cap at 100 per request
            import uuid
            eid = str(uuid.uuid4())
            job = event.get("job", {})
            run = event.get("run", {})
            # Every value below is caller-supplied: escape with sql_str, which
            # handles backslashes before quotes and truncates before escaping so
            # a cut can never split an escape pair and re-open the literal.
            inputs_json = sql_str(json.dumps(event.get("inputs", [])), 4000)
            outputs_json = sql_str(json.dumps(event.get("outputs", [])), 4000)
            raw_json = sql_str(json.dumps(event), 8000)

            _execute_sql(f"""
                INSERT INTO {EXT_TABLE}
                (event_id, event_type, event_time, job_namespace, job_name, run_id, input_datasets, output_datasets, raw_event, imported_at)
                VALUES ('{eid}', '{sql_str(event.get("eventType", "COMPLETE"), 100)}',
                        TIMESTAMP '{sql_str(event.get("eventTime", now), 100)}',
                        '{sql_str(job.get("namespace", ""), 500)}',
                        '{sql_str(job.get("name", ""), 500)}',
                        '{sql_str(run.get("runId", ""), 200)}',
                        '{inputs_json}', '{outputs_json}',
                        '{raw_json}', TIMESTAMP '{now}')
            """)
            imported += 1

        return {"status": "ok", "imported": imported}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"openlineage import failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to import OpenLineage events")


# ===========================================================================
# Live OpenLineage Producer — closes #17 to HAVE (v2.5.2)
#
# Architecture (decoupled, same pattern as webhook delivery):
#   1. POST /producer/configure — register external OL endpoint (Marquez, Atlan, etc.)
#   2. POST /producer/produce — detect lineage changes since last run, build OL events,
#      queue them in `openlineage_producer_queue` Delta table
#   3. External scheduled job reads queue and delivers via HTTP POST
#   4. GET /producer/events — view queue status (pending/delivered/failed)
# ===========================================================================

LINEAGE_CATALOG = os.environ.get("LINEAGE_CATALOG", "lattice_lineage")
LINEAGE_SCHEMA_NAME = os.environ.get("LINEAGE_SCHEMA", "lineage")
PRODUCER_CONFIG_TABLE = f"{LINEAGE_CATALOG}.{LINEAGE_SCHEMA_NAME}.openlineage_producer_config"
PRODUCER_QUEUE_TABLE = f"{LINEAGE_CATALOG}.{LINEAGE_SCHEMA_NAME}.openlineage_producer_queue"


def _ensure_producer_tables() -> None:
    """Lazily create producer tables."""
    try:
        _execute_sql(f"""CREATE TABLE IF NOT EXISTS {PRODUCER_CONFIG_TABLE} (
            config_id STRING, endpoint_url STRING, endpoint_name STRING,
            api_key_secret_scope STRING, api_key_secret_key STRING,
            active BOOLEAN, created_at TIMESTAMP, updated_at TIMESTAMP
        ) USING DELTA""")
        _execute_sql(f"""CREATE TABLE IF NOT EXISTS {PRODUCER_QUEUE_TABLE} (
            event_id STRING, event_json STRING, target_endpoint STRING,
            status STRING, produced_at TIMESTAMP, delivered_at TIMESTAMP,
            error_message STRING
        ) USING DELTA""")
    except Exception as e:
        logger.warning(f"openlineage producer: could not ensure tables: {e}")


_producer_tables_ensured = False


def _lazy_ensure_producer():
    global _producer_tables_ensured
    if not _producer_tables_ensured:
        _ensure_producer_tables()
        _producer_tables_ensured = True


@router.post("/api/openlineage/producer/configure")
async def configure_producer(request: Request, body: dict):
    """Register an external OpenLineage-compatible endpoint for event delivery.

    Body:
      endpoint_url: str — The HTTP endpoint to POST OL events to
      endpoint_name: str — Friendly name (e.g. "Marquez", "Atlan", "DataHub")
      api_key_secret_scope: str — (optional) Databricks secret scope for auth
      api_key_secret_key: str — (optional) Secret key within scope

    Admin-gated: an endpoint registration is an outbound-delivery trust anchor.
    The MERGE below keys on endpoint_name, so an ungated caller could re-point
    an existing row's endpoint_url and exfiltrate every produced event.
    """
    require_admin(request)
    _lazy_ensure_producer()
    endpoint_url = body.get("endpoint_url", "").strip()
    # Capped here (not at interpolation) so the stored and returned names agree.
    endpoint_name = body.get("endpoint_name", "default").strip()[:200]
    if not endpoint_url:
        raise HTTPException(status_code=400, detail="endpoint_url is required")
    # Only https:// with a real host — events carry lineage metadata and (via the
    # configured secret) an auth token, so plaintext http://, file:// and other
    # schemes are rejected rather than silently delivered to.
    parsed = urlparse(endpoint_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise HTTPException(
            status_code=400,
            detail="endpoint_url must be an https:// URL with a host",
        )

    import uuid
    new_config_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    # Distinguish "omitted" from "set to empty". Omitting the secret refs on an
    # update must leave the stored ones alone; supplying them must rotate them.
    scope_in = body.get("api_key_secret_scope")
    key_in = body.get("api_key_secret_key")
    rotating_secret = scope_in is not None or key_in is not None
    scope = sql_str(scope_in or "", 200)
    key = sql_str(key_in or "", 200)

    # An UPDATE that ignored the secret columns entirely made a secret reference
    # write-once-FOREVER, which broke the ordinary "register now, add auth later"
    # flow: the second call took WHEN MATCHED, silently discarded the secret, and
    # still returned 200 with a freshly minted config_id that was never stored.
    # There is no DELETE endpoint and no row-replace path for this table, so the
    # documented workaround ("delete and re-create the row") did not exist —
    # rotation required manual SQL outside the app. This endpoint is admin-gated,
    # so an explicit rotation is a legitimate admin action; an OMITTED secret is
    # still preserved, which is what the trust-anchor concern actually needs.
    secret_update = (
        f",\n                api_key_secret_scope = '{scope}',"
        f"\n                api_key_secret_key = '{key}'"
        if rotating_secret else ""
    )

    try:
        await asyncio.to_thread(_execute_sql, f"""
            MERGE INTO {PRODUCER_CONFIG_TABLE} t
            USING (SELECT '{sql_str(endpoint_name)}' AS endpoint_name) s
            ON t.endpoint_name = s.endpoint_name
            WHEN MATCHED THEN UPDATE SET
                endpoint_url = '{sql_str(endpoint_url, 2000)}',
                active = true,
                updated_at = TIMESTAMP '{now}'{secret_update}
            WHEN NOT MATCHED THEN INSERT
                (config_id, endpoint_url, endpoint_name, api_key_secret_scope, api_key_secret_key, active, created_at, updated_at)
            VALUES ('{new_config_id}', '{sql_str(endpoint_url, 2000)}',
                    '{sql_str(endpoint_name)}', '{scope}', '{key}',
                    true, TIMESTAMP '{now}', TIMESTAMP '{now}')
        """)
        # Read the id back rather than returning new_config_id unconditionally —
        # on the MATCHED path that value was never written to any row.
        stored = await asyncio.to_thread(
            _execute_sql,
            f"SELECT config_id FROM {PRODUCER_CONFIG_TABLE} "
            f"WHERE endpoint_name = '{sql_str(endpoint_name)}' LIMIT 1",
        )
        config_id = (stored[0].get("config_id") if stored else None) or new_config_id
        return {
            "status": "ok",
            "config_id": config_id,
            "endpoint_name": endpoint_name,
            "secret_rotated": rotating_secret,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"openlineage producer configure failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to configure producer endpoint")


@router.get("/api/openlineage/producer/config")
async def get_producer_config(request: Request):
    """View all configured OpenLineage producer endpoints. Admin-gated.

    Dropping the api_key_secret_* columns from the projection was necessary but
    not sufficient: `endpoint_url` is itself sensitive. configure_producer only
    checks https+host, so `https://marquez.internal.corp/api/v1/lineage?apiKey=…`
    is a valid registration — and an ungated read handed every app user the query
    string plus the internal hostname. That is the same disclosure _redact_url was
    added for on the sibling webhook list, which got both a gate and redaction in
    the same commit; this endpoint got neither.
    """
    require_admin(request)
    _lazy_ensure_producer()
    try:
        rows = await asyncio.to_thread(
            _execute_sql, f"SELECT config_id, endpoint_url, endpoint_name, active, created_at, updated_at FROM {PRODUCER_CONFIG_TABLE} ORDER BY endpoint_name"
        )
        for row in rows:
            row["endpoint_url"] = redact_url(row.get("endpoint_url"))
        return {"endpoints": rows}
    except Exception as e:
        logger.error(f"openlineage producer config read failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to read producer configuration")


@router.post("/api/openlineage/producer/produce")
async def produce_events(
    request: Request,
    catalog: str = Query(...),
    schema: Optional[str] = Query(None),
    lookback_hours: int = Query(24, ge=1, le=168),
):
    """Detect recent lineage-producing write events and queue OpenLineage events.

    Scans system.access.table_lineage for recent activity (default: last 24h),
    builds OpenLineage RunEvents for each new write detected, and stores them
    in the producer queue for asynchronous delivery to configured endpoints.

    Designed to be called by a scheduled Databricks job (e.g. hourly/daily).

    Admin-gated: this is a lineage-ingest write into the app-owned producer
    queue. Non-admins should not be able to inject lineage events.
    """
    require_admin(request)
    # catalog/schema are UC identifiers interpolated into the system-table scan
    # below. Allow-list them before any SQL is built — the identifier regex
    # forbids quotes and spaces, so no UNION/comment payload can survive. These
    # run outside the try so their 400 isn't rewritten as a 500. lookback_hours
    # is already bounded by Query(ge=1, le=168).
    catalog = _validate(catalog, "catalog")
    if schema:
        schema = _validate(schema, "schema")
    _lazy_ensure_producer()
    try:
        # 1. Find recent lineage-producing writes
        schema_filter = f"AND target_table_catalog = '{catalog}' AND target_table_schema = '{schema}'" if schema else f"AND target_table_catalog = '{catalog}'"
        recent_writes = await asyncio.to_thread(_execute_sql, f"""
            SELECT DISTINCT
                source_table_full_name, target_table_full_name,
                entity_type, entity_id, event_time
            FROM system.access.table_lineage
            WHERE event_time > current_timestamp() - INTERVAL {lookback_hours} HOURS
              {schema_filter}
            ORDER BY event_time DESC
            LIMIT 200
        """)

        if not recent_writes:
            return {"status": "ok", "events_produced": 0, "note": "No recent writes detected"}

        # 2. Build OpenLineage events for each write
        import uuid
        now = datetime.now(timezone.utc).isoformat()
        events_produced = 0

        # Group by target table + entity (to consolidate inputs)
        from collections import defaultdict
        grouped = defaultdict(lambda: {"inputs": set(), "entity_type": "", "entity_id": "", "event_time": ""})
        for row in recent_writes:
            target = row.get("target_table_full_name", "")
            entity = row.get("entity_id", "unknown")
            key = f"{target}|{entity}"
            source = row.get("source_table_full_name", "")
            if source:
                grouped[key]["inputs"].add(source)
            grouped[key]["entity_type"] = row.get("entity_type", "JOB")
            grouped[key]["entity_id"] = entity
            grouped[key]["event_time"] = row.get("event_time", now)
            grouped[key]["target"] = target

        # 3. Queue each event
        for key, data in list(grouped.items())[:100]:
            target = data.get("target", "")
            tgt_parts = target.split(".")
            if len(tgt_parts) != 3:
                continue

            # Build input datasets
            input_datasets = []
            for src in data["inputs"]:
                src_parts = src.split(".")
                if len(src_parts) == 3:
                    input_datasets.append(_table_to_openlineage_dataset(src_parts[0], src_parts[1], src_parts[2]))

            output_ds = _table_to_openlineage_dataset(tgt_parts[0], tgt_parts[1], tgt_parts[2])
            event = _build_openlineage_run_event(
                source_tables=input_datasets,
                target_table=output_ds,
                entity_type=data["entity_type"],
                entity_id=data["entity_id"],
                event_time=data.get("event_time", now),
            )

            # Queue the event
            eid = str(uuid.uuid4())
            event_json = sql_str(json.dumps(event), 16000)
            _execute_sql(f"""
                INSERT INTO {PRODUCER_QUEUE_TABLE}
                (event_id, event_json, target_endpoint, status, produced_at, delivered_at, error_message)
                VALUES ('{eid}', '{event_json}', 'all', 'pending', TIMESTAMP '{now}', NULL, NULL)
            """)
            events_produced += 1

        return {
            "status": "ok",
            "events_produced": events_produced,
            "lookback_hours": lookback_hours,
            "catalog": catalog,
            "schema": schema,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"openlineage produce failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to produce OpenLineage events")


@router.get("/api/openlineage/producer/events")
async def producer_events(
    request: Request,
    status_filter: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
):
    """View the OpenLineage producer event queue (pending/delivered/failed).

    Used to monitor production health and debug delivery issues.
    """
    # status_filter lands in the WHERE clause of a query whose rows are returned
    # to the caller. Allow-list it against the statuses the queue actually uses
    # (outside the try, so the 400 isn't rewritten as a 500) and escape the value
    # anyway — defence in depth if PRODUCER_STATUSES ever grows.
    #
    # Checked BEFORE _lazy_ensure_producer's DDL, so a rejected filter costs no
    # warehouse round-trip.
    if status_filter and status_filter not in PRODUCER_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"status_filter must be one of: {' | '.join(PRODUCER_STATUSES)}",
        )
    where = f"WHERE status = '{sql_str(status_filter)}'" if status_filter else ""
    _lazy_ensure_producer()
    try:
        rows = await asyncio.to_thread(
            _execute_sql, f"""
                SELECT event_id, target_endpoint, status, produced_at, delivered_at, error_message
                FROM {PRODUCER_QUEUE_TABLE}
                {where}
                ORDER BY produced_at DESC
                LIMIT {limit}
            """
        )
        # Also get summary counts
        counts = await asyncio.to_thread(
            _execute_sql, f"SELECT status, COUNT(*) as cnt FROM {PRODUCER_QUEUE_TABLE} GROUP BY status"
        )
        return {"events": rows, "counts": {r["status"]: int(r["cnt"]) for r in counts}}
    except Exception as e:
        logger.error(f"openlineage producer events read failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to read producer event queue")
