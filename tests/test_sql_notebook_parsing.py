"""SQL source-format notebooks: cell splitting on `-- COMMAND` and comment
handling in the SQL parser (transformation_lineage/extraction/normalize.py,
transformation_lineage/parsing/sql_parser.py)."""
import pytest

# Importing transformation_lineage pulls in pyspark (the package __init__ imports
# the pipeline), which isn't in requirements-dev.txt.
pytest.importorskip("pyspark")

from transformation_lineage.extraction.normalize import normalize_to_cells  # noqa: E402
from transformation_lineage.parsing.sql_parser import _strip_sql_comments  # noqa: E402

SQL_NOTEBOOK = """-- Databricks notebook source
-- MAGIC %md
-- MAGIC # Gold

-- COMMAND ----------

CREATE OR REPLACE TABLE c.s.daily_gold AS
SELECT txn_date, sum(total_amount) AS total_revenue FROM c.s.txn_silver GROUP BY txn_date

-- COMMAND ----------

CREATE OR REPLACE TABLE c.s.ltv_gold AS
SELECT customer_id, sum(total_amount) AS lifetime_value FROM c.s.txn_silver GROUP BY customer_id

-- COMMAND ----------

-- MAGIC %python
-- MAGIC spark.table("c.s.ltv_gold").write.saveAsTable("c.s.ltv_copy")
"""


class TestSqlNotebookCells:
    def test_sql_notebook_splits_on_sql_comment_separator(self):
        cells = normalize_to_cells(SQL_NOTEBOOK, "sql")
        assert [c["language"] for c in cells] == ["sql", "sql", "python"]
        assert "daily_gold" in cells[0]["source"] and "ltv_gold" not in cells[0]["source"]
        assert "ltv_gold" in cells[1]["source"]

    def test_sql_notebook_magic_cell_is_decoded(self):
        cells = normalize_to_cells(SQL_NOTEBOOK, "sql")
        assert cells[2]["source"].strip() == 'spark.table("c.s.ltv_gold").write.saveAsTable("c.s.ltv_copy")'

    def test_python_notebook_unchanged(self):
        py = "# Databricks notebook source\nx = 1\n\n# COMMAND ----------\n\n# MAGIC %sql\n# MAGIC SELECT 1\n"
        cells = normalize_to_cells(py, "python")
        assert [(c["language"], c["source"].strip()) for c in cells] == [
            ("python", "# Databricks notebook source\nx = 1"), ("sql", "SELECT 1"),
        ]


class TestStripSqlComments:
    def test_trailing_line_comment_does_not_join_next_item(self):
        out = _strip_sql_comments("SELECT count(*) AS n,  -- derive\n  sum(a) AS s FROM t")
        assert "derive" not in out
        assert out.split(",")[1].strip().startswith("sum(a)")

    def test_block_comment_removed_and_quotes_kept(self):
        sql = "SELECT a /* x,\n y */, '--keep', \"/*keep*/\", 'it\\'s' FROM t -- tail"
        out = _strip_sql_comments(sql)
        assert "x," not in out and "tail" not in out
        assert "'--keep'" in out and '"/*keep*/"' in out and "'it\\'s'" in out
        assert out.count("\n") == sql.count("\n")
