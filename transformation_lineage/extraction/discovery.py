"""Discover candidate job/notebook runs from Unity Catalog lineage system tables."""

from __future__ import annotations

import logging
from typing import Sequence

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from transformation_lineage.types import DiscoveredRun

logger = logging.getLogger(__name__)


def kpi_predicate_sql(kpi_tables: Sequence[str]) -> str:
    """Build SQL OR clause matching source or target fully-qualified table names."""
    parts: list[str] = []
    for t in kpi_tables:
        safe = t.replace("'", "''")
        parts.append(f"source_table_full_name = '{safe}'")
        parts.append(f"target_table_full_name = '{safe}'")
    return "(" + " OR ".join(parts) + ")" if parts else "(1=0)"


def discover_lineage_runs(
    spark: SparkSession,
    *,
    kpi_tables: Sequence[str],
    lookback_hours: int,
    entity_types: Sequence[str],
) -> DataFrame:
    """
    Return distinct run keys from `system.access.column_lineage` in the lookback window.

    Filters to rows where source or target table matches configured KPI tables.
    """
    if not kpi_tables:
        raise ValueError("kpi_tables must be non-empty for discovery")

    types_sql = ", ".join(f"'{et.replace(chr(39), chr(39)+chr(39))}'" for et in entity_types)
    kpi_sql = kpi_predicate_sql(kpi_tables)
    # Prune by the event_date partition column first (cheap partition elimination),
    # then refine with the exact event_time window. Without the event_date predicate
    # Spark scans the full history of this large system table.
    lookback_days = max(1, (int(lookback_hours) + 23) // 24)
    sql = f"""
    SELECT DISTINCT
      workspace_id,
      entity_type,
      entity_id,
      entity_run_id,
      source_table_full_name,
      target_table_full_name,
      source_column_name,
      target_column_name,
      event_time
    FROM system.access.column_lineage
    WHERE event_date >= date_sub(current_date(), {lookback_days})
      AND event_time >= current_timestamp() - INTERVAL {int(lookback_hours)} HOURS
      AND entity_type IN ({types_sql})
      AND entity_run_id IS NOT NULL
      AND {kpi_sql}
    """
    logger.info("Running lineage discovery query (lookback_hours=%s)", lookback_hours)
    return spark.sql(sql)


def dataframe_to_discovered_runs(df: DataFrame) -> list[DiscoveredRun]:
    rows = df.collect()
    out: list[DiscoveredRun] = []
    for r in rows:
        out.append(
            DiscoveredRun(
                workspace_id=r["workspace_id"],
                entity_type=r["entity_type"],
                entity_id=r["entity_id"],
                entity_run_id=r["entity_run_id"],
                source_table_full_name=r["source_table_full_name"],
                target_table_full_name=r["target_table_full_name"],
                source_column_name=r["source_column_name"],
                target_column_name=r["target_column_name"],
                event_time=r["event_time"],
            )
        )
    return out


def _wid(value) -> str | None:
    s = str(value).strip() if value is not None else ""
    return s or None


def distinct_run_ids(df: DataFrame) -> list[tuple[str | None, int]]:
    """Unique `(workspace_id, job run id)` pairs from discovery (entity_run_id).

    Run ids are only meaningful inside the workspace that ran them, so each is
    kept with its `workspace_id` for client selection. Uses try_cast so
    non-numeric IDs (e.g. NOTEBOOK UUIDs) become NULL and are filtered out
    instead of raising CAST_INVALID_INPUT.
    """
    rows = (
        df.select(
            F.col("workspace_id"),
            F.expr("try_cast(entity_run_id AS bigint)").alias("run_id"),
        )
        .where(F.col("run_id").isNotNull())
        .distinct()
        .collect()
    )
    return sorted(
        {(_wid(r["workspace_id"]), int(r["run_id"])) for r in rows},
        key=lambda p: (p[0] or "", p[1]),
    )


def _distinct_entities(df: DataFrame, entity_type: str) -> list[tuple[str | None, str]]:
    rows = (
        df.where(F.col("entity_type") == entity_type)
        .select(F.col("workspace_id"), F.col("entity_id"))
        .where(F.col("entity_id").isNotNull())
        .distinct()
        .collect()
    )
    return sorted(
        {(_wid(r["workspace_id"]), str(r["entity_id"])) for r in rows},
        key=lambda p: (p[0] or "", p[1]),
    )


def distinct_notebook_entities(df: DataFrame) -> list[tuple[str | None, str]]:
    """Unique `(workspace_id, notebook entity_id)` pairs from NOTEBOOK rows."""
    return _distinct_entities(df, "NOTEBOOK")


def distinct_pipeline_entities(df: DataFrame) -> list[tuple[str | None, str]]:
    """Unique `(workspace_id, pipeline_id)` pairs from PIPELINE rows.

    Lakeflow Declarative (DLT) pipelines attribute lineage with
    entity_type='PIPELINE' and entity_id=<pipeline_id>; these are resolved to
    their source libraries (notebooks/files) by the resolver.
    """
    return _distinct_entities(df, "PIPELINE")
