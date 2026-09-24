# BrickTrace — Federated (Cross-Workspace) Lineage Design

> **Status:** Design proposal. This is the readable companion to the
> `FEDERATED_LINEAGE_DESIGN.docx` referenced throughout the code
> (`backend/models.py`, `backend/lineage_service.py`, `backend/feature_flags.py`,
> `backend/federated_sync.py`). It supersedes that binary as the source of truth
> for the cross-workspace work.
>
> **Scope of this document:** a single Unity Catalog **metastore** shared by
> multiple workspaces in the **same account and region** (e.g. a silver pipeline
> in workspace A and a gold pipeline in workspace B). Cross-*account* /
> cross-*metastore* federation (Delta Sharing boundaries) is a non-goal here and
> is covered separately by the sharing overlay — see [Non-goals](#8-non-goals).

---

## 1. Problem statement

Customers commonly split a medallion pipeline across workspaces that share one
regional metastore: bronze/silver curated in one workspace, gold/marts published
from another. The lineage should render as one graph — and it does. But when a
user asks for **LLM column-transformation analysis** on a table whose producing
code lives in a *different* workspace than the one the app runs in, the analysis
fails, because fetching that producer's source is bolted to the app's single
workspace client.

This document explains precisely why the graph already works, why the
transformation analysis does not, and the phased design to close the gap.

---

## 2. The governing distinction

Every behavior below follows from one boundary:

> **Unity Catalog data — `system.*` tables, UC tables, column tags — is
> *metastore-wide*. Workspace control-plane objects — notebooks, jobs,
> pipelines, workspace files — are *workspace-local*.**

BrickTrace reads lineage over the **first** plane (SQL against a warehouse) and
reads producer *code* over the **second** plane (workspace / jobs / pipelines
REST). The first plane is workspace-agnostic; the second is pinned to exactly
one workspace.

| Read | Mechanism | Plane | Cross-workspace today? |
| --- | --- | --- | --- |
| Table lineage graph | SQL on `system.access.table_lineage` | UC / metastore | ✅ Yes |
| Column lineage edges | SQL on `system.access.column_lineage` | UC / metastore | ✅ Yes |
| Producer authorization check | SQL on `system.access.table_lineage` | UC / metastore | ✅ Yes |
| Framework config table | SQL on a UC table (`SELECT * FROM {fqn}`) | UC / metastore | ✅ Yes |
| Captured Spark plans | SQL on `CAPTURED_PLANS_TABLE` (UC) | UC / metastore | ✅ Yes (if captured) |
| **Notebook / job / pipeline source code** | `workspace.export`, `jobs.get`, pipelines REST | Workspace control plane | ❌ **No** |
| **Runtime parameters** (Spark conf overrides) | jobs/pipelines REST | Workspace control plane | ❌ **No** |

---

## 3. Current state

### 3.1 The graph is already metastore-wide ✅

- Lineage is read from `system.access.table_lineage` / `column_lineage`
  (`lineage_service.py:876` trace, `:1251` catalog/schema-scoped, `:1790`
  column-level).
- The `WHERE` clauses filter **only** by catalog/schema name and an event-time
  window. There is **no `workspace_id` predicate** anywhere
  (`_internal_lineage_filter`, `lineage_service.py:266`).
- `system.access.*` is a metastore-level schema that aggregates lineage emitted
  by *every* workspace attached to the metastore. Same region → same metastore →
  both pipelines' edges already sit in one table.
- A single SQL warehouse (`DATABRICKS_WAREHOUSE_ID`, `lineage_service.py:573`)
  queries UC, which is metastore-scoped, so one warehouse sees data written by
  any workspace.

The graph works cross-workspace **because it never had a workspace dimension to
lose.**

### 3.2 The latent correctness gap: workspace-blind entity nodes

Nodes are keyed as `catalog.schema.table` (tables) and `entity:{type}:{id}`
(entities) — `models.py:5–29`. Neither carries `workspace_id`. But job IDs,
pipeline IDs, and notebook paths are **workspace-scoped**: job `123` in
workspace A and job `123` in workspace B are different objects that the current
model **cannot distinguish**, so they collapse into a single node. The graph is
cross-workspace but **workspace-blind** — correct for tables, ambiguous for
entity nodes.

### 3.3 The transformation-analysis break ❌

All producer-code fetching runs through one process-wide singleton bound to the
app's own host and service principal:

```python
# backend/lineage_service.py:57
def _get_client() -> WorkspaceClient:
    global _client_instance
    if _client_instance is None:
        _client_instance = WorkspaceClient()   # no args → app's own host + SP
    return _client_instance
```

Even the per-user identity path is forced back onto that same host
(`lineage_service.py:146`: `host=_get_client().config.host`). There is **no code
path** — per-request or per-user — that can target a second workspace.

**Failure walkthrough** — `/api/column-transformations/deep-analyze` for a gold
table whose pipeline lives in workspace B:

1. **Authorization passes, misleadingly.** `_assert_producer_of()`
   (`routes/lineage.py:93`) confirms the `(entity_type, entity_id,
   target_table)` edge exists in `system.access.table_lineage`. That table is
   metastore-wide, so the workspace-B edge **is present** → the check approves.
   It does *not* filter on `workspace_id`.
2. **The source fetch runs against workspace A and 404s.**
   `producer_source._fetch_source()` dispatches to `workspace.export` (notebook),
   `jobs.get` (job), pipelines REST (pipeline), or `queries.get` (query) — all on
   the app's workspace-A client. The `entity_id` is a workspace-B path/id that
   does not exist in A → `RESOURCE_DOES_NOT_EXIST` (404) or `403`.
3. **User sees** a not-found error, or the framework-analysis fallbacks degrade
   to *"No transformation logic found" / "No columns could be derived."*
4. **Dangerous edge:** because step 1 ignores `workspace_id`, a numeric
   `entity_id` collision (job `123` in both A and B) could authorize on B's edge
   then fetch **A's unrelated job `123`**, feeding the LLM the *wrong* source and
   producing confidently wrong lineage. Low-probability, but a silent-corruption
   path — not just a failure.

**What already survives** (all UC/SQL reads): the authorization check, the
framework **config-table** read (`framework_analysis._query_config_table`), the
config-schema resolver (`_resolve_config_alternates`), and **captured-plan**
reads (`plan_capture_service`). The LLM call itself is never the problem — it is
text in / text out. **The entire failure reduces to fetching the producer's
source artifact from the workspace where it physically lives.**

### 3.4 What exists today: the `federated_sync` scaffold

`backend/federated_sync.py` (flag `federated_sync.cross_workspace`) is a v1
**metadata-only** scaffold: an admin registry of "known peer" workspaces
cross-referenced against Delta Sharing metadata. `verify_peer_trust` only does
an unauthenticated HTTPS probe of the sharing endpoint — it **never instantiates
a client to a peer**. It is the right home for this work, but none of the actual
cross-workspace fetching exists yet.

---

## 4. Verified enabling facts

Confirmed live against `system.information_schema.columns` on the metastore:
`system.access.table_lineage` **and** `system.access.column_lineage` both carry:

| Column | Use |
| --- | --- |
| `workspace_id` | The workspace that emitted the lineage event — i.e. the producer's home workspace. **The linchpin: it is already there; the app just never selects it.** |
| `metastore_id` | Metastore scope (single value in-region). |
| `entity_run_id` | Distinguishes runs; useful for "which run produced this." |
| `entity_id`, `entity_type`, `entity_metadata` | Producer identity (already used). |

Because same metastore ⇒ **same account**, the credential problem is tractable:
this is intra-account, not cross-account.

---

## 5. Proposed design

### 5.1 Capture `workspace_id` end-to-end (prerequisite)

- Add `workspace_id` (and `entity_run_id`) to the lineage `SELECT`s
  (`lineage_service.py:876/1251/1790`).
- Thread `workspace_id` onto `EntityNode` (`models.py:21`) and disambiguate the
  node id: `entity:{workspace_id}:{type}:{id}`.
- Tighten `_assert_producer_of` (`routes/lineage.py:93`) to match on
  `workspace_id` too, closing the collision/confused-deputy edge.

This alone fixes §3.2 and §3.3-step-4 with **zero new auth**.

### 5.2 A workspace-aware client factory

Replace the singleton with a keyed factory backed by a registry:

```python
def _get_client(workspace_id: str | None = None) -> WorkspaceClient:
    # workspace_id None or == app's own → existing singleton (unchanged)
    # else → look up (host, credentials) in the peer registry, build a client
```

The registry `{workspace_id → (host, credentials)}` is the `federated_peers`
table extended from metadata to real credentials.

### 5.3 Auth model (best-first)

| Option | How | Verdict |
| --- | --- | --- |
| **Account-level service principal (OAuth M2M)** | One SP identity, granted into each workspace in the account; per-workspace OAuth tokens. | ✅ **Recommended** for same-account/same-metastore. |
| Per-workspace SP + secret | Distinct SP + client secret per workspace, stored in the registry. | More moving parts; use only where an account SP can't be shared. |
| On-behalf-of user token | Forwarded user token. | ❌ Won't cross workspaces — the token is issued by, and scoped to, the app's workspace. |

In every case the principal still needs the same per-object `CAN_READ` /
`CAN_VIEW` grant on the target notebook/job/pipeline that is already required in
the app's own workspace (see `docs/` deploy notes) — now multiplied per
workspace. Grant management is the real operational cost, not the code.

### 5.4 Route producer fetches by home workspace

In `producer_source._fetch_source()` and `framework_analysis`, pass the lineage
row's `workspace_id` into `_get_client(workspace_id)`. Config/plan/SQL reads keep
using the local warehouse — they are already metastore-wide.

### 5.5 Captured-plans-in-UC as the pragmatic fallback

The offline `lineage_capture` wheel writes analyzed Spark plans to a **UC
table** (`CAPTURED_PLANS_TABLE`), which is metastore-wide. Run capture in *each*
workspace, write to one shared UC schema, and BrickTrace reads them centrally via
SQL — **sidestepping the control-plane boundary entirely**. Lowest-friction path
to real cross-workspace column transformations for covered pipelines, requiring
**no multi-workspace auth at all**.

### 5.6 Fail honestly

When a producer's `workspace_id` ≠ the app's and no client is registered, return
a specific *"producer lives in workspace `<id>`, not reachable from here"*
message — mirroring the existing "the trace stops honestly at the metastore
boundary" behavior — instead of a generic 404 or a misleading "no logic found."

---

### 5.7 Footprint in the other workspaces

A recurring operational question: **does any of this require installing a
component in the peer workspaces?** No — with one exception. The BrickTrace app
is deployed to exactly **one** workspace throughout; it is never installed
per-workspace. There is no agent, sidecar, or second app pushed to peers.

| Capability | Runs in app's workspace (A) | Required in peer workspace (B) |
| --- | --- | --- |
| Table/column graph | App reads `system.access.*` | **Nothing.** UC emits lineage automatically when B runs a job/pipeline. Sole prerequisite: **system tables enabled on the metastore** — a one-time, metastore-wide admin enablement, *not* a per-workspace component. |
| Phase 0 (capture `workspace_id`, authz, honest failure) | All app-side | **Nothing.** |
| Phase 2 (live source fetch) | App + `_get_client(workspace_id)` | **No software.** The app's **service principal must be a principal in B** and hold `CAN_READ`/`CAN_VIEW` on the specific producer notebooks/jobs/pipelines. Identity + grants, not an install. |
| Phase 1 (captured-plans fallback) | App reads shared UC table via SQL | **The one running component:** the offline `lineage_capture` wheel/job must **run in B** (attached to B's pipeline compute, `lineage_tracking.plan_capture` on) and write to the shared UC schema. Its payoff is avoiding Phase 2's control-plane auth entirely. |

Net: graph and Phase 0 have **zero** footprint in peers; Phase 2 is a
provisioning/permissions task (one account SP added across workspaces — §5.3);
only Phase 1 places an actual running job in a peer workspace.

---

## 6. Phasing

| Phase | Deliverable | Auth needed | Value |
| --- | --- | --- | --- |
| **0** | Capture `workspace_id`; disambiguate entity nodes; tighten authz; honest "different workspace" message | None | Fixes correctness + UX immediately |
| **1** | Captured-plans-per-workspace → central UC table | None | Real cross-workspace transformations for covered pipelines |
| **2** | Account-SP client registry in `federated_sync`; route fetches by `workspace_id` | Account SP + per-object grants | Live source fetch for arbitrary producers — **customer-committed, full design in §7** |

> **Note.** Where plan-capture (Phase 1) is running, it is the more accurate
> source of transformation *facts* and needs no cross-workspace auth. Phase 2
> exists for producers plan-capture cannot cover — hand-written notebooks /
> pipelines in a peer workspace — and for the LLM *narrative/framework* layer
> that reads raw source. On any Phase 2 fetch failure the analysis degrades to
> Phase 1 / SQL-reachable inputs rather than hard-failing (§7.8).

---

## 7. Phase 2 — detailed design: cross-workspace live source fetch

A customer requires LLM transformation analysis on producers whose **source
code lives in a peer workspace** (hand-written notebooks/pipelines that
plan-capture does not cover). This section is the implementation-grade spec.

### 7.1 Components

1. **Peer workspace registry** — extends `federated_peers` from metadata to
   connection info.
2. **Credential store** — one account service principal, secret in a Databricks
   secret scope (never in the registry).
3. **Workspace-aware client factory** with a per-process client cache.
4. **Fetch routing** — thread `workspace_id` (from the lineage row) through
   `producer_source` and `framework_analysis`.
5. **Authorization + security** — workspace-matched authz, requesting-user
   entitlement precheck, SSRF guard, audit.
6. **Degradation ladder** — fall back to Phase 1 / Phase 2-lite on any failure.

### 7.2 Identity & credentials — account SP + OAuth M2M

- Provision **one account-level service principal** with an OAuth secret
  (`client_id` / `client_secret`).
- Add that SP as a **member of each peer workspace** (account console / SCIM).
- Grant it `CAN_READ` / `CAN_VIEW` on the producer objects it must read (§7.7).
- The SDK mints per-workspace OAuth tokens automatically:

  ```python
  WorkspaceClient(config=SdkConfig(
      host=peer_host, client_id=CID, client_secret=CSEC, auth_type="oauth-m2m"))
  ```

  The SP exchanges credentials at `{peer_host}/oidc/v1/token`; the token is valid
  because the SP is a member of that workspace.

- **Key property — credentials are O(1), not O(workspaces).** One
  `client_id`/`client_secret` pair works for *every* workspace the SP belongs to.
  Only workspace **membership + object grants** scale with workspace count. Store
  the secret in a secret scope; the registry holds only non-secret references.
- **Fallback identity** (if an account SP is disallowed): a per-workspace SP with
  its own secret; the registry row references the secret key. Same factory, more
  secrets to rotate.

### 7.3 Peer registry (data model)

Extend the app-owned `federated_peers` table (in `LINEAGE_SCHEMA`):

| Column | Meaning |
| --- | --- |
| `workspace_id` (PK) | Peer workspace id, matched against the lineage row |
| `deployment_host` | `https://<peer>.cloud.databricks.com` — **looked up here, never taken from the request** |
| `display_name` | Human label |
| `auth_kind` | `account_sp` \| `workspace_sp` |
| `secret_scope`, `secret_key` | Where the OAuth credential lives (not the value) |
| `enabled` | Admin toggle |
| `added_by`, `added_at` | Provenance |

Admin-managed via the existing `federated_sync` admin surface. The host must be
validated with `assert_safe_outbound_url` (already in `backend/validators.py`)
before any call — the SSRF guard.

### 7.4 Client factory

```python
_peer_clients: dict[str, WorkspaceClient] = {}

def _get_client(workspace_id: str | None = None) -> WorkspaceClient:
    if workspace_id in (None, _app_workspace_id()):
        return _get_app_client()                 # existing singleton, unchanged
    if workspace_id in _peer_clients:
        return _peer_clients[workspace_id]
    peer = _lookup_peer(workspace_id)            # registry; raises PeerNotRegistered
    assert_safe_outbound_url(peer.deployment_host)
    cid, csec = _read_secret(peer.secret_scope, peer.secret_key)
    client = WorkspaceClient(config=SdkConfig(
        host=peer.deployment_host, client_id=cid, client_secret=csec,
        auth_type="oauth-m2m"))
    _peer_clients[workspace_id] = client
    return client
```

The SDK handles token refresh. Evict the cached client on registry change or on
an auth error.

### 7.5 Routing the fetch

- Phase 0 has already put `workspace_id` on the lineage rows and `EntityNode`.
- `producer_source._fetch_source(entity_type, entity_id, …, workspace_id)` calls
  `client = _get_client(workspace_id)`; every `_fetch_notebook_source` /
  `_fetch_job_source` / `_fetch_pipeline_source` / `_fetch_query_source` uses it.
- `framework_analysis._fetch_entity_parameters(…, workspace_id)` likewise.
- **Config-table and captured-plan reads stay on the local warehouse** — they are
  metastore-wide and need no peer client.
- `routes/lineage.py` reads `workspace_id` off the resolved lineage row and
  threads it down; it is **never** client-supplied.

**How the source is actually retrieved — API reads, no remote component.** The
peer client is the Databricks **SDK** (`databricks-sdk`), which issues
authenticated HTTPS calls to the peer's **REST API**. Fetching source is a
*read* against the control plane, not code execution — nothing is deployed or
run in the peer workspace for this. Per producer type:

| Producer | SDK call | REST endpoint | Returns |
| --- | --- | --- | --- |
| Notebook | `workspace.export(path, ExportFormat.SOURCE)` | `GET /api/2.0/workspace/export` | base64 source |
| Workspace file | `workspace.download(path)` | `GET /api/2.0/workspace/export` | raw bytes |
| Query | `queries.get(id)` | SQL queries API | `.query` text |
| Job | `jobs.get(job_id)` → notebook task → `workspace.export` | `GET /api/2.1/jobs/get` + export | task notebook source |
| Pipeline | `api_client.do("GET", "/api/2.0/pipelines/{id}")` → walk libraries → `workspace.export`/`download`; glob → `workspace.list` then export each | pipelines GET + `/workspace/export` + `/workspace/list` | source of every referenced notebook/file |

A pipeline (and a job) has **no single source blob**: read the definition, find
the notebooks/files it references, then export each. The only peer-side
prerequisite is **identity + read permission** for the SP (§7.2, §7.7) — the SDK
attaches its OAuth bearer token to each call. The sole thing that ever *runs* in
a peer workspace is the optional Phase 1 plan-capture job, which captures
executed plans (not source) into a UC table.

### 7.6 Authorization & security (the hard part)

Three gates, all must pass before a byte of peer source is read:

1. **Workspace-matched lineage authz.** `_assert_producer_of` matches
   `(entity_type, entity_id, target_table, workspace_id)` in
   `system.access.table_lineage` — closes the confused-deputy / id-collision edge
   in §3.3-step-4.
2. **Requesting-user entitlement precheck.** The user's OAuth token is
   workspace-A-scoped, so the fetch necessarily runs as the **account SP**, not
   the user. To stop the SP becoming a data-exfiltration path (a user reading
   source they could not otherwise see), before fetching, verify the requesting
   user is entitled to the object in the peer workspace. Options, best-first:
   - When `ENFORCE_USER_IDENTITY` is on: query the peer's permissions API (as the
     SP) and require the user's principal has ≥ `CAN_VIEW`;
   - else gate cross-workspace source fetch behind an admin/governed role;
   - else document "the app SP reads on behalf of authorized app users" as an
     explicit, customer-accepted trust boundary.
3. **Outbound host validation (SSRF).** Host from the registry only, through
   `assert_safe_outbound_url`.

Plus **audit**: log every cross-workspace fetch (user, target table, entity,
source `workspace_id`, decision) to the app's notifications/audit sink.

### 7.7 Grant management (the dominant operational cost)

Grants scale O(workspaces × producer-objects). Reduce the burden:

- Ship a **bootstrap script per peer** (mirroring `grant_app_access.sh`): adds
  the SP to the workspace and grants `CAN_READ` on the producing
  notebooks/dirs/pipelines. Directory grants **do not cascade** (a known gotcha
  in the app's own workspace) — grant objects directly, or re-run when new
  producers land.
- **Broad alternative:** make the SP a workspace admin (or grant workspace-wide
  read) in the peer — one grant, blanket read, larger blast radius. A security
  trade-off to settle *with the customer*: least-privilege per-object is safer
  but higher-maintenance (and grants can reset on producer redeploy, as already
  observed intra-workspace).

### 7.8 Failure & degradation ladder

Never hard-fail the analysis; degrade and label:

1. **Registry miss / disabled** → *"producer in workspace `<id>` is not
   registered"* + offer admin registration.
2. **Auth / permission failure** → specific message; evict the cached client; log.
3. **Object 404** → *"producer object not found in workspace `<id>` (may have
   moved)"*.
4. **Any source unreachable** → fall back to **Phase 2-lite** (LLM over captured
   plan + config table + column edges + tags) and/or **Phase 1** captured-plan
   facts, clearly labeling the result *"derived without producer source."*

### 7.9 Feature flag & rollout

- Gate on the existing `federated_sync.cross_workspace` **plus** a new sub-flag
  `federated_sync.live_source_fetch` (default off).
- Roll out dark: registry + factory → enable one trusted peer → widen.
- Config: `FED_LIVE_SOURCE_FETCH_ENABLED`, the secret-scope name, and the account
  SP `client_id` reference.

### 7.10 Effort & risk

- **Code:** factory + routing + workspace-matched authz is moderate; the registry
  admin surface is small (extends `federated_sync`).
- **Ops (customer-side, dominant):** account-SP provisioning + per-workspace
  membership + object grants.
- **Risk focus:** the data-access boundary (§7.6), SSRF, and audit — this is the
  section a security review must scrutinize. Plan-capture remains the safer
  default wherever it is available.

---

## 8. Non-goals

- **Cross-account / cross-metastore lineage.** Handled by the Delta Sharing
  overlay (`lineage_service.get_sharing_overview`); the trace stops honestly at
  the metastore boundary because the other account's control plane is
  unreadable. This document is strictly intra-metastore.
- **Live peer discovery / trust handshakes.** The registry is admin-curated.
- **Rewriting the graph query.** It is already metastore-wide; §5.1 only *adds*
  columns, it does not change scope.

---

## 9. Relationship to existing code

| Area | File:Line | Change | Phase |
| --- | --- | --- | --- |
| Lineage graph query | `lineage_service.py:876/1251/1790` | Add `workspace_id`, `entity_run_id` to `SELECT` | 0 |
| Entity model | `models.py:21` | Add `workspace_id`; namespace node id `entity:{workspace_id}:{type}:{id}` | 0 |
| Producer authz | `routes/lineage.py:93` | Match on `workspace_id` (closes §3.3-4) | 0 |
| Client factory | `lineage_service.py:57` | `_get_client(workspace_id=None)` + per-peer client cache (§7.4) | 2 |
| Peer registry | `federated_sync.py` | Extend from metadata to connection info (§7.3); admin surface | 2 |
| Source fetch | `producer_source.py` (`_fetch_*`) | Thread `workspace_id` to the client (§7.5) | 2 |
| Framework analysis | `framework_analysis.py` (`_fetch_entity_parameters`) | Thread `workspace_id`; config/plan reads unchanged | 2 |
| Entitlement precheck | `routes/lineage.py`, peer permissions API | Verify requesting user ≥ `CAN_VIEW` in peer (§7.6) | 2 |
| SSRF guard | `backend/validators.py` (`assert_safe_outbound_url`) | Validate peer host from registry | 2 |
| Degradation | `framework_analysis.py`, `plan_capture_service.py` | Fall back to Phase 1 / Phase 2-lite (§7.8) | 1/2 |
| Feature flags | `feature_flags.py:121` | `federated_sync.cross_workspace` + new `federated_sync.live_source_fetch` (default off) | 2 |
| Captured plans | `plan_capture_service.py`, `lineage_capture` wheel | Run capture per workspace → shared UC table | 1 |
