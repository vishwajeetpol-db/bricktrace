"""Best-effort SQL parsing for column-level hints (sqlparse-based, extensible)."""

from __future__ import annotations

import logging
import re
from typing import Any

import sqlparse

logger = logging.getLogger(__name__)


# Three-part `catalog.schema.table` OR two-part `schema.table`. Two-part
# names are common when the notebook starts with `USE CATALOG <x>`; the
# parse functions then use `default_catalog` to fully qualify them.
_FQN_3 = r"`?[\w]+`?\.`?[\w]+`?\.`?[\w]+`?"
_FQN_2 = r"`?[\w]+`?\.`?[\w]+`?"
_FQN = rf"(?:{_FQN_3}|{_FQN_2})"

_TABLE_RE = re.compile(
    rf"\b(?:from|join)\s+({_FQN})",
    re.IGNORECASE,
)

_ALIAS_RE = re.compile(
    rf"\b(?:from|join)\s+({_FQN})(?:\s+(?:as\s+)?([`\"]?[\w]+[`\"]?))?",
    re.IGNORECASE,
)

_OUTPUT_TABLE_RES = [
    re.compile(rf"\binsert\s+(?:into|overwrite)\s+(?:table\s+)?({_FQN})", re.IGNORECASE),
    re.compile(
        rf"\bcreate\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?({_FQN})",
        re.IGNORECASE,
    ),
    # Declarative / Lakeflow targets: MATERIALIZED VIEW, (STREAMING) [LIVE] TABLE,
    # and plain VIEW — supporting `OR REPLACE`/`OR REFRESH` and `TEMPORARY`.
    # Without these, MV / streaming-table / DLT statements parse to no output
    # target and yield zero transformation edges (silent empty popup).
    re.compile(
        rf"\bcreate\s+(?:or\s+(?:replace|refresh)\s+)?(?:temporary\s+)?"
        rf"(?:materialized\s+view|streaming\s+(?:live\s+)?table|live\s+table|view)\s+"
        rf"(?:if\s+not\s+exists\s+)?({_FQN})",
        re.IGNORECASE,
    ),
    re.compile(rf"\bmerge\s+into\s+({_FQN})", re.IGNORECASE),
]

# `USE CATALOG <name>` / `USE SCHEMA <name>` (also `USE DATABASE <name>`).
USE_CATALOG_RE = re.compile(r"\buse\s+catalog\s+`?([\w]+)`?", re.IGNORECASE)
USE_SCHEMA_RE = re.compile(r"\buse\s+(?:schema|database)\s+`?([\w]+)`?", re.IGNORECASE)


def _strip_quotes(s: str) -> str:
    return s.replace("`", "").replace('"', "").strip()


def _qualify_fqn(
    name: str,
    *,
    default_catalog: str | None,
    default_schema: str | None,
) -> str:
    """Promote a 1- or 2-part identifier to a 3-part FQN using the supplied
    defaults. Already-qualified names pass through unchanged.
    """
    if not name:
        return name
    parts = name.split(".")
    if len(parts) == 3:
        return name
    if len(parts) == 2 and default_catalog:
        return f"{default_catalog}.{name}"
    if len(parts) == 1 and default_catalog and default_schema:
        return f"{default_catalog}.{default_schema}.{name}"
    return name


# `STREAM(<table>)` / `STREAM (<table>)` — the streaming-read wrapper used by
# streaming tables and DLT. Source-table extraction must see the inner table,
# not the literal "STREAM"; this rewrites the wrapper away before FROM/JOIN
# matching. (Subquery forms like STREAM(SELECT ...) don't match the simple
# identifier group and are left for normal nested parsing.)
_STREAM_WRAP_RE = re.compile(r"\bstream\s*\(\s*([`\"\w.]+)\s*\)", re.IGNORECASE)


def _unwrap_streaming_sources(sql: str) -> str:
    return _STREAM_WRAP_RE.sub(r"\1", sql)


# SQL keywords / type names to exclude when guessing bare column identifiers
# from an expression (used ONLY to resolve unqualified columns against a single
# known source table, e.g. streaming tables / CTAS without table aliases).
_SQL_NONCOLUMN = {
    "as", "and", "or", "not", "is", "null", "case", "when", "then", "else", "end",
    "distinct", "over", "partition", "by", "order", "asc", "desc", "interval", "cast",
    "try_cast", "date", "timestamp", "int", "integer", "bigint", "smallint", "tinyint",
    "string", "varchar", "char", "double", "float", "decimal", "numeric", "boolean",
    "true", "false", "from", "where", "group", "having", "select", "on", "join", "using",
    "in", "like", "between", "current_date", "current_timestamp", "stream", "div", "ilike",
}


def _unqualified_columns(expr: str) -> list[str]:
    """Best-effort bare column identifiers in an expression: function names
    (identifier immediately followed by ``(``), SQL keywords, type names, and
    string literals are excluded. Used only to attribute unqualified columns to
    a SINGLE known source table when no alias-qualified references are present.
    """
    e = re.sub(r"'[^']*'", " ", expr)
    e = re.sub(r'"[^"]*"', " ", e)
    out: list[str] = []
    for m in re.finditer(r"\b([a-zA-Z_]\w*)\b(\s*\()?", e):
        name, is_func = m.group(1), m.group(2)
        if is_func or name.lower() in _SQL_NONCOLUMN:
            continue
        if name not in out:
            out.append(name)
    return out


def extract_tables(
    sql: str,
    *,
    default_catalog: str | None = None,
    default_schema: str | None = None,
) -> list[str]:
    """Rough table list from FROM / JOIN clauses, qualified to 3-part names
    using `default_catalog` / `default_schema` when the source SQL only
    uses 2- or 1-part identifiers.
    """
    sql = _unwrap_streaming_sources(sql)
    tables: list[str] = []
    for m in _TABLE_RE.finditer(sql):
        raw = _strip_quotes(m.group(1))
        tables.append(
            _qualify_fqn(raw, default_catalog=default_catalog, default_schema=default_schema)
        )
    return sorted(set(tables))


def extract_alias_map(
    sql: str,
    *,
    default_catalog: str | None = None,
    default_schema: str | None = None,
) -> dict[str, str]:
    """
    Map alias (and unqualified table name) -> fully-qualified table name.

    Covers:
      FROM catalog.schema.table AS a  -> {"a": "catalog.schema.table", "table": "catalog.schema.table"}
      FROM catalog.schema.table t     -> {"t": "catalog.schema.table", "table": "catalog.schema.table"}
      FROM catalog.schema.table       -> {"table": "catalog.schema.table"}
      FROM schema.table         (with `USE CATALOG c`) -> {"table": "c.schema.table"}
    """
    mapping: dict[str, str] = {}
    sql = _unwrap_streaming_sources(sql)
    for match in _ALIAS_RE.finditer(sql):
        raw = _strip_quotes(match.group(1))
        fqn = _qualify_fqn(raw, default_catalog=default_catalog, default_schema=default_schema)
        short = fqn.split(".")[-1].lower()
        mapping.setdefault(short, fqn)
        alias = match.group(2)
        if alias:
            a = _strip_quotes(alias).lower()
            mapping[a] = fqn
    return mapping


def extract_output_table(
    sql: str,
    *,
    default_catalog: str | None = None,
    default_schema: str | None = None,
) -> str | None:
    """Detect the write target (INSERT INTO / CREATE TABLE AS / MERGE INTO)."""
    for r in _OUTPUT_TABLE_RES:
        m = r.search(sql)
        if m:
            raw = _strip_quotes(m.group(1))
            return _qualify_fqn(
                raw, default_catalog=default_catalog, default_schema=default_schema
            )
    return None


def extract_select_aliases(sql: str) -> list[dict[str, Any]]:
    """
    Map SELECT output aliases to raw expression text (best-effort).

    Returns rows: {"output_column": str, "expr": str}
    """
    out: list[dict[str, Any]] = []
    try:
        stmts = sqlparse.parse(sql)
    except Exception as e:
        logger.debug("sqlparse failed: %s", e)
        return out
    for stmt in stmts:
        out.extend(_aliases_from_one_stmt(stmt))
    return out


def _aliases_from_one_stmt(stmt: Any) -> list[dict[str, Any]]:
    """Extract SELECT aliases from a single sqlparse Statement.

    Walks **every** ``SELECT ... FROM ...`` segment, not just the first. CTAS
    statements with a `WITH` clause (`CREATE TABLE ... AS WITH cte AS
    (SELECT ... FROM ...) SELECT outer FROM cte`) have at least two SELECTs;
    capturing only the first misses the table's actual output columns
    defined by the outer SELECT. Capturing all of them is over-eager but
    safe -- the column names line up because outer SELECTs reference the
    same names the inner CTEs alias to, and graph_builder dedupes.
    """
    out: list[dict[str, Any]] = []
    flat = str(stmt)
    for m in re.finditer(
        r"select\s+(.*?)\s+from\s+", flat, flags=re.IGNORECASE | re.DOTALL
    ):
        select_list = m.group(1)
        for part in _split_select_list(select_list):
            part = part.strip()
            if not part:
                continue
            alias_m = re.search(r"(?is)\bas\s+([\w]+)\s*$", part)
            if alias_m:
                out.append(
                    {
                        "output_column": alias_m.group(1),
                        "expr": part[: alias_m.start()].strip(),
                    }
                )
                continue
            tokens = part.split()
            if len(tokens) >= 2 and tokens[-2].lower() != "as":
                out.append(
                    {"output_column": tokens[-1], "expr": " ".join(tokens[:-1])}
                )
                continue
            # Bare reference like `w.warehouse_id` (no AS): use the
            # column name as the output column and the qualified
            # reference as the expression so source attribution still
            # works. Plain `column_name` (single token, no dot) also
            # falls into this branch as a passthrough.
            bare = part.strip()
            if "." in bare:
                qualifier, _, col = bare.rpartition(".")
                # Tolerate trailing whitespace / commas defensively.
                col = col.strip().split()[0] if col.strip() else ""
                if col and col.replace("_", "").isalnum():
                    out.append({"output_column": col, "expr": bare})
            elif bare and bare.replace("_", "").isalnum() and not bare.startswith("'"):
                out.append({"output_column": bare, "expr": bare})
    return out


def _split_select_list(select_list: str) -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    for ch in select_list:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf))
    return parts


def _extract_ctes(stmt_sql: str) -> tuple[list[tuple[str, str]], str]:
    """Split a statement into its CTEs and main query.

    For ``CREATE ... AS WITH a AS (q1), b AS (q2) <main>`` returns
    ``([("a", q1), ("b", q2)], "<main>")``. Returns ``([], stmt_sql)`` when there
    is no CTE block. Uses balanced-paren scanning so nested parens inside a CTE
    body don't terminate it early.
    """
    m = re.search(r"\bwith\b", stmt_sql, re.IGNORECASE)
    if not m:
        return [], stmt_sql
    rest = stmt_sql[m.end():]
    ctes: list[tuple[str, str]] = []
    while True:
        nm = re.match(r"\s*([`\"]?[\w]+[`\"]?)\s+as\s*\(", rest, re.IGNORECASE)
        if not nm:
            break
        name = _strip_quotes(nm.group(1))
        open_idx = nm.end() - 1  # position of '('
        depth = 0
        close_idx = -1
        for j in range(open_idx, len(rest)):
            c = rest[j]
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    close_idx = j
                    break
        if close_idx == -1:
            break
        ctes.append((name, rest[open_idx + 1:close_idx]))
        rest = rest[close_idx + 1:]
        cm = re.match(r"\s*,", rest)
        if cm:
            rest = rest[cm.end():]
            continue
        break
    if not ctes:
        return [], stmt_sql
    return ctes, rest  # rest = the main query after the CTE block


# ── Multi-hop CTE resolution (mirrors the PySpark AST parser) ──────────────
# The PySpark parser (pyspark_ast_parser) traces a column back to its ultimate
# base-table source through a chain of intermediate DataFrames and expands the
# intermediates into a numbered step-wise derivation on a single edge
# (`_build_step_expr`). The helpers below give the SQL parser the same two
# capabilities for chained CTEs — `WITH a AS (...), b AS (... FROM a) <main>` —
# so `b.col` resolves through `a` to the base table and the edge carries a
# `Step 1 / Step 2 / …` derivation, instead of collapsing to a bare name.


def _strip_over_clauses(expr: str) -> str:
    """Remove every ``OVER ( … )`` window spec from `expr` (balanced-paren aware).

    Window PARTITION BY / ORDER BY keys are not data sources for the aggregated
    value, so they are excluded before VALUE-column extraction — matching the
    PySpark parser, which attributes lineage to the aggregated value, not the
    partition key. The `\\bover` anchor is matched against the full string so
    identifiers ending in "over" (e.g. ``rollover``) are not misfired.
    """
    if not expr:
        return expr
    result = expr
    while True:
        m = re.search(r"\bover\s*\(", result, re.IGNORECASE)
        if not m:
            break
        open_idx = m.end() - 1
        depth = 0
        close_idx = -1
        for k in range(open_idx, len(result)):
            if result[k] == "(":
                depth += 1
            elif result[k] == ")":
                depth -= 1
                if depth == 0:
                    close_idx = k
                    break
        if close_idx == -1:
            result = result[: m.start()] + " "
            break
        result = result[: m.start()] + " " + result[close_idx + 1 :]
    return result


def _expr_col_refs(expr: str) -> list[str]:
    """Column identifiers referenced in `expr`: the trailing segment of every
    ``alias.col``, plus bare identifiers (functions, keywords, type names and
    string literals excluded). Order-preserving and de-duplicated.
    """
    out: list[str] = []
    seen: set[str] = set()
    for _alias, col in _QUALREF_RE.findall(expr or ""):
        if col not in seen:
            seen.add(col)
            out.append(col)
    for col in _unqualified_columns(expr or ""):
        if col not in seen:
            seen.add(col)
            out.append(col)
    return out


def _passthrough_ref(expr: str) -> str | None:
    """If `expr` is just a column reference (``col`` or ``qualifier.col``),
    return the bare column name; else None (it carries a real transformation)."""
    e = (expr or "").strip()
    if re.fullmatch(r"[\w]+", e):
        return e
    m = re.fullmatch(r"[\w]+\.([\w]+)", e)
    return m.group(1) if m else None


def _sql_refs_in_alias_map(
    expr: str, alias_map: dict[str, dict[str, Any]]
) -> list[str]:
    """Column names in `expr` that are themselves intermediate CTE columns."""
    out: list[str] = []
    for n in _expr_col_refs(expr):
        if n in alias_map and n not in out:
            out.append(n)
    return out


def _build_sql_step_expr(
    expr: str,
    alias_map: dict[str, dict[str, Any]],
    output_column: str | None,
) -> str:
    """SQL analogue of ``pyspark_ast_parser._build_step_expr``.

    Intermediate CTE columns referenced by `expr` are expanded into ordered
    steps (dependencies first), ending with the output column, e.g.

        Step 1: amount_spent = SUM(total_amount)
        Step 2: total_expenditure = SUM(amount_spent) OVER (PARTITION BY category)

    A derivation with no intermediates returns just `expr` (no numbering).
    """
    seen: set[str] = set()
    if output_column:
        seen.add(output_column)
    order: list[tuple[str, str]] = []

    def visit(refs: list[str]) -> None:
        for r in refs:
            if r in seen or r not in alias_map or len(order) >= 20:
                continue
            seen.add(r)
            sub = (alias_map[r].get("expr") or "").strip()
            visit(_sql_refs_in_alias_map(sub, alias_map))
            order.append((r, sub))

    visit(_sql_refs_in_alias_map(expr, alias_map))
    final = (expr or "").strip()
    if not order:
        return final
    lines = [f"Step {i}: {name} = {e}" for i, (name, e) in enumerate(order, 1)]
    lines.append(f"Step {len(order) + 1}: {output_column or 'result'} = {final}")
    return "\n".join(lines)


# Qualified column reference `alias.col`, both segments anchored to identifier
# starts so a numeric literal (`0.9`, `12.5`) is NOT mistaken for `alias.col`
# (plain `\w` matches digits, which mis-attributed the `9` in `gross * 0.9`).
_QUALREF_RE = re.compile(r"\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b")

# Clause keywords that must never be mistaken for a table alias when they follow
# a FROM/JOIN target (`FROM filtered WHERE …`, `FROM a JOIN b` — "where"/"join"
# are not aliases). Used as a negative lookahead in `_FROM_JOIN_SRC_RE` so the
# optional-alias group does not swallow the next clause keyword (which would
# skip the following JOIN source entirely).
_ALIAS_STOPWORDS = {
    "where", "group", "order", "having", "on", "using", "join", "inner", "left",
    "right", "full", "outer", "cross", "natural", "window", "qualify", "limit",
    "union", "except", "intersect", "cluster", "distribute", "sort", "lateral",
}

# FROM / JOIN source with an OPTIONAL alias, matching 1-, 2- OR 3-part names.
# Unlike `_ALIAS_RE` (which reuses `_FQN` and so needs ≥2 parts), this also
# captures a BARE single-identifier target — the shape a CTE reference takes
# (`FROM filtered`, `JOIN per_customer pc`). Essential for tracing CTE-on-CTE
# chains, whose intermediate references are always bare names.
_FROM_JOIN_SRC_RE = re.compile(
    r"\b(?:from|join)\s+(`?[\w]+`?(?:\.`?[\w]+`?){0,2})"
    r"(?:\s+(?:as\s+)?(?!(?:" + "|".join(sorted(_ALIAS_STOPWORDS)) + r")\b)"
    r"([`\"]?[\w]+[`\"]?))?",
    re.IGNORECASE,
)


def _classify_query_sources(
    body: str,
    cte_names: set[str],
    *,
    default_catalog: str | None,
    default_schema: str | None,
) -> tuple[dict[str, tuple[str, str]], tuple[str, str] | None]:
    """Classify a (CTE-body or main-query) FROM/JOIN sources.

    Returns ``(src_by_key, single_source)`` where `src_by_key` maps each alias /
    bare name (lowercased) to a descriptor ``("cte", <name>)`` or
    ``("base", <fqn>)``, and `single_source` is that descriptor when the body
    reads exactly one source (else None — joins/multi-source degrade to
    qualified-only resolution, as the pre-existing parser did).
    """
    src_by_key: dict[str, tuple[str, str]] = {}
    descriptors: list[tuple[str, str]] = []
    for m in _FROM_JOIN_SRC_RE.finditer(_unwrap_streaming_sources(body)):
        raw = _strip_quotes(m.group(1))
        last = raw.split(".")[-1].lower()
        alias_raw = _strip_quotes(m.group(2)).lower() if m.group(2) else None
        alias = alias_raw if alias_raw and alias_raw not in _ALIAS_STOPWORDS else None
        if last in cte_names:
            descr: tuple[str, str] = ("cte", last)
            key = alias or last
        else:
            fqn = _qualify_fqn(
                raw, default_catalog=default_catalog, default_schema=default_schema
            )
            descr = ("base", fqn)
            key = alias or fqn.split(".")[-1].lower()
        src_by_key[key] = descr
        if descr not in descriptors:
            descriptors.append(descr)
    single = descriptors[0] if len(descriptors) == 1 else None
    return src_by_key, single


class _CteResolver:
    """Resolves CTE columns to their ultimate base-table sources across a chain.

    Walks the CTEs in definition order; each CTE's columns are resolved against
    its own FROM sources, which may be earlier CTEs (traced through recursively)
    or base tables. `alias_map` accumulates the non-trivial intermediate columns
    (name -> resolved sources + defining expr) that `_build_sql_step_expr` inlines.
    """

    def __init__(self, default_catalog: str | None, default_schema: str | None) -> None:
        self.default_catalog = default_catalog
        self.default_schema = default_schema
        self.alias_map: dict[str, dict[str, Any]] = {}
        # cte_name -> {out_col -> {"bases": [(fqn, col), …], "expr": str}}
        self.cte_cols: dict[str, dict[str, dict[str, Any]]] = {}
        self.cte_single_src: dict[str, tuple[str, str] | None] = {}
        self.cte_base: dict[str, str | None] = {}
        self.cte_names: set[str] = set()

    def _base_of(self, descr: tuple[str, str] | None) -> str | None:
        if descr is None:
            return None
        kind, val = descr
        return val if kind == "base" else self.cte_base.get(val)

    def _resolve_from_cte(
        self, cte_name: str, col: str, depth: int = 0
    ) -> tuple[str | None, str]:
        """Resolve `col` as produced by CTE `cte_name` to (base_fqn, base_col)."""
        if depth > 50:
            return (self.cte_base.get(cte_name), col)
        entry = self.cte_cols.get(cte_name, {}).get(col)
        if entry and entry["bases"]:
            return entry["bases"][0]
        # SELECT *-style passthrough: the column flows through from the source.
        descr = self.cte_single_src.get(cte_name)
        if descr is None:
            return (self.cte_base.get(cte_name), col)
        kind, val = descr
        if kind == "base":
            return (val, col)
        return self._resolve_from_cte(val, col, depth + 1)

    def _resolve_ref(
        self,
        tbl_alias: str | None,
        col: str,
        src_by_key: dict[str, tuple[str, str]],
        single: tuple[str, str] | None,
    ) -> tuple[str | None, str]:
        descr = src_by_key.get(tbl_alias.lower()) if tbl_alias else None
        if descr is None:
            descr = single
        if descr is None:
            return (None, col)
        kind, val = descr
        if kind == "base":
            return (val, col)
        return self._resolve_from_cte(val, col)

    def resolve_expr_bases(
        self,
        expr: str,
        src_by_key: dict[str, tuple[str, str]],
        single: tuple[str, str] | None,
    ) -> list[tuple[str | None, str]]:
        """Ultimate (base_fqn, base_col) sources feeding `expr`'s VALUE."""
        core = _strip_over_clauses(expr or "")
        bases: list[tuple[str | None, str]] = []
        handled: set[str] = set()
        for ta, col in _QUALREF_RE.findall(core):
            bases.append(self._resolve_ref(ta, col, src_by_key, single))
            handled.add(col)
        core_bare = _QUALREF_RE.sub(" ", core)
        for col in _unqualified_columns(core_bare):
            if col in handled:
                continue
            bases.append(self._resolve_ref(None, col, src_by_key, single))
        return list(dict.fromkeys(bases))

    def build(self, ctes: list[tuple[str, str]]) -> None:
        self.cte_names = {name.lower() for name, _ in ctes}
        for name, body in ctes:
            lname = name.lower()
            src_by_key, single = _classify_query_sources(
                body,
                self.cte_names,
                default_catalog=self.default_catalog,
                default_schema=self.default_schema,
            )
            self.cte_single_src[lname] = single
            self.cte_base[lname] = self._base_of(single)
            try:
                aliases: list[dict[str, Any]] = []
                for s in sqlparse.parse(body):
                    aliases.extend(_aliases_from_one_stmt(s))
            except Exception:  # noqa: BLE001
                aliases = []
            this_cols: dict[str, dict[str, Any]] = {}
            for a in aliases:
                out_col = a["output_column"]
                expr = a["expr"]
                bases = self.resolve_expr_bases(expr, src_by_key, single)
                this_cols[out_col] = {"bases": bases, "expr": expr}
                # Register only real transformations as expandable intermediates;
                # a trivial `col`/`t.col` passthrough with the same name would add
                # `Step: col = col` noise to the step-wise expression.
                pt = _passthrough_ref(expr)
                if pt is None or pt != out_col:
                    self.alias_map[out_col] = {
                        "source_cols": [c for _f, c in bases] or [out_col],
                        "source_fqn": bases[0][0] if bases else None,
                        "expr": expr,
                    }
            self.cte_cols[lname] = this_cols


def _strip_sql_comments(sql: str) -> str:
    """Remove `-- ...` line comments and `/* ... */` block comments, outside
    quoted strings / identifiers, keeping newlines.

    A trailing comment on a select-list line (`count(*) AS n,  -- note`) would
    otherwise be glued onto the NEXT select item when the list is split on
    commas, so that item's expression (and its source columns) is lost.
    """
    out: list[str] = []
    i, n = 0, len(sql)
    quote: str | None = None
    while i < n:
        ch = sql[i]
        if quote:
            out.append(ch)
            if ch == "\\" and quote != "`" and i + 1 < n:
                out.append(sql[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            out.append(ch)
            i += 1
        elif sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j == -1 else j
        elif sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            block = sql[i:] if j == -1 else sql[i:j + 2]
            out.append("\n" * block.count("\n") or " ")
            i = n if j == -1 else j + 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def parse_sql_text(
    sql: str,
    *,
    artifact_id: str,
    default_catalog: str | None = None,
    default_schema: str | None = None,
) -> dict[str, Any]:
    """Parse a SQL chunk into column-mapping records.

    Each statement (CREATE TABLE AS SELECT, INSERT ... SELECT, MERGE, plain
    SELECT) is processed independently so multiple writes concatenated in
    the same chunk each get correctly attributed to their own target table.
    Without this, a notebook cell that ingests ten bronze tables in
    sequence collapses every column mapping onto whichever target appears
    first in the cell.

    `default_catalog` and `default_schema` come from `USE CATALOG`/`USE SCHEMA`
    directives elsewhere in the notebook (passed in by the caller after
    scanning the joined notebook SQL); they're used to promote 1- or 2-part
    identifiers to fully-qualified 3-part FQNs.
    """
    sql = _strip_sql_comments(sql)
    try:
        stmts = sqlparse.parse(sql)
    except Exception as e:
        logger.debug("sqlparse failed: %s", e)
        stmts = []

    all_tables: list[str] = []
    all_mappings: list[dict[str, Any]] = []
    artifact_output_fqn: str | None = None
    statements_parsed = 0
    statements_total = 0

    for stmt in stmts:
        stmt_sql = str(stmt)
        if not stmt_sql.strip():
            continue
        statements_total += 1

        stmt_output = extract_output_table(
            stmt_sql, default_catalog=default_catalog, default_schema=default_schema
        )
        stmt_tables = extract_tables(
            stmt_sql, default_catalog=default_catalog, default_schema=default_schema
        )
        stmt_alias_map = extract_alias_map(
            stmt_sql, default_catalog=default_catalog, default_schema=default_schema
        )
        stmt_aliases = _aliases_from_one_stmt(stmt)

        # Detect a CTE block up front. A WITH alias referenced in a FROM clause
        # looks like a table to `extract_tables`, so drop those phantom
        # "CTE-as-table" names from table_references before pooling them.
        ctes, main_sql = _extract_ctes(stmt_sql)
        cte_names = {name.lower() for name, _ in ctes}
        if cte_names:
            stmt_tables = [
                t for t in stmt_tables if t.split(".")[-1].lower() not in cte_names
            ]

        all_tables.extend(stmt_tables)
        if artifact_output_fqn is None and stmt_output:
            artifact_output_fqn = stmt_output

        # ── CTE-aware path (multi-hop) ──────────────────────────────
        # `WITH a AS (...), b AS (... FROM a) <main>` — the outer SELECT and each
        # CTE reference CTE aliases, not always base tables. `_CteResolver` walks
        # the chain, tracing every column through intermediate CTEs to its base
        # table, and `_build_sql_step_expr` inlines the intermediate expressions
        # into a numbered `Step 1 / Step 2 / …` derivation on the single edge —
        # the SQL analogue of the PySpark AST parser. Without this, a `b.col`
        # that traces through `a` resolves to nothing (phantom external edge) and
        # multi-step transformations collapse to a bare column name.
        if ctes:
            resolver = _CteResolver(default_catalog, default_schema)
            resolver.build(ctes)
            main_src_by_key, main_single = _classify_query_sources(
                main_sql,
                cte_names,
                default_catalog=default_catalog,
                default_schema=default_schema,
            )
            main_aliases: list[dict[str, Any]] = []
            try:
                for s in sqlparse.parse(main_sql):
                    main_aliases.extend(_aliases_from_one_stmt(s))
            except Exception:  # noqa: BLE001
                main_aliases = []
            for a in main_aliases:
                out_col = a["output_column"]
                raw_expr = a["expr"]
                bases = resolver.resolve_expr_bases(
                    raw_expr, main_src_by_key, main_single
                )
                # If the output is a plain passthrough of an intermediate
                # (`SELECT cte.amount_spent`), show that intermediate's own
                # derivation rather than the bare reference.
                pt = _passthrough_ref(raw_expr)
                disp_expr = (
                    resolver.alias_map[pt]["expr"]
                    if pt is not None and pt in resolver.alias_map
                    else raw_expr
                )
                step_expr = _build_sql_step_expr(disp_expr, resolver.alias_map, out_col)
                if not bases:
                    all_mappings.append({
                        "artifact_id": artifact_id, "output_column": out_col,
                        "output_table_fqn": stmt_output,
                        "source_ref": "", "source_fqn": None, "source_column": "",
                        "expr": step_expr[:2000], "expr_lang": "sql",
                    })
                    continue
                for src_fqn, src_col in bases:
                    all_mappings.append({
                        "artifact_id": artifact_id, "output_column": out_col,
                        "output_table_fqn": stmt_output,
                        "source_ref": src_col, "source_fqn": src_fqn,
                        "source_column": src_col,
                        "expr": step_expr[:2000], "expr_lang": "sql",
                    })
            if main_aliases or stmt_tables or stmt_output:
                statements_parsed += 1
            continue

        for a in stmt_aliases:
            src_cols = re.findall(r"\b([\w]+)\.([\w]+)\b", a["expr"])
            if not src_cols:
                # No alias-qualified columns. If there's exactly ONE source table
                # (common for streaming tables / simple CTAS without aliases),
                # attribute the expression's bare column identifiers to that
                # single source so real edges form. Otherwise fall back to an
                # unresolved mapping so the output column is at least visible.
                single_src = stmt_tables[0] if len(stmt_tables) == 1 else None
                ucols = _unqualified_columns(a["expr"]) if single_src else []
                if single_src and ucols:
                    for col in ucols:
                        all_mappings.append(
                            {
                                "artifact_id": artifact_id,
                                "output_column": a["output_column"],
                                "output_table_fqn": stmt_output,
                                "source_ref": col,
                                "source_fqn": single_src,
                                "source_column": col,
                                "expr": a["expr"][:2000],
                                "expr_lang": "sql",
                            }
                        )
                else:
                    all_mappings.append(
                        {
                            "artifact_id": artifact_id,
                            "output_column": a["output_column"],
                            "output_table_fqn": stmt_output,
                            "source_ref": "",
                            "source_fqn": None,
                            "source_column": "",
                            "expr": a["expr"][:2000],
                            "expr_lang": "sql",
                        }
                    )
                continue
            for tbl_alias, col in src_cols:
                resolved_fqn = stmt_alias_map.get(tbl_alias.lower())
                all_mappings.append(
                    {
                        "artifact_id": artifact_id,
                        "output_column": a["output_column"],
                        "output_table_fqn": stmt_output,
                        "source_ref": f"{tbl_alias}.{col}",
                        "source_fqn": resolved_fqn,
                        "source_column": col,
                        "expr": a["expr"][:2000],
                        "expr_lang": "sql",
                    }
                )

        if stmt_aliases or stmt_tables or stmt_output:
            statements_parsed += 1

    return {
        "artifact_id": artifact_id,
        "language": "sql",
        "statements_parsed": statements_parsed,
        "statements_skipped": max(0, statements_total - statements_parsed),
        "column_mappings": all_mappings,
        "table_references": sorted(set(all_tables)),
        "output_table_fqn": artifact_output_fqn,
        "warnings": [],
    }


def detect_use_directives(sql: str) -> tuple[str | None, str | None]:
    """Return (catalog, schema) seen in the most recent USE statements,
    or (None, None) if none are present.
    """
    cat_m = USE_CATALOG_RE.search(sql)
    schema_m = USE_SCHEMA_RE.search(sql)
    return (
        cat_m.group(1) if cat_m else None,
        schema_m.group(1) if schema_m else None,
    )
