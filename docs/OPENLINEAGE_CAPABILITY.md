# BrickTrace — OpenLineage Interop Capability (Cap 17)

> **Status:** Phased. **Phase 1 (spec-compliant export) is implemented and
> shipped** (commit `35bb616`, branch `feature/phase0-workspace-id`).
> **Phase 2 (delivery + import round-trip) and Phase 3 (breadth: target
> presets, formats, scheduling, streaming) are NOT yet implemented** — they are
> specified here as the roadmap and are called out inline as **⏳ TO BE
> IMPLEMENTED**.
>
> This document is the source of truth for the OpenLineage capability. It
> supersedes the "full bidirectional / endpoints deliver" claim in
> `docs/capability_code_map.md`, which describes the *intended* end-state, not
> the delivered one (see [§8 Current gaps](#8-current-gaps-honest-state)).

---

## 1. What this capability is for

Everywhere else, BrickTrace answers *"where does this data come from?"* against
Unity Catalog. **OpenLineage interop** lets that lineage leave (and enter) the
tool in a **vendor-neutral standard** so it reconciles with the rest of an
organisation's data-catalog estate — Marquez, DataHub, Atlan, OpenMetadata, and
any [OpenLineage](https://openlineage.io)-compatible consumer.

Two directions:

- **Export** — turn the UC lineage graph into canonical OpenLineage RunEvents
  that downstream catalogs ingest.
- **Import / ingest** — accept OpenLineage RunEvents emitted by *other*
  platforms and surface them as edges in the BrickTrace graph.

The bar is **conformance**: events must match the OpenLineage 2.0.2 spec and its
naming conventions, or consumers reject them or — worse — silently create
duplicate datasets.

**Spec:** <https://openlineage.io/spec/2-0-2/OpenLineage.json> ·
**Naming:** <https://openlineage.io/docs/spec/naming>

---

## 2. Architecture at a glance

OpenLineage interop spans three planes; each is a separate concern with its own
code path.

| Plane | Direction | Code | State |
| --- | --- | --- | --- |
| **Export** | BrickTrace → OL JSON | `backend/openlineage_builder.py`, `routes/openlineage.py::export_openlineage` | ✅ Phase 1 |
| **Import (paste/upload)** | OL JSON → BrickTrace | `routes/openlineage.py::import_openlineage` | ⚠️ stub (stores, never re-reads) |
| **Producer (push out)** | BrickTrace → external endpoint | `routes/openlineage.py::configure_producer` / `produce_events` | ⚠️ stub (queues, never delivers) |
| **OL bridge (push in)** | external platform → BrickTrace | `routes/external_sources.py` (ol-bridge, Cap 05) | separate capability |

The **builder module** (`openlineage_builder.py`) is the shared, pure heart:
dependency-free, side-effect-free functions that shape and validate OpenLineage
JSON. It has no warehouse or SDK imports, so it is fully unit-testable
(`tests/test_openlineage_builder.py`). Route code pulls data from UC + the
lineage graph and hands it to the builder.

---

## 3. Phase 1 — Spec-compliant export ✅ IMPLEMENTED

### 3.1 Why it was needed

The previous inline exporter was not spec-conformant:

- Emitted a **non-canonical namespace** `databricks://<catalog>.<schema>`, so
  consumers could not reconcile datasets against their canonical UC identity.
- **Faked every column type as `STRING`** in the schema facet.
- Carried **no column-level lineage** — the single most important facet for
  field-level consumers.
- Used non-UUID run ids (`job-123`) that fail schema validation.

### 3.2 What Phase 1 delivers

**Canonical naming** (`openlineage_builder.dataset_namespace`)
- Namespace: `databricks://<workspace-host>` (host from
  `_get_client().config.host`; falls back to `databricks://unity-catalog`).
- Dataset name: the **fully-qualified** `catalog.schema.table`.
- Result: consumers dedupe datasets by `(namespace, name)` correctly.

**Full dataset facets** (`build_dataset`)

| Facet | Source | Notes |
| --- | --- | --- |
| `schema` (`SchemaDatasetFacet`) | UC table node `columns` (real name + type) | `NOT NULL` folded into field `description` |
| `columnLineage` (`ColumnLineageDatasetFacet`) | `get_schema_column_lineage` edges | field-to-field `inputFields`; `transformationType: INDIRECT` when the expression kind is unknown |
| `documentation` (`DocumentationDatasetFacet`) | UC table comment | |
| `ownership` (`OwnershipDatasetFacet`) | UC table owner | |
| `symlinks` (`SymlinksDatasetFacet`) | fully-qualified UC name | `type: TABLE` |
| `dataSource` (`DatasourceDatasetFacet`) | namespace + fqn | |
| `dataQualityRules` (**custom**) | app `dq_rules` table | opt-in; custom facet because standard `dataQualityAssertions` requires a boolean `success` per assertion we don't have at export time |

**Job + run facets**
- `jobType` (`JobTypeJobFacet`) — `BATCH` / `DATABRICKS` / entity type.
- `nominalTime` (`NominalTimeRunFacet`) — from the entity's last run time.
- Stable **UUIDv5** run ids (`deterministic_run_id(job, event_time)`) so
  re-exporting the same logical run is idempotent.

> **Note — builders ready but not yet emitted by the export route:**
> `sql_job_facet`, `source_code_facet`, `documentation_job_facet`, and
> `error_message_run_facet` exist and are unit-tested, but `export_openlineage`
> does not yet populate them (it would need to fetch producer SQL/source per
> entity). Wiring these in is a small Phase 2 follow-on.

**Conformance validation** (`validate_event` / `validate_events`)
- Structural check: valid `eventType`, present `eventTime`/`producer`/
  `schemaURL`, UUID `run.runId`, `job.namespace`/`name`, and every input/output
  dataset carries `namespace` + `name`.
- Returns human-readable issues; `validate_events` gives a batch summary
  `{valid, event_count, invalid_count, issues[]}` (capped at 50 issues).
- Not a full JSON-Schema pass — deliberately, to avoid bundling the 2.0.2 schema
  + a validator lib; the structural check is enough to trust an export or reject
  a bad import.

### 3.3 API — `GET /api/export/openlineage`

| Param | Default | Meaning |
| --- | --- | --- |
| `catalog` | *(required)* | Export scope catalog |
| `schema` | — | Optional schema scope (required for column lineage) |
| `include_schema` | `true` | Emit `SchemaDatasetFacet` |
| `include_column_lineage` | `true` | Emit `ColumnLineageDatasetFacet` |
| `include_ownership` | `true` | Emit `OwnershipDatasetFacet` |
| `include_docs` | `true` | Emit `DocumentationDatasetFacet` |
| `include_data_quality` | `false` | Emit custom DQ-rules facet (extra query) |
| `event_type` | `COMPLETE` | Run event type (validated against the OL enum) |
| `format` | `json` | `json` (wrapper + conformance report) or `ndjson` (one event/line — the ingestion-client shape) |
| `include_columns` | `false` | Back-compat alias that also turns column lineage on |

**Event model:** one RunEvent per *(producing entity → output table)*. The
entity's input tables become OpenLineage `inputs`; the output table becomes the
`output`, enriched with the dataset facets above.

**`format=json` response:**
```json
{
  "events": [ /* OpenLineage RunEvents */ ],
  "count": 12,
  "namespace": "databricks://myws.cloud.databricks.com",
  "schemaURL": "https://openlineage.io/spec/2-0-2/OpenLineage.json",
  "conformance": { "valid": true, "event_count": 12, "invalid_count": 0, "issues": [] },
  "byte_size": 48213
}
```
**`format=ndjson` response:** `application/x-ndjson`, one event per line, as a
file download.

### 3.4 UI — `ExportPanel.tsx` (OpenLineage Export tab)

- Brand-token layout (matches Reports / Glossary).
- **Facet toggle grid** — Schema, Column lineage, Ownership, Documentation, Data
  quality — so users choose payload richness.
- **Format picker** — JSON / ND-JSON.
- **Live Preview** — event count, payload size (KB), the resolved namespace, a
  **conformance badge** (green "OpenLineage 2.0.2 conformant" / amber with the
  issue list), and a pretty-printed sample event.
- **Copy** and **Export/Download** actions.
- The **Import** tab (admin-only) and **Graph Snapshots** tab live alongside.

### 3.5 Tests
- `tests/test_openlineage_builder.py` — namespace, run-id determinism, each
  facet, event shape, conformance validator (unit).
- `tests/test_routes_openlineage_full.py` / `test_routes_openlineage.py` —
  route behaviour incl. canonical names + `columnLineage` facet + conformance.
- `frontend/src/components/ExportPanel.test.tsx` — facet passthrough, preview,
  conformance badge, ND-JSON export, import/snapshot flows.

---

## 4. Phase 2 — Delivery + import round-trip ⏳ TO BE IMPLEMENTED

Phase 1 makes the *output* correct. Phase 2 makes lineage actually **move**, in
both directions, and closes the two stubs documented in [§8](#8-current-gaps-honest-state).

### 4.1 Real producer delivery
- **Delivery worker** that drains `openlineage_producer_queue`: HTTP `POST`
  each pending event to the registered endpoint(s), mark `delivered` / `failed`,
  record `error_message`.
- **Auth** via the secret refs already stored by `configure_producer`
  (`api_key_secret_scope` / `api_key_secret_key`); the config endpoint already
  enforces `https://` + host and redacts URLs on read.
- **Retry with backoff** + a **dead-letter** state for permanently-failed events.
- **Background loop** in `backend/main.py` lifespan, mirroring the existing
  notification auto-scan (interval + initial-delay env vars, cancel on shutdown).

### 4.2 Import round-trip (make ingest surface)
- Currently `import_openlineage` writes to `external_lineage_events` and
  **nothing reads it back** — imported lineage never appears in the graph.
- Phase 2: read those events back into the trace as **external edges** (tagged
  as externally-sourced, distinct from UC-derived edges), validated on the way
  in with `validate_events`, and **idempotent** (upsert by `runId` / dataset).
- File **drag-and-drop** + multi-file / ND-JSON import (not just paste).

### 4.3 Canonicalise the producer path
- `produce_events` still uses the **legacy** helpers
  `_table_to_openlineage_dataset` / `_build_openlineage_run_event` (non-canonical
  namespace, no facets). Repoint them at `openlineage_builder` so produced and
  exported events are identical in shape.
- Emit `sql` / `sourceCode` / `documentation` job facets and `errorMessage` on
  `FAIL` (Phase 1 builders are ready).
- Full run lifecycle: `START` → `COMPLETE` / `FAIL`, with `parent` run facets for
  pipeline hierarchies.

### 4.4 UI
- **Endpoint manager** — register / edit / **test-connection** for endpoints
  (Marquez, Atlan, DataHub…).
- **Delivery monitor** — pending / delivered / failed counts with per-event
  errors and a **retry** action (backed by `GET /api/openlineage/producer/events`).

---

## 5. Phase 3 — Breadth ⏳ TO BE IMPLEMENTED

- **Target presets** — Marquez / DataHub (MCE/MCP) / Atlan / OpenMetadata, each
  adjusting namespace + payload shape + delivery format for best fidelity.
- **Additional export formats** — CSV edge list, **GraphML / DOT** (Graphviz /
  Gephi), and raw graph JSON, for teams not on OpenLineage.
- **Scheduled / continuous export** — a background loop emitting OL events for
  new writes on an interval (configurable lookback + schedule), reusing the
  producer pipeline.
- **Kafka transport** — OpenLineage's Kafka client for event-streaming shops.
- **Static (dataset-only) lineage events** for catalogs that consume dataset
  facets without a run context.

---

## 6. Facet reference (implemented in Phase 1)

| OpenLineage facet | Kind | Builder fn | Emitted by export route |
| --- | --- | --- | --- |
| `SchemaDatasetFacet` | dataset | `schema_facet` | ✅ |
| `ColumnLineageDatasetFacet` | dataset | `column_lineage_facet` | ✅ |
| `DocumentationDatasetFacet` | dataset | `documentation_facet` | ✅ |
| `OwnershipDatasetFacet` | dataset | `ownership_facet` | ✅ |
| `SymlinksDatasetFacet` | dataset | `symlinks_facet` | ✅ |
| `DatasourceDatasetFacet` | dataset | `datasource_facet` | ✅ |
| `DataQualityRules` (custom) | dataset | `data_quality_rules_facet` | ✅ (opt-in) |
| `JobTypeJobFacet` | job | `job_type_facet` | ✅ |
| `NominalTimeRunFacet` | run | `nominal_time_run_facet` | ✅ |
| `SQLJobFacet` | job | `sql_job_facet` | ⏳ builder ready, not wired |
| `SourceCodeJobFacet` | job | `source_code_facet` | ⏳ builder ready, not wired |
| `DocumentationJobFacet` | job | `documentation_job_facet` | ⏳ builder ready, not wired |
| `ErrorMessageRunFacet` | run | `error_message_run_facet` | ⏳ builder ready, not wired |

---

## 7. Data-source mapping

| OpenLineage element | BrickTrace source |
| --- | --- |
| Dataset namespace | `_get_client().config.host` (workspace host) |
| Dataset name | UC fully-qualified `catalog.schema.table` |
| Schema fields | UC table node `columns` (name, type, nullable) |
| Column lineage | `system.access.column_lineage` via `get_schema_column_lineage` |
| Table→entity→table events | `system.access.table_lineage` via `get_table_lineage` |
| Ownership / documentation | UC `information_schema` (table owner, comment) |
| DQ rules facet | app-owned `dq_rules` Delta table |
| Run time | producing entity's `last_run` |

---

## 8. Current gaps (honest state)

These are the concrete stubs a reader will otherwise trip over. They are
**expected** — they are the Phase 2 scope — but `capability_code_map.md`
overstates the delivered state, so they are recorded here explicitly.

1. **Import is a dead-end.** `POST /api/import/openlineage` persists events to
   `external_lineage_events`; **no code reads that table back into the graph**,
   so imported lineage never renders. (Admin-gated write; validation is minimal.)
2. **Producer delivery does not run.** `POST /api/openlineage/producer/produce`
   fills `openlineage_producer_queue`; there is **no worker** that POSTs those
   events to configured endpoints. The queue is never drained.
3. **Producer events are non-canonical.** The produce path predates
   `openlineage_builder` and emits the old namespace/faceting.
4. **Job SQL / source-code facets** are not emitted by export yet (builders
   exist).

> The **OL bridge** (Cap 05, `routes/external_sources.py`) is a *separate*,
> functioning ingestion path for external OL-emitting platforms (Snowflake
> Horizon, Spark, dbt Cloud, Airflow, …) that push RunEvents to a receive URL;
> those edges land in `external_ol_bridge_events`. It is not the same as the
> `import_openlineage` paste/upload path in gap #1.

---

## 9. File map

| File | Role |
| --- | --- |
| `backend/openlineage_builder.py` | Pure OL 2.0.2 facet/event builders + conformance validator (Phase 1) |
| `backend/routes/openlineage.py` | Export route (Phase 1, canonical) + import/producer endpoints (Phase 2 stubs) |
| `backend/routes/external_sources.py` | OL bridge — external-platform ingestion (Cap 05, separate) |
| `frontend/src/components/ExportPanel.tsx` | Export / Import / Snapshots UI (Phase 1 revamp) |
| `tests/test_openlineage_builder.py` | Builder + validator unit tests |
| `tests/test_routes_openlineage*.py` | Route tests |
| `frontend/src/components/ExportPanel.test.tsx` | UI tests |
