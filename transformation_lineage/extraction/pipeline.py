"""End-to-end extraction phase: discovery → resolve → fetch → normalize → persist-ready artifacts.

Cost optimizations:
  - Concurrent API calls via ThreadPoolExecutor (configurable parallelism)
  - Eliminates per-run sleep in favor of rate-limited thread pool
  - Path-keyed deduplication avoids redundant fetches
"""

from __future__ import annotations

import hashlib
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Callable, Optional, Tuple

from databricks.sdk import WorkspaceClient
from pyspark.sql import SparkSession

from transformation_lineage.config import LineageJobConfig
from transformation_lineage.extraction.discovery import (
    discover_lineage_runs,
    distinct_notebook_entities,
    distinct_pipeline_entities,
    distinct_run_ids,
)
from transformation_lineage.extraction.fetcher import fetch_resolved_source, fetch_workspace_source
from transformation_lineage.extraction.normalize import cells_to_json, normalize_to_cells
from transformation_lineage.extraction.reporting import DailyExtractionReport, merge_skip_reason
from transformation_lineage.extraction.resolver import resolve_pipeline_libraries, resolve_run_tasks
from transformation_lineage.extraction.workspace_clients import (
    REGISTRY_TABLE_NAME,
    PeerUnavailable,
    WorkspaceClientProvider,
    resolve_local_workspace_id,
)
from transformation_lineage.types import ExtractedArtifact

logger = logging.getLogger(__name__)

# Max parallel API calls (balances throughput vs. rate-limit risk)
_DEFAULT_CONCURRENCY = 16


def _stable_extraction_id(run_id: int, task_key: str | None, path_tag: str) -> str:
    """Path-keyed id so the same notebook discovered through multiple
    JOB/NOTEBOOK entity_runs collapses to ONE artifact (instead of N).
    """
    h = hashlib.sha256(path_tag.encode()).hexdigest()[:24]
    return f"ext_{h}"


def _default_language_for_path(path: str | None) -> str:
    if not path:
        return "python"
    pl = path.lower()
    if pl.endswith(".sql"):
        return "sql"
    return "python"


def _language_from_source(raw: str) -> str | None:
    """Authoritative notebook language from the source-format header line.

    Databricks source-format notebooks encode the default language in the first
    line's comment marker: ``# Databricks notebook source`` (Python),
    ``-- Databricks notebook source`` (SQL), ``// Databricks notebook source``
    (Scala). Workspace notebook PATHS have no file extension, so path-based
    inference (`_infer_language_from_path` / `_default_language_for_path`) can't
    tell a SQL notebook from a Python one and defaults to Python — which then
    routes SQL notebooks to the PySpark parser and yields zero mappings. The
    header settles it. Returns None when there is no recognizable header (e.g. a
    raw git file), so the caller keeps its path/task-based guess.
    """
    if not raw:
        return None
    for line in raw.lstrip().splitlines():
        s = line.strip()
        if not s:
            continue
        low = s.lower()
        if "databricks notebook source" not in low:
            return None  # first real line isn't the header — don't guess
        if s.startswith("--"):
            return "sql"
        if s.startswith("//"):
            return "scala"
        if s.startswith("#"):
            return "python"
        return None
    return None


NotebookKey = Tuple[Optional[str], str]  # (workspace_id, notebook_id)


def _resolve_notebook_path(
    spark: SparkSession,
    notebook_id: str,
    lookback_days: int = 90,
    workspace_id: str | None = None,
) -> str | None:
    """Resolve a single notebook entity_id to its workspace path via the audit log."""
    key = (workspace_id, str(notebook_id))
    return _resolve_notebook_paths_batch(spark, [key], lookback_days).get(key)


def _scan_audit_for_paths(
    spark: SparkSession, keys: list[NotebookKey], lookback_days: int
) -> dict[NotebookKey, str | None]:
    """One grouped scan of system.access.audit to map (workspace, notebookId) -> path.

    The audit table is account-wide and notebook ids are only unique per
    workspace, so the path is taken from an audit row in the SAME workspace as
    the lineage event. Keys with no workspace_id fall back to any workspace.

    Prunes on the `event_date` partition column; without a date predicate Spark
    scans the entire audit history (observed ~190s+).
    """
    found: dict[NotebookKey, str | None] = {}
    if not keys:
        return found
    from pyspark.sql import functions as F

    ids = sorted({nid for _, nid in keys})
    df = (
        spark.table("system.access.audit")
        .where(F.col("event_date") >= F.date_sub(F.current_date(), lookback_days))
        .where(F.col("request_params").getItem("notebookId").isin(ids))
        .where(F.col("request_params").getItem("path").isNotNull())
        .groupBy(
            F.col("workspace_id").cast("string").alias("wid"),
            F.col("request_params").getItem("notebookId").alias("nb_id"),
        )
        .agg(F.first(F.col("request_params").getItem("path"), ignorenulls=True).alias("nb_path"))
    )
    by_ws: dict[NotebookKey, str | None] = {}
    any_ws: dict[str, str | None] = {}
    for row in df.collect():
        if row["nb_id"] is None:
            continue
        nid = str(row["nb_id"])
        by_ws[(str(row["wid"]) if row["wid"] is not None else None, nid)] = row["nb_path"]
        any_ws.setdefault(nid, row["nb_path"])
    for wid, nid in keys:
        path = by_ws.get((wid, nid)) if wid else any_ws.get(nid)
        if path:
            found[(wid, nid)] = path
    return found


def _resolve_notebook_paths_batch(
    spark: SparkSession,
    notebook_keys: list[NotebookKey],
    lookback_days: int = 90,
    cache_table: str | None = None,
) -> dict[NotebookKey, str | None]:
    """Resolve (workspace_id, notebook entity_id) -> workspace path, audit-log scan cached in Delta.

    Resolution is expensive (a grouped scan of the large system.access.audit table).
    When `cache_table` is provided, previously-resolved keys are served from the cache
    and only cache-misses trigger the audit scan; new resolutions are written back so
    the cost is paid once per notebook across all pipeline runs. Cache rows written
    before the cache carried `workspace_id` (NULL) are never served.
    """
    keys: list[NotebookKey] = [
        (str(w) if w else None, str(n)) for w, n in notebook_keys
    ]
    result: dict[NotebookKey, str | None] = {k: None for k in keys}
    if not keys:
        return result

    # 1) Serve hits from the cache.
    cached: dict[NotebookKey, str | None] = {}
    if cache_table:
        try:
            from pyspark.sql import functions as F

            rows = (
                spark.table(cache_table)
                .where(F.col("notebook_id").isin(sorted({n for _, n in keys})))
                .where(F.col("workspace_id").isNotNull())
                .select("workspace_id", "notebook_id", "nb_path")
                .collect()
            )
            cached = {
                (str(r["workspace_id"]), str(r["notebook_id"])): r["nb_path"] for r in rows
            }
        except Exception as e:
            logger.warning("notebook path cache read failed: %s", e)
    result.update({k: v for k, v in cached.items() if k in result})

    # 2) Scan the audit log only for cache-misses.
    missing = [k for k in keys if k not in cached]
    if not missing:
        return result
    try:
        found = _scan_audit_for_paths(spark, missing, lookback_days)
    except Exception as e:
        logger.warning("Batch audit log lookup failed for %d notebooks: %s", len(missing), e)
        found = {}
    for k, v in found.items():
        if k in result:
            result[k] = v

    # 3) Write newly-resolved (non-null) paths back to the cache. Keys without a
    #    workspace_id aren't cached — they couldn't be served back safely.
    if cache_table and found:
        try:
            from datetime import datetime, timezone

            now = datetime.now(timezone.utc)
            new_rows = [
                {"notebook_id": n, "nb_path": v, "resolved_at": now, "workspace_id": w}
                for (w, n), v in found.items()
                if v and w
            ]
            if new_rows:
                (
                    spark.createDataFrame(new_rows)
                    .select("notebook_id", "nb_path", "resolved_at", "workspace_id")
                    .write.format("delta").mode("append").saveAsTable(cache_table)
                )
        except Exception as e:
            logger.warning("notebook path cache write failed: %s", e)
    return result


def _safe_int(value: str) -> int | None:
    """Safely convert string to int, returning None for non-numeric values."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _process_single_run(
    client: WorkspaceClient,
    run_id: int,
    cfg: LineageJobConfig,
    id_scope: str = "",
) -> list[ExtractedArtifact]:
    """Resolve + fetch + normalize a single job run. Thread-safe.

    `id_scope` namespaces the extraction id for a peer workspace (see `_ws_scope`).
    """
    artifacts: list[ExtractedArtifact] = []
    try:
        tasks = resolve_run_tasks(client, run_id)
    except Exception as e:
        logger.warning("resolve_run_tasks failed run_id=%s: %s", run_id, e)
        return []

    if not tasks:
        return []

    for t in tasks:
        lang_hint = t.language or _default_language_for_path(t.workspace_path or t.git_path)

        raw, prov = fetch_resolved_source(client, t, git_http_token=cfg.git_http_token)
        if not raw.strip():
            continue

        # The notebook source header is authoritative and beats the path-based
        # guess (a workspace notebook path has no extension, so a SQL notebook
        # would otherwise be mis-detected as Python and skip the SQL parser).
        lang_hint = _language_from_source(raw) or lang_hint
        if lang_hint not in ("sql", "python"):
            continue

        cells = normalize_to_cells(raw, lang_hint)
        norm_json = cells_to_json(cells)
        eid = _stable_extraction_id(run_id, t.task_key, id_scope + prov)
        path = t.workspace_path or t.git_path
        artifacts.append(
            ExtractedArtifact(
                extraction_id=eid,
                run_id=run_id,
                job_id=t.job_id,
                task_key=t.task_key,
                source_kind=t.source_kind,
                source_path=path,
                git_commit=t.git_commit,
                raw_source=raw,
                normalized_cells_json=norm_json,
                language=lang_hint,
                extracted_at=datetime.now(timezone.utc),
            )
        )
    return artifacts


def _extract_object_definitions(
    spark: SparkSession, cfg: LineageJobConfig, report: DailyExtractionReport
) -> list[ExtractedArtifact]:
    """Definition-based extraction for declarative objects.

    For KPI targets that are VIEWs / MATERIALIZED VIEWs / STREAMING TABLEs, read
    the object's own ``SHOW CREATE TABLE`` DDL and treat it as a SQL artifact —
    bypassing discovery, producing-run resolution, and the system-table lineage
    lag entirely. This is how MV / streaming-table / SQL-defined-DLT column
    transformation lineage is captured.

    Tables whose source lives outside this metastore (Lakehouse Federation =
    table_type FOREIGN; Delta Sharing = a shared/foreign catalog) have NO local
    producing code, so they are recorded as an ``external_source`` skip reason
    instead of producing a (misleading) empty success.
    """
    artifacts: list[ExtractedArtifact] = []
    for fqn in cfg.kpi_tables:
        parts = fqn.split(".")
        if len(parts) != 3:
            continue
        cat, sch, name = (p.replace("`", "") for p in parts)
        ttype = None
        try:
            # Per-catalog information_schema (accessible with USE CATALOG), not
            # system.information_schema (which the app SP may lack access to).
            rows = spark.sql(
                f"SELECT table_type FROM `{cat}`.information_schema.tables "
                f"WHERE table_schema='{sch}' AND table_name='{name}'"
            ).collect()
            if rows:
                ttype = (rows[0]["table_type"] or "").upper()
        except Exception as e:  # noqa: BLE001
            logger.warning("information_schema lookup failed for %s: %s", fqn, e)

        if ttype == "FOREIGN":
            # Lakehouse Federation / Delta Sharing — producing logic is external.
            merge_skip_reason(report, "external_source")
            continue
        if ttype not in ("VIEW", "MATERIALIZED_VIEW", "STREAMING_TABLE"):
            # Plain managed/external table — no embedded definition; rely on the
            # discovery + job/notebook/pipeline resolution paths instead.
            continue

        try:
            ddl_rows = spark.sql(f"SHOW CREATE TABLE {fqn}").collect()
            ddl = "\n".join(r[0] for r in ddl_rows if r and r[0])
        except Exception as e:  # noqa: BLE001
            logger.warning("SHOW CREATE TABLE failed for %s: %s", fqn, e)
            merge_skip_reason(report, "definition_unreadable")
            continue
        if not ddl.strip():
            continue

        cells = normalize_to_cells(ddl, "sql")
        norm_json = cells_to_json(cells)
        eid = _stable_extraction_id(0, None, f"definition:{fqn}")
        artifacts.append(
            ExtractedArtifact(
                extraction_id=eid,
                run_id=0,
                job_id=None,
                task_key=None,
                source_kind="object_definition",
                source_path=fqn,
                git_commit=None,
                raw_source=ddl,
                normalized_cells_json=norm_json,
                language="sql",
                extracted_at=datetime.now(timezone.utc),
            )
        )
        report.artifacts_extracted += 1
        report.by_source_kind["object_definition"] = (
            report.by_source_kind.get("object_definition", 0) + 1
        )
    if artifacts:
        logger.info("Definition-based extraction produced %d artifact(s)", len(artifacts))
    return artifacts


def _extract_from_query_history(
    spark: SparkSession,
    cfg: LineageJobConfig,
    report: DailyExtractionReport,
    skip_fqns: set[str],
) -> list[ExtractedArtifact]:
    """Fallback extraction from `system.query.history` for KPI tables with no
    discoverable producing entity.

    Many tables are produced by ad-hoc SQL (SQL editor, notebooks not captured as
    a tracked entity, scripts). Their `system.access.column_lineage` rows have
    ``entity_type = NULL``, so discovery (which filters to JOB/NOTEBOOK/PIPELINE)
    never finds them and no transformation lineage is built. The defining SQL,
    however, is recorded verbatim in query history — we recover the most recent
    FINISHED write statement (CTAS / INSERT / MERGE / CREATE-OR-REPLACE) whose
    parsed output target equals the KPI table, and parse that.

    `skip_fqns` are tables already covered by the definition or entity paths.
    """
    from transformation_lineage.parsing.sql_parser import extract_output_table

    targets = [t for t in cfg.kpi_tables if t not in skip_fqns and len(t.split(".")) == 3]
    if not targets:
        return []

    artifacts: list[ExtractedArtifact] = []
    lookback_hours = max(int(cfg.discovery_lookback_hours), 24)
    # Non-write statement types we never want to treat as a producer.
    _NON_WRITE = (
        "SELECT", "USE", "SET", "SHOW", "DESCRIBE", "DROP", "ALTER", "GRANT",
        "REVOKE", "OPTIMIZE", "VACUUM", "ANALYZE", "EXPLAIN", "REFRESH", "COMMENT",
        "TRUNCATE", "DELETE", "UPDATE",
    )
    for fqn in targets:
        cat, sch, name = (p.replace("`", "") for p in fqn.split("."))
        safe_name = name.replace("'", "''")
        try:
            rows = spark.sql(
                f"""
                SELECT statement_text
                FROM system.query.history
                WHERE execution_status = 'FINISHED'
                  AND start_time >= current_timestamp() - INTERVAL {lookback_hours} HOURS
                  AND statement_text ILIKE '%{safe_name}%'
                  AND statement_type NOT IN ({', '.join(f"'{t}'" for t in _NON_WRITE)})
                ORDER BY start_time DESC
                LIMIT 40
                """
            ).collect()
        except Exception as e:  # noqa: BLE001
            logger.warning("query.history lookup failed for %s: %s", fqn, e)
            merge_skip_reason(report, "query_history_unavailable")
            continue

        chosen: str | None = None
        for r in rows:
            stmt = r["statement_text"] or ""
            out = extract_output_table(stmt, default_catalog=cat, default_schema=sch)
            if out and out.replace("`", "") == fqn:
                chosen = stmt
                break
        if not chosen:
            merge_skip_reason(report, "no_producing_query")
            continue

        cells = normalize_to_cells(chosen, "sql")
        eid = _stable_extraction_id(0, None, f"query_history:{fqn}")
        artifacts.append(
            ExtractedArtifact(
                extraction_id=eid,
                run_id=0,
                job_id=None,
                task_key=None,
                source_kind="query_history",
                source_path=fqn,
                git_commit=None,
                raw_source=chosen,
                normalized_cells_json=cells_to_json(cells),
                language="sql",
                extracted_at=datetime.now(timezone.utc),
            )
        )
        report.artifacts_extracted += 1
        report.by_source_kind["query_history"] = report.by_source_kind.get("query_history", 0) + 1

    if artifacts:
        logger.info("Query-history extraction produced %d artifact(s)", len(artifacts))
    return artifacts


def run_extraction_phase(
    spark: SparkSession,
    cfg: LineageJobConfig,
    *,
    workspace_client_factory: Callable[[], WorkspaceClient] | None = None,
    client_provider: WorkspaceClientProvider | None = None,
    max_concurrency: int = _DEFAULT_CONCURRENCY,
    notebook_path_cache_table: str | None = None,
) -> tuple[list[ExtractedArtifact], DailyExtractionReport]:
    """
    Discover runs from system lineage, fetch code per task, return artifacts + daily report.

    Discovery is metastore-wide, so each producer is read through a client for
    the workspace it ran in (`client_provider`). Producers in a workspace with no
    usable client are skipped with a skip reason rather than read locally.

    Uses ThreadPoolExecutor for parallel API calls (configurable via max_concurrency).
    """
    report = DailyExtractionReport(execution_ts=datetime.now(timezone.utc))
    if not cfg.databricks_host or not cfg.databricks_token:
        raise ValueError("databricks_host and databricks_token are required for extraction")

    def _client() -> WorkspaceClient:
        if workspace_client_factory:
            return workspace_client_factory()
        return WorkspaceClient(host=cfg.databricks_host, token=cfg.databricks_token)

    client = _client()
    provider = client_provider or WorkspaceClientProvider(
        client,
        resolve_local_workspace_id(client, spark),
        spark=spark,
        registry_table=cfg.fully_qualified(REGISTRY_TABLE_NAME),
        enabled=cfg.cross_workspace_fetch,
    )

    def _ws_scope(workspace_id: str | None) -> str:
        """Extraction-id prefix: the same path in two workspaces is two artifacts.
        Empty for the local workspace so existing ids are unchanged."""
        return "" if provider.is_local(workspace_id) else f"ws:{workspace_id}:"

    def _client_for(workspace_id: str | None, what: str) -> WorkspaceClient | None:
        """Client for a producer's workspace, or None (skip reason recorded)."""
        try:
            return provider.get(workspace_id)
        except PeerUnavailable as e:
            logger.warning("Skipping %s (workspace %s): %s", what, workspace_id, e)
            merge_skip_reason(report, e.reason)
            return None

    _t = time.time()
    disc = discover_lineage_runs(
        spark,
        kpi_tables=cfg.kpi_tables,
        lookback_hours=cfg.discovery_lookback_hours,
        entity_types=cfg.lineage_entity_types,
    )
    report.runs_discovered = disc.select("entity_run_id").distinct().count()
    run_ids = distinct_run_ids(disc)
    report.timings["discover"] = round(time.time() - _t, 1)
    if cfg.max_runs_per_execution:
        run_ids = run_ids[: cfg.max_runs_per_execution]

    artifacts: list[ExtractedArtifact] = []

    # ── Definition-based extraction (views / MV / streaming tables) ──
    # Runs first and independently of discovery — covers declarative objects and
    # flags external (federated/shared) sources. No lineage lag.
    defn_artifacts = _extract_object_definitions(spark, cfg, report)
    artifacts.extend(defn_artifacts)
    defn_covered = {a.source_path for a in defn_artifacts if a.source_path}
    # Targets that DID resolve to a tracked producing entity (JOB/NOTEBOOK/PIPELINE).
    try:
        entity_covered = {
            r["target_table_full_name"]
            for r in disc.select("target_table_full_name").distinct().collect()
            if r["target_table_full_name"]
        }
    except Exception:  # noqa: BLE001
        entity_covered = set()

    # ── JOB entity extraction (CONCURRENT) ─────────────────────────
    logger.info("Processing %d job runs with concurrency=%d", len(run_ids), max_concurrency)
    report.runs_attempted += len(run_ids)

    _t = time.time()
    with ThreadPoolExecutor(max_workers=max_concurrency) as pool:
        futures = {}
        for wid, rid in run_ids:
            run_client = _client_for(wid, f"job run {rid}")
            if run_client is not None:
                futures[pool.submit(
                    _process_single_run, run_client, rid, cfg, _ws_scope(wid)
                )] = rid
        for future in as_completed(futures):
            rid = futures[future]
            try:
                run_artifacts = future.result()
                artifacts.extend(run_artifacts)
                for a in run_artifacts:
                    report.artifacts_extracted += 1
                    report.by_source_kind[a.source_kind] = (
                        report.by_source_kind.get(a.source_kind, 0) + 1
                    )
                if not run_artifacts:
                    merge_skip_reason(report, "no_resolvable_tasks")
            except Exception as e:
                logger.warning("Run %s failed: %s", rid, e)
                report.errors.append(f"resolve_run_tasks:{rid}:{e}")
                merge_skip_reason(report, "resolve_error")

    report.timings["job_fetch"] = round(time.time() - _t, 1)

    # ── NOTEBOOK entity extraction (CONCURRENT) ─────────────────────
    notebook_ids = distinct_notebook_entities(disc)
    logger.info("Processing %d notebook entities with concurrency=%d",
                len(notebook_ids), max_concurrency)

    # Pre-resolve all notebook paths (uses Spark, on driver). Cached in Delta so the
    # expensive audit-log scan is paid once per notebook; only cache-misses are scanned.
    _t = time.time()
    audit_lookback_days = max(1, (cfg.discovery_lookback_hours + 23) // 24) + 7
    nb_paths: dict[NotebookKey, str | None] = _resolve_notebook_paths_batch(
        spark, list(notebook_ids),
        lookback_days=audit_lookback_days,
        cache_table=notebook_path_cache_table,
    )
    report.timings["notebook_resolve"] = round(time.time() - _t, 1)
    report.timings["notebook_count"] = len(notebook_ids)

    def _fetch_notebook(
        nb_client: WorkspaceClient, key: NotebookKey
    ) -> ExtractedArtifact | None:
        nb_id = key[1]
        nb_path = nb_paths.get(key)
        if not nb_path:
            return None
        lang_hint = _default_language_for_path(nb_path)
        try:
            raw = fetch_workspace_source(nb_client, nb_path)
        except Exception as e:
            logger.warning("fetch failed notebook=%s: %s", nb_path, e)
            return None
        if not raw.strip():
            return None
        cells = normalize_to_cells(raw, lang_hint)
        norm_json = cells_to_json(cells)
        numeric_id = _safe_int(nb_id)
        run_id_for_artifact = numeric_id if numeric_id is not None else hash(nb_id) & 0x7FFFFFFFFFFFFFFF
        eid = _stable_extraction_id(
            run_id_for_artifact, None, f"{_ws_scope(key[0])}workspace:{nb_path}"
        )
        return ExtractedArtifact(
            extraction_id=eid,
            run_id=run_id_for_artifact,
            job_id=None,
            task_key=None,
            source_kind="workspace_notebook",
            source_path=nb_path,
            git_commit=None,
            raw_source=raw,
            normalized_cells_json=norm_json,
            language=lang_hint,
            extracted_at=datetime.now(timezone.utc),
        )

    _t = time.time()
    with ThreadPoolExecutor(max_workers=max_concurrency) as pool:
        futures = {}
        for key in notebook_ids:
            report.runs_attempted += 1
            nb_client = _client_for(key[0], f"notebook {key[1]}")
            if nb_client is not None:
                futures[pool.submit(_fetch_notebook, nb_client, key)] = key[1]
        for future in as_completed(futures):
            nb_id = futures[future]
            try:
                result = future.result()
                if result:
                    artifacts.append(result)
                    report.artifacts_extracted += 1
                    report.by_source_kind["workspace_notebook"] = (
                        report.by_source_kind.get("workspace_notebook", 0) + 1
                    )
                else:
                    merge_skip_reason(report, "notebook_path_unresolved_or_empty")
            except Exception as e:
                report.errors.append(f"notebook_fetch:{nb_id}:{e}")
                merge_skip_reason(report, "notebook_fetch_error")
    report.timings["notebook_fetch"] = round(time.time() - _t, 1)

    # ── PIPELINE entity extraction (Lakeflow / DLT, CONCURRENT) ─────
    # Resolves each DLT pipeline to its source libraries and parses them. This
    # covers Python-defined DLT, whose logic is NOT in SHOW CREATE TABLE (so the
    # definition-based path above cannot see it).
    pipeline_ids = distinct_pipeline_entities(disc)
    if pipeline_ids:
        logger.info("Processing %d pipeline entities with concurrency=%d",
                    len(pipeline_ids), max_concurrency)

        def _fetch_pipeline(
            pl_client: WorkspaceClient, pid: str, id_scope: str
        ) -> list[ExtractedArtifact]:
            out: list[ExtractedArtifact] = []
            for src in resolve_pipeline_libraries(pl_client, pid):
                lang = src.language or _default_language_for_path(src.workspace_path or src.git_path)
                if lang not in ("sql", "python"):
                    continue
                try:
                    raw, prov = fetch_resolved_source(pl_client, src, git_http_token=cfg.git_http_token)
                except Exception as e:  # noqa: BLE001
                    logger.warning("pipeline library fetch failed pid=%s: %s", pid, e)
                    continue
                if not raw.strip():
                    continue
                cells = normalize_to_cells(raw, lang)
                eid = _stable_extraction_id(0, src.task_key, f"{id_scope}pipeline:{prov}")
                out.append(
                    ExtractedArtifact(
                        extraction_id=eid,
                        run_id=0,
                        job_id=None,
                        task_key=src.task_key,
                        source_kind="pipeline_library",
                        source_path=src.workspace_path or src.git_path,
                        git_commit=src.git_commit,
                        raw_source=raw,
                        normalized_cells_json=cells_to_json(cells),
                        language=lang,
                        extracted_at=datetime.now(timezone.utc),
                    )
                )
            return out

        _t = time.time()
        with ThreadPoolExecutor(max_workers=max_concurrency) as pool:
            futures = {}
            for wid, pid in pipeline_ids:
                report.runs_attempted += 1
                pl_client = _client_for(wid, f"pipeline {pid}")
                if pl_client is not None:
                    futures[pool.submit(_fetch_pipeline, pl_client, pid, _ws_scope(wid))] = pid
            for future in as_completed(futures):
                pid = futures[future]
                try:
                    res = future.result()
                    if res:
                        artifacts.extend(res)
                        for a in res:
                            report.artifacts_extracted += 1
                            report.by_source_kind[a.source_kind] = (
                                report.by_source_kind.get(a.source_kind, 0) + 1
                            )
                    else:
                        merge_skip_reason(report, "pipeline_no_libraries")
                except Exception as e:  # noqa: BLE001
                    report.errors.append(f"pipeline_fetch:{pid}:{e}")
                    merge_skip_reason(report, "pipeline_fetch_error")
        report.timings["pipeline_fetch"] = round(time.time() - _t, 1)

    # ── Query-history fallback (entity-less producers) ─────────────
    # KPI tables with no tracked producing entity and no embedded definition are
    # recovered from system.query.history (ad-hoc SQL / SQL editor / scripts).
    qh_artifacts = _extract_from_query_history(
        spark, cfg, report, skip_fqns=defn_covered | entity_covered
    )
    artifacts.extend(qh_artifacts)

    # Dedupe by extraction_id
    seen: set[str] = set()
    deduped: list[ExtractedArtifact] = []
    for a in artifacts:
        if a.extraction_id not in seen:
            seen.add(a.extraction_id)
            deduped.append(a)

    duplicates_dropped = len(artifacts) - len(deduped)
    if duplicates_dropped:
        logger.info("Deduped %d duplicate artifacts (kept %d unique)",
                    duplicates_dropped, len(deduped))
    return deduped, report


def new_extraction_id() -> str:
    """UUID when stable hash is not desired (tests)."""
    return f"ext_{uuid.uuid4().hex}"
