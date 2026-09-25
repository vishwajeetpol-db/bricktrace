"""Capability gap closures — v2.5.2.

Supplementary endpoints closing remaining scorecard gaps:
  #02 End-to-End Lineage  → BI tool consumer detection + streaming topology
  #07 Versioned Lineage   → Auto-capture scheduling + timeline view
  #11 Data Quality        → DQ trend history + pipeline expectation sync
  #20 Notifications       → Webhook registration + delivery queue

Register this router in main.py: app.include_router(capability_closures.router)

Security fixes applied:
  - A1:  All user inputs validated via _validate() before SQL interpolation
  - A2:  Admin gates on auto-capture and record-metrics
  - A10: bi_consumers returns {available: false} on infra failure instead of silent empty
  - C8:  Streaming topology edge errors logged, not silently swallowed
"""
from __future__ import annotations

import os
import time
import uuid
import json
import math
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from databricks.sdk.service.sql import StatementState
from backend.lineage_service import _get_client
from backend.validators import _IDENTIFIER_RE, _FULL_NAME_RE, _validate, redact_url, require_admin, sql_str
from backend.circuit_breaker import sql_circuit_breaker

logger = logging.getLogger(__name__)
router = APIRouter(tags=["capability-closures"])

LINEAGE_CATALOG = os.environ.get("LINEAGE_CATALOG", "lattice_lineage")
LINEAGE_SCHEMA = os.environ.get("LINEAGE_SCHEMA", "lineage")
WAREHOUSE_ID = os.environ.get("DATABRICKS_WAREHOUSE_ID", "")
SQL_WAIT_TIMEOUT = os.environ.get("SQL_WAIT_TIMEOUT", "50s")
DQ_HISTORY_TABLE = f"{LINEAGE_CATALOG}.{LINEAGE_SCHEMA}.dq_metrics_history"
WEBHOOKS_TABLE = f"{LINEAGE_CATALOG}.{LINEAGE_SCHEMA}.notification_webhooks"
DELIVERY_QUEUE_TABLE = f"{LINEAGE_CATALOG}.{LINEAGE_SCHEMA}.webhook_delivery_queue"
SNAPSHOTS_TABLE = f"{LINEAGE_CATALOG}.{LINEAGE_SCHEMA}.graph_snapshots"


def _execute_sql(sql: str) -> list[dict]:
    """Execute SQL with circuit breaker protection (C8 fix)."""
    if not WAREHOUSE_ID:
        raise RuntimeError("No SQL warehouse available.")
    # C8 FIX: Fast-fail if warehouse has been consistently failing
    sql_circuit_breaker.check()
    client = _get_client()
    try:
        resp = client.statement_execution.execute_statement(
            statement=sql, warehouse_id=WAREHOUSE_ID, wait_timeout=SQL_WAIT_TIMEOUT,
        )
        if resp.status.state != StatementState.SUCCEEDED:
            err = resp.status.error.message if resp.status.error else resp.status.state
            sql_circuit_breaker.record_failure()
            raise RuntimeError(f"SQL failed: {err}")
        sql_circuit_breaker.record_success()
        if not resp.result or not resp.result.data_array:
            return []
        columns = [c.name for c in resp.manifest.schema.columns]
        return [dict(zip(columns, row)) for row in resp.result.data_array]
    except RuntimeError:
        raise
    except Exception as e:
        sql_circuit_breaker.record_failure()
        raise RuntimeError(f"SQL failed: {e}")


def _safe_identifier(value: Optional[str]) -> Optional[str]:
    """Validate optional identifier input — returns None if empty, raises 400 if invalid."""
    if not value:
        return None
    v = value.strip()
    if not v:
        return None
    if not _IDENTIFIER_RE.match(v):
        raise HTTPException(status_code=400, detail=f"Invalid identifier: '{v[:50]}'")
    return v


# ---------------------------------------------------------------------------
# Streaming topology enrichment helpers
# ---------------------------------------------------------------------------
# Freshness SLA buckets (seconds since a stream's table was last written). These
# are generic defaults — a triggered daily stream and a continuous one have very
# different "fresh" windows, so the thresholds are env-tunable.
STREAM_FRESH_SECONDS = int(os.environ.get("STREAM_FRESH_SECONDS", str(60 * 60)))          # < 1h  → fresh
STREAM_LAGGING_SECONDS = int(os.environ.get("STREAM_LAGGING_SECONDS", str(24 * 60 * 60)))  # < 24h → lagging, else stale
# Producer-discovery + metrics window. The producer→stream relationship is
# stable, so this is generous (a stream that last ran weeks ago should still show
# its producing pipeline). Freshness/staleness is computed from last_altered, not
# this window, so a long lookback never overstates how fresh a stream is.
STREAM_METRICS_LOOKBACK_DAYS = int(os.environ.get("STREAM_METRICS_LOOKBACK_DAYS", "90"))


def _classify_stream_source(data_source_format: Optional[str], source_fqns: list[str]) -> str:
    """Best-effort ingestion-source classification for a streaming table.

    Streaming tables often report UNKNOWN_DATA_SOURCE_FORMAT, so we also sniff the
    upstream source names (paths/connectors) recorded in table_lineage. Returns a
    coarse kind the UI renders with an icon; falls back to a generic "stream".
    """
    fmt = (data_source_format or "").lower()
    joined = " ".join(s.lower() for s in source_fqns if s)
    hay = f"{fmt} {joined}"
    if "kafka" in hay:
        return "kafka"
    if "kinesis" in hay:
        return "kinesis"
    if "eventhub" in hay or "event_hub" in hay or "azure_event" in hay:
        return "eventhub"
    if ("cloudfiles" in hay or "autoloader" in hay
            or any(s.lower().startswith(("s3:", "s3a:", "abfss:", "gs:", "dbfs:", "/volumes", "/volume"))
                   for s in source_fqns if s)
            or fmt in ("csv", "json", "parquet", "avro", "text")):
        return "autoloader"
    if "delta" in fmt:
        return "delta"
    return "stream"


def _freshness(last_altered: Optional[str]) -> tuple[Optional[int], str]:
    """(age_seconds, bucket) for a streaming table's last_altered timestamp.

    Bucket is one of fresh | lagging | stale | unknown. Fail-open: an unparseable
    or missing timestamp yields (None, "unknown") rather than raising.
    """
    if not last_altered:
        return None, "unknown"
    try:
        ts = datetime.fromisoformat(str(last_altered).replace("Z", "+00:00"))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        age = int((datetime.now(timezone.utc) - ts).total_seconds())
        if age < 0:
            age = 0
        if age < STREAM_FRESH_SECONDS:
            return age, "fresh"
        if age < STREAM_LAGGING_SECONDS:
            return age, "lagging"
        return age, "stale"
    except Exception:
        return None, "unknown"


# ===========================================================================
# #02 — BI Tool Consumer Detection + Streaming Topology
# ===========================================================================

@router.get("/api/lineage/bi-consumers")
async def bi_tool_consumers(
    request: Request,
    catalog: Optional[str] = Query(None),
    table: Optional[str] = Query(None),
    days: int = Query(30, ge=1, le=365),
):
    """Detect BI tool consumers (Tableau, PowerBI, Looker, etc.)
    via query history user-agent patterns. Returns tool type + frequency.

    A1 FIX: catalog/table are validated before SQL interpolation.
    A10 FIX: Returns {available: false, error: ...} on infra failure.
    """
    # A1 FIX: Validate inputs before SQL interpolation
    safe_catalog = _safe_identifier(catalog)
    safe_table = _safe_identifier(table)

    filters = []
    if safe_catalog:
        filters.append(f"lower(statement_text) LIKE '%{safe_catalog.lower()}%'")
    if safe_table:
        filters.append(f"lower(statement_text) LIKE '%{safe_table.lower()}%'")
    extra = ("AND " + " AND ".join(filters)) if filters else ""
    try:
        rows = await asyncio.to_thread(_execute_sql, f"""
            SELECT client_application AS bi_tool, COUNT(*) AS query_count,
                   COUNT(DISTINCT executed_by) AS distinct_users, MAX(start_time) AS last_accessed
            FROM system.query.history
            WHERE start_time >= current_timestamp() - INTERVAL {days} DAYS
              AND lower(client_application) RLIKE '(tableau|power.?bi|looker|mode|metabase|sigma|thoughtspot|dbt.?cloud|redash|superset)'
              AND status = 'FINISHED' {extra}
            GROUP BY client_application ORDER BY query_count DESC LIMIT 50
        """)
        return {"bi_consumers": rows, "lookback_days": days}
    except Exception as e:
        # A10 FIX: Signal infrastructure failure instead of silent empty
        logger.warning(f"BI consumers query failed: {e}")
        return {"bi_consumers": [], "available": False, "error": str(e)}


@router.get("/api/lineage/streaming-topology")
async def streaming_topology(request: Request, catalog: Optional[str] = Query(None)):
    """Detect streaming tables + source edges for streaming topology view.

    A1 FIX: catalog validated before SQL interpolation.
    C8 FIX: Edge-fetch errors logged instead of silently swallowed.
    """
    # A1 FIX: Validate catalog
    safe_catalog = _safe_identifier(catalog)
    cat_filter = f"AND t.table_catalog = '{safe_catalog}'" if safe_catalog else ""
    try:
        rows = await asyncio.to_thread(_execute_sql, f"""
            SELECT t.table_catalog, t.table_schema, t.table_name, t.data_source_format, t.last_altered
            FROM system.information_schema.tables t
            WHERE t.table_type = 'STREAMING_TABLE' {cat_filter}
            ORDER BY t.table_catalog, t.table_schema, t.table_name LIMIT 500
        """)
        # Batch-resolve pipeline id → name once (avoids a per-table SDK round-trip).
        pipeline_names = await asyncio.to_thread(_pipeline_name_map)

        edges = []
        edge_errors = 0
        # Per-table producer edges, keyed by fqn, so we can enrich each node with
        # its producing pipeline + upstream sources for source classification.
        producers: dict[str, dict] = {}
        for row in rows[:50]:
            fqn = f"{row['table_catalog']}.{row['table_schema']}.{row['table_name']}"
            try:
                e = _execute_sql(f"""
                    SELECT DISTINCT source_table_full_name, entity_type, entity_id
                    FROM system.access.table_lineage
                    WHERE target_table_full_name = '{fqn}' AND event_time > current_timestamp() - INTERVAL {STREAM_METRICS_LOOKBACK_DAYS} DAYS LIMIT 10
                """)
                srcs, pid = [], None
                for r in e:
                    src = r.get("source_table_full_name") or ""
                    et = r.get("entity_type", "")
                    if src:
                        srcs.append(src)
                        edges.append({"target": fqn, "source": src, "entity_type": et})
                    if (et or "").upper() == "PIPELINE" and r.get("entity_id"):
                        pid = r.get("entity_id")
                producers[fqn] = {"sources": srcs, "pipeline_id": pid}
            except Exception as edge_err:
                # C8 FIX: Log edge-fetch failures instead of silently passing
                edge_errors += 1
                logger.debug(f"Edge fetch failed for {fqn}: {edge_err}")

        # Enrich each streaming-table node in place: source kind, producing
        # pipeline (id + resolved name), and freshness SLA bucket.
        for row in rows:
            fqn = f"{row['table_catalog']}.{row['table_schema']}.{row['table_name']}"
            prod = producers.get(fqn, {})
            pid = prod.get("pipeline_id")
            age, bucket = _freshness(row.get("last_altered"))
            row["fqn"] = fqn
            row["source_kind"] = _classify_stream_source(row.get("data_source_format"), prod.get("sources", []))
            row["pipeline_id"] = pid
            row["pipeline_name"] = pipeline_names.get(pid) if pid else None
            row["age_seconds"] = age
            row["freshness"] = bucket

        result = {"streaming_tables": rows, "streaming_edges": edges, "count": len(rows)}
        if edge_errors:
            result["edge_errors"] = edge_errors
        return result
    except Exception:
        logger.exception("capability_closures: streaming_topology failed")
        raise HTTPException(status_code=500, detail="Failed to streaming topology.")


def _pipeline_name_map() -> dict[str, str]:
    """pipeline_id → name for all pipelines the SP can see (best-effort, one query)."""
    try:
        rows = _execute_sql("SELECT pipeline_id, name FROM system.lakeflow.pipelines")
        return {r["pipeline_id"]: r.get("name") for r in rows if r.get("pipeline_id")}
    except Exception as e:
        logger.debug(f"pipeline name map unavailable: {e}")
        return {}


# --- Streaming live metrics (Tier 3) ---------------------------------------
# flow_progress events are fetched per pipeline over the REST API and cached for
# a short TTL so a dashboard refresh doesn't hammer the events endpoint. Status
# comes from pipeline_update_timeline (reliable) even when no live flow events
# have been retained.
_flow_metrics_cache: dict[str, tuple[float, dict]] = {}
_FLOW_METRICS_TTL_SECONDS = int(os.environ.get("STREAM_FLOW_METRICS_TTL_SECONDS", "60"))
_FLOW_EVENTS_MAX = 100


def _pipeline_status_batch(pipeline_ids: list[str]) -> dict[str, dict]:
    """Per-pipeline update health from system.lakeflow.pipeline_update_timeline.

    One grouped query over all requested ids. Fail-open: returns {} if the
    timeline is unreadable (missing privilege), so the UI just shows "unknown".
    """
    ids = [p for p in pipeline_ids if p]
    if not ids:
        return {}
    in_list = ", ".join(sql_str(p) for p in ids)
    try:
        rows = _execute_sql(f"""
            SELECT pipeline_id,
                   COUNT(*) AS total_updates,
                   SUM(CASE WHEN result_state = 'COMPLETED' THEN 1 ELSE 0 END) AS ok_updates,
                   SUM(CASE WHEN result_state IN ('FAILED','CANCELED') THEN 1 ELSE 0 END) AS failed_updates,
                   MAX(period_start_time) AS last_update_at,
                   MAX_BY(result_state, period_start_time) AS last_state,
                   AVG(DATEDIFF(SECOND, period_start_time, period_end_time)) AS avg_duration_seconds
            FROM system.lakeflow.pipeline_update_timeline
            WHERE pipeline_id IN ({in_list})
              AND period_start_time >= dateadd(DAY, -{STREAM_METRICS_LOOKBACK_DAYS}, current_timestamp())
            GROUP BY pipeline_id
        """)
    except Exception as e:
        logger.info(f"streaming metrics: pipeline_update_timeline unavailable: {e}")
        return {}

    out: dict[str, dict] = {}
    for r in rows:
        pid = r.get("pipeline_id")
        if not pid:
            continue
        total = int(r.get("total_updates") or 0)
        ok = int(r.get("ok_updates") or 0)
        failed = int(r.get("failed_updates") or 0)
        last_at = str(r["last_update_at"]) if r.get("last_update_at") else None
        age, _ = _freshness(last_at)
        last_state = r.get("last_state")
        # Coarse operational status. Continuous pipelines don't surface a RUNNING
        # row here, so recency of the last update stands in for "active".
        if last_state in ("FAILED", "CANCELED"):
            status = "failed"
        elif age is None:
            status = "unknown"
        elif age < STREAM_FRESH_SECONDS:
            status = "active"
        elif age < STREAM_LAGGING_SECONDS:
            status = "idle"
        else:
            status = "stale"
        out[pid] = {
            "status": status,
            "last_update_at": last_at,
            "last_update_age_seconds": age,
            "last_result_state": last_state,
            "total_updates": total,
            "success_rate": round(ok / total, 4) if total else None,
            "failed_updates": failed,
            "avg_duration_seconds": round(float(r["avg_duration_seconds"]), 1) if r.get("avg_duration_seconds") else None,
        }
    return out


def _pipeline_flow_metrics(pipeline_id: str) -> dict:
    """Throughput / backlog / DQ for a pipeline from its flow_progress events.

    Best-effort over the pipeline events REST API (no server-side filter — that
    400s on some workspaces — so we fetch recent events and filter client-side).
    Cached for a short TTL. Returns metrics_available=False when nothing usable
    is retained (e.g. a stream that hasn't run recently), never raises.
    """
    now = time.monotonic()
    hit = _flow_metrics_cache.get(pipeline_id)
    if hit and (now - hit[0]) < _FLOW_METRICS_TTL_SECONDS:
        return hit[1]

    result = {"metrics_available": False, "throughput_rows": None, "backlog_records": None,
              "backlog_bytes": None, "trend": [], "data_quality": None}
    try:
        client = _get_client()
        resp = client.api_client.do(
            "GET", f"/api/2.0/pipelines/{pipeline_id}/events",
            query={"max_results": _FLOW_EVENTS_MAX, "order": "timestamp desc"},
        )
        events = (resp or {}).get("events", []) if isinstance(resp, dict) else []
        trend: list[int] = []
        for ev in events:
            if ev.get("event_type") != "flow_progress":
                continue
            fp = (ev.get("details") or {}).get("flow_progress") or {}
            metrics = fp.get("metrics") or {}
            out_rows = metrics.get("num_output_rows")
            if out_rows is not None:
                if result["throughput_rows"] is None:
                    result["throughput_rows"] = int(out_rows)  # latest microbatch
                if len(trend) < 20:
                    trend.append(int(out_rows))
            # First event carrying backlog / DQ wins (events are newest-first).
            if result["backlog_records"] is None and metrics.get("backlog_records") is not None:
                result["backlog_records"] = int(metrics["backlog_records"])
            if result["backlog_bytes"] is None and metrics.get("backlog_bytes") is not None:
                result["backlog_bytes"] = int(metrics["backlog_bytes"])
            dq = fp.get("data_quality")
            if result["data_quality"] is None and dq:
                result["data_quality"] = {
                    "dropped_records": dq.get("dropped_records"),
                    "expectations": dq.get("expectations"),
                }
        result["trend"] = list(reversed(trend))  # oldest → newest for the sparkline
        result["metrics_available"] = bool(trend) or result["backlog_records"] is not None
    except Exception as e:
        logger.debug(f"flow metrics unavailable for pipeline {pipeline_id}: {e}")

    _flow_metrics_cache[pipeline_id] = (now, result)
    return result


@router.get("/api/lineage/streaming-metrics")
async def streaming_metrics(request: Request, pipeline_ids: Optional[str] = Query(None)):
    """Live operational metrics for the given streaming pipelines (Tier 3).

    `pipeline_ids` is a comma-separated list of pipeline ids (as discovered by
    /streaming-topology). Returns a per-pipeline map of update status + freshness
    (from pipeline_update_timeline) plus throughput/backlog/DQ (from flow_progress
    events, best-effort). Everything fails open so the dashboard degrades to
    "metrics unavailable" rather than erroring.
    """
    ids = [p.strip() for p in (pipeline_ids or "").split(",") if p.strip()]
    # Validate ids up front — they are interpolated into SQL and a REST path.
    for pid in ids:
        if not _FULL_NAME_RE.match(pid) and not _IDENTIFIER_RE.match(pid) and not _is_uuid(pid):
            raise HTTPException(status_code=400, detail=f"Invalid pipeline id: '{pid[:50]}'")
    if not ids:
        return {"metrics": {}, "count": 0}
    ids = ids[:50]  # cap fan-out
    try:
        status_map = await asyncio.to_thread(_pipeline_status_batch, ids)
        metrics: dict[str, dict] = {}
        for pid in ids:
            base = dict(status_map.get(pid, {"status": "unknown"}))
            flow = await asyncio.to_thread(_pipeline_flow_metrics, pid)
            base.update(flow)
            metrics[pid] = base
        return {"metrics": metrics, "count": len(metrics)}
    except Exception:
        logger.exception("capability_closures: streaming_metrics failed")
        raise HTTPException(status_code=500, detail="Failed to fetch streaming metrics.")


def _is_uuid(s: str) -> bool:
    try:
        uuid.UUID(str(s))
        return True
    except Exception:
        return False


# ===========================================================================
# #07 — Auto-Capture Scheduling + Timeline
# ===========================================================================

@router.post("/api/snapshots/auto-capture")
async def auto_capture_all_scopes(request: Request):
    """Auto-capture snapshots for all catalogs with recent activity.
    Call on schedule (daily job) to build version history automatically.

    A2 FIX: Admin-gated — expensive scan should not be triggerable by any user.
    """
    # A2 FIX: Require admin for expensive auto-capture operation
    from backend.main import _get_user_info
    _, is_admin = _get_user_info(request)
    if not is_admin:
        raise HTTPException(status_code=403, detail="Admin required for auto-capture")
    try:
        catalogs = await asyncio.to_thread(_execute_sql, """
            SELECT DISTINCT target_table_catalog AS catalog
            FROM system.access.table_lineage
            WHERE event_time > current_timestamp() - INTERVAL 24 HOURS LIMIT 20
        """)
        from backend.lineage_service import get_table_lineage
        captured = []
        for row in catalogs:
            cat = row.get("catalog", "")
            if not cat:
                continue
            # `cat` comes from a system-table read, but it is still interpolated
            # into the INSERT's `scope` literal below and was the one value in this
            # hunk left raw while everything around it was escaped. Validating it
            # also keeps the written scope readable by the snapshot endpoints,
            # whose _validate_scope would otherwise reject what this wrote.
            try:
                cat = _validate(cat, "catalog")
            except HTTPException:
                logger.warning("auto-capture: skipping unusable catalog name")
                continue
            try:
                lineage = get_table_lineage(cat, None, False)
                nodes = [{"id": n.id, "type": getattr(n, "node_type", "unknown")} for n in lineage.nodes]
                edges_list = [{"source": e.source, "target": e.target} for e in lineage.edges]
                graph_json = json.dumps({"nodes": nodes, "edges": edges_list})
                if len(graph_json) > 10_000_000:
                    continue
                sid = str(uuid.uuid4())
                now = datetime.now(timezone.utc).isoformat()
                _execute_sql(f"""
                    INSERT INTO {SNAPSHOTS_TABLE}
                    (snapshot_id, scope, label, captured_at, captured_by, node_count, edge_count, graph_json, metadata)
                    VALUES ('{sid}', '{sql_str(cat)}', 'Auto {now[:10]}', TIMESTAMP '{now}', 'scheduler',
                            {len(nodes)}, {len(edges_list)}, '{sql_str(graph_json)}', '{{"auto":true}}')
                """)
                captured.append({"catalog": cat, "snapshot_id": sid, "nodes": len(nodes), "edges": len(edges_list)})
            except Exception as e:
                logger.debug(f"Auto-capture failed for {cat}: {e}")
        return {"status": "ok", "captured": captured}
    except Exception:
        logger.exception("capability_closures: auto_capture_all_scopes failed")
        raise HTTPException(status_code=500, detail="Failed to auto capture all scopes.")


@router.get("/api/snapshots/timeline")
async def snapshot_timeline(request: Request, scope: str = Query(...), days: int = Query(30)):
    """Node/edge count timeline for a scope — visualize graph growth.

    A1 FIX: scope validated via _safe_identifier before SQL interpolation.
    """
    # A1 FIX: Validate scope
    safe_scope = _safe_identifier(scope)
    if not safe_scope:
        raise HTTPException(status_code=400, detail="scope is required")
    try:
        rows = await asyncio.to_thread(_execute_sql, f"""
            SELECT snapshot_id, captured_at, node_count, edge_count, label
            FROM {SNAPSHOTS_TABLE}
            WHERE scope = '{safe_scope}'
              AND captured_at >= current_timestamp() - INTERVAL {days} DAYS
            ORDER BY captured_at ASC LIMIT 100
        """)
        return {"scope": safe_scope, "timeline": rows}
    except Exception:
        logger.exception("capability_closures: snapshot_timeline failed")
        raise HTTPException(status_code=500, detail="Failed to snapshot timeline.")


# ===========================================================================
# #11 — DQ Trend History + Pipeline Expectation Sync
# ===========================================================================

def _ensure_dq_history():
    try:
        _execute_sql(f"""CREATE TABLE IF NOT EXISTS {DQ_HISTORY_TABLE} (
            run_id STRING, table_fqn STRING, quality_score DOUBLE,
            rules_evaluated INT, rules_passed INT, rules_failed INT,
            evaluated_at TIMESTAMP, details STRING
        ) USING DELTA""")
    except Exception:
        pass


@router.post("/api/dq-rules/record-metrics")
async def record_dq_metrics(request: Request, body: dict):
    """Store a DQ metrics run for trending. Call after /api/dq-rules/metrics.

    A2 FIX: Admin-gated — writes to Delta should not be ungated.
    """
    # A2 FIX: Require admin for DQ metric recording
    from backend.main import _get_user_info
    _, is_admin = _get_user_info(request)
    if not is_admin:
        raise HTTPException(status_code=403, detail="Admin required to record DQ metrics")
    _ensure_dq_history()
    run_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    raw_fqn = (body.get("table_fqn", "") or "").strip()
    # A1 FIX: Validate table_fqn format (before escaping, so the regex sees the
    # value the caller actually sent)
    if raw_fqn and not _FULL_NAME_RE.match(raw_fqn):
        raise HTTPException(status_code=400, detail="Invalid table_fqn format")
    fqn = sql_str(raw_fqn)
    # A1 FIX: coerce the four numeric columns. They are interpolated at UNQUOTED
    # positions, so without coercion any string in the body — from an admin, but
    # still — is written straight into the statement as SQL.
    try:
        quality_score = float(body.get("quality_score", 0) or 0)
        rules_evaluated = int(body.get("rules_evaluated", 0) or 0)
        rules_passed = int(body.get("rules_passed", 0) or 0)
        rules_failed = int(body.get("rules_failed", 0) or 0)
        if not math.isfinite(quality_score):
            raise ValueError("quality_score must be finite")
    except (TypeError, ValueError, OverflowError):
        # OverflowError matters: `int(float('inf'))` raises it, not ValueError, and
        # Infinity reaches here intact because json.loads accepts `1e999`. Without
        # it, an infinite rules_evaluated escaped this 400 and surfaced as a 500.
        raise HTTPException(
            status_code=400,
            detail="quality_score must be a number and rules_evaluated/passed/failed integers",
        )
    try:
        await asyncio.to_thread(_execute_sql, f"""
            INSERT INTO {DQ_HISTORY_TABLE} VALUES (
                '{run_id}', '{fqn}', {quality_score},
                {rules_evaluated}, {rules_passed}, {rules_failed},
                TIMESTAMP '{now}', '{sql_str(json.dumps(body.get("details", {})), limit=4000)}')
        """)
        return {"status": "ok", "run_id": run_id}
    except Exception:
        logger.exception("capability_closures: record_dq_metrics failed")
        raise HTTPException(status_code=500, detail="Failed to record dq metrics.")


@router.get("/api/dq-rules/trends")
async def dq_trends(request: Request, table_fqn: str = Query(...), days: int = Query(30)):
    """Quality score trend over time. Returns direction: improving/stable/degrading.

    A1 FIX: table_fqn validated against _FULL_NAME_RE.
    """
    # A1 FIX: Validate table_fqn
    if not _FULL_NAME_RE.match(table_fqn):
        raise HTTPException(status_code=400, detail="Invalid table_fqn format")
    _ensure_dq_history()
    safe_fqn = sql_str(table_fqn)
    try:
        rows = await asyncio.to_thread(_execute_sql, f"""
            SELECT run_id, quality_score, rules_evaluated, rules_passed, rules_failed, evaluated_at
            FROM {DQ_HISTORY_TABLE}
            WHERE table_fqn = '{safe_fqn}'
              AND evaluated_at >= current_timestamp() - INTERVAL {days} DAYS
            ORDER BY evaluated_at ASC LIMIT 200
        """)
        trend = "stable"
        if len(rows) >= 2:
            first = float(rows[0].get("quality_score") or 0)
            last = float(rows[-1].get("quality_score") or 0)
            trend = "degrading" if last < first - 0.05 else "improving" if last > first + 0.05 else "stable"
        return {"table_fqn": table_fqn, "trend": trend, "data_points": rows}
    except Exception:
        logger.exception("capability_closures: dq_trends failed")
        raise HTTPException(status_code=500, detail="Failed to dq trends.")


@router.get("/api/dq-rules/pipeline-expectations")
async def pipeline_expectations(request: Request, catalog: Optional[str] = Query(None)):
    """List SDP pipeline expectations from streaming/materialized tables.

    A1 FIX: catalog validated before SQL interpolation.
    """
    # A1 FIX: Validate catalog
    safe_catalog = _safe_identifier(catalog)
    cat_filter = f"AND table_catalog = '{safe_catalog}'" if safe_catalog else ""
    try:
        rows = await asyncio.to_thread(_execute_sql, f"""
            SELECT table_catalog, table_schema, table_name, table_type
            FROM system.information_schema.tables
            WHERE table_type IN ('STREAMING_TABLE', 'MATERIALIZED_VIEW') {cat_filter}
            LIMIT 200
        """)
        expectations = []
        for row in rows[:30]:
            try:
                props = _execute_sql(f"""
                    SELECT property_key, property_value FROM system.information_schema.table_properties
                    WHERE table_catalog='{row["table_catalog"]}' AND table_schema='{row["table_schema"]}'
                      AND table_name='{row["table_name"]}' AND lower(property_key) LIKE '%expectation%'
                """)
                if props:
                    expectations.append({"table_fqn": f"{row['table_catalog']}.{row['table_schema']}.{row['table_name']}", "expectations": props})
            except Exception:
                pass
        return {"pipeline_tables": len(rows), "tables_with_expectations": expectations}
    except Exception:
        logger.exception("capability_closures: pipeline_expectations failed")
        raise HTTPException(status_code=500, detail="Failed to pipeline expectations.")


# ===========================================================================
# #20 — Webhook Registration + Delivery Queue
# ===========================================================================

def _ensure_webhook_tables():
    try:
        _execute_sql(f"""CREATE TABLE IF NOT EXISTS {WEBHOOKS_TABLE} (
            webhook_id STRING, name STRING, url STRING, event_types STRING,
            enabled BOOLEAN, secret STRING, created_by STRING, created_at TIMESTAMP
        ) USING DELTA""")
        _execute_sql(f"""CREATE TABLE IF NOT EXISTS {DELIVERY_QUEUE_TABLE} (
            delivery_id STRING, webhook_id STRING, webhook_url STRING,
            payload STRING, status STRING, queued_at TIMESTAMP, delivered_at TIMESTAMP
        ) USING DELTA""")
    except Exception:
        pass


class WebhookIn(BaseModel):
    name: str
    url: str
    event_types: str = "*"  # schema_change,dq_degradation,sensitive_flow,*
    secret: Optional[str] = ""


# Canonical implementation now lives in backend/validators.py, so this router and
# openlineage's producer-config read cannot disagree on what "redacted" means.
# Kept as a module-level alias because it is referenced below as _redact_url.
_redact_url = redact_url


@router.get("/api/notifications/webhooks")
async def list_webhooks(request: Request):
    """List registered webhook endpoints. Admin-gated.

    A2 FIX: the create/delete peers below both require admin and CHANGELOG.md
    documents all three as admin-gated, but this read was open — and it returned
    the raw `url`, i.e. any user could read every webhook's delivery token. The
    gate is now enforced and `url` is redacted to scheme+host on the way out, so
    a path-embedded secret never leaves the server at all.
    """
    require_admin(request)
    _ensure_webhook_tables()
    try:
        rows = await asyncio.to_thread(_execute_sql,
            f"SELECT webhook_id, name, url, event_types, enabled, created_at FROM {WEBHOOKS_TABLE}")
        for row in rows:
            row["url"] = _redact_url(row.get("url"))
        return {"webhooks": rows}
    except Exception:
        logger.exception("capability_closures: list_webhooks failed")
        raise HTTPException(status_code=500, detail="Failed to list webhooks.")


@router.post("/api/notifications/webhooks")
async def register_webhook(request: Request, body: WebhookIn):
    """Register a webhook for push notifications. Admin-gated."""
    from backend.main import _get_user_info
    email, is_admin = _get_user_info(request)
    if not is_admin:
        raise HTTPException(status_code=403, detail="Admin required")
    # Require https:// with a real host. This handler did NO scheme validation at
    # all — urlparse appeared in this module only inside _redact_url — so an
    # `http://` or `file://` URL was accepted and enqueue_delivery copied it into
    # the queue for the external delivery job to POST notification content to.
    # Notifications carry table names and DQ findings, and the row's `secret` is
    # sent alongside, so plaintext delivery leaks both. Mirrors the check
    # configure_producer already applies to its own outbound endpoint.
    url = (body.url or "").strip()
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise HTTPException(
            status_code=400,
            detail="Webhook url must be an https:// URL with a host",
        )
    _ensure_webhook_tables()
    wid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    safe = lambda s: sql_str(s, limit=500)
    try:
        await asyncio.to_thread(_execute_sql, f"""
            INSERT INTO {WEBHOOKS_TABLE} VALUES (
                '{wid}', '{safe(body.name)}', '{safe(url)}', '{safe(body.event_types)}',
                true, '{safe(body.secret)}', '{safe(email)}', TIMESTAMP '{now}')
        """)
        return {"status": "ok", "webhook_id": wid}
    except HTTPException:
        raise
    except Exception:
        logger.exception("capability_closures: register_webhook failed")
        raise HTTPException(status_code=500, detail="Failed to register webhook")


@router.delete("/api/notifications/webhooks/{webhook_id}")
async def delete_webhook(request: Request, webhook_id: str):
    """Remove a webhook. Admin-gated."""
    from backend.main import _get_user_info
    _, is_admin = _get_user_info(request)
    if not is_admin:
        raise HTTPException(status_code=403, detail="Admin required")
    try:
        await asyncio.to_thread(_execute_sql,
            f"DELETE FROM {WEBHOOKS_TABLE} WHERE webhook_id = '{sql_str(webhook_id, limit=100)}'")
        return {"status": "ok"}
    except Exception:
        logger.exception("capability_closures: delete_webhook failed")
        raise HTTPException(status_code=500, detail="Failed to delete webhook.")


@router.post("/api/notifications/enqueue-delivery")
async def enqueue_delivery(request: Request):
    """Queue unread notifications for webhook delivery. Admin-gated.

    Matches notifications against registered webhooks by event_type,
    creates delivery queue entries. A separate Databricks job polls the
    queue and performs the actual HTTP POST delivery (decoupled for security).

    A2 FIX: this is a write that causes outbound HTTP from the delivery job, and
    it was the only ungated mutation among the webhook endpoints (register and
    delete both require admin) — an anonymous caller could flood every registered
    endpoint with notification traffic.
    """
    require_admin(request)
    _ensure_webhook_tables()
    NOTIF_TABLE = f"{LINEAGE_CATALOG}.{LINEAGE_SCHEMA}.notifications"
    try:
        notifications = await asyncio.to_thread(_execute_sql,
            f"SELECT * FROM {NOTIF_TABLE} WHERE is_read = false ORDER BY detected_at DESC LIMIT 50")
        webhooks = await asyncio.to_thread(_execute_sql,
            f"SELECT * FROM {WEBHOOKS_TABLE} WHERE enabled = true")
        if not notifications or not webhooks:
            return {"status": "ok", "queued": 0}

        queued = 0
        now = datetime.now(timezone.utc).isoformat()
        for wh in webhooks:
            types = (wh.get("event_types", "") or "*").split(",")
            url = wh.get("url", "")
            wh_id = wh.get("webhook_id", "")
            for n in notifications:
                if "*" not in types and n.get("notif_type", "") not in types:
                    continue
                payload = sql_str(json.dumps({
                    "type": n.get("notif_type"), "severity": n.get("severity"),
                    "title": n.get("title"), "detail": n.get("detail"),
                    "table_fqn": n.get("table_fqn"), "detected_at": str(n.get("detected_at", "")),
                }), limit=4000)
                did = str(uuid.uuid4())
                _execute_sql(f"""
                    INSERT INTO {DELIVERY_QUEUE_TABLE} VALUES (
                        '{did}', '{sql_str(wh_id)}', '{sql_str(url)}',
                        '{payload}', 'pending', TIMESTAMP '{now}', NULL)
                """)
                queued += 1

        return {"status": "ok", "queued": queued}
    except Exception:
        logger.exception("capability_closures: enqueue_delivery failed")
        raise HTTPException(status_code=500, detail="Failed to enqueue delivery.")


@router.get("/api/notifications/delivery-status")
async def delivery_status(request: Request, limit: int = Query(20)):
    """Check webhook delivery queue status (pending/delivered/failed)."""
    _ensure_webhook_tables()
    try:
        rows = await asyncio.to_thread(_execute_sql, f"""
            SELECT delivery_id, webhook_id, status, queued_at, delivered_at
            FROM {DELIVERY_QUEUE_TABLE}
            ORDER BY queued_at DESC LIMIT {limit}
        """)
        pending = sum(1 for r in rows if r.get("status") == "pending")
        return {"deliveries": rows, "pending": pending, "total": len(rows)}
    except Exception:
        logger.exception("capability_closures: delivery_status failed")
        raise HTTPException(status_code=500, detail="Failed to delivery status.")
