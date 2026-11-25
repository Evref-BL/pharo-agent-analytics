"""The span store: one DuckDB database, spans loaded once by their id."""

from __future__ import annotations

import json
import tempfile
from collections.abc import Iterable
from importlib.resources import files
from pathlib import Path
from typing import Any

import duckdb


def sql(name: str) -> str:
    return files("pharo_agent_analytics.sql").joinpath(f"{name}.sql").read_text()


def connect(database: Path | str) -> duckdb.DuckDBPyConnection:
    if database != ":memory:":
        Path(database).parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(database))
    connection.execute(sql("spans"))
    return connection


def load_file(connection: duckdb.DuckDBPyConnection, path: Path | str) -> int:
    """Load a file of documents, one JSON object per line; answers how many were new."""
    before = connection.execute("SELECT count(*) FROM spans").fetchone()[0]
    connection.execute(sql("load"), {"path": str(path)})
    return connection.execute("SELECT count(*) FROM spans").fetchone()[0] - before


def load_documents(connection: duckdb.DuckDBPyConnection, documents: Iterable[dict[str, Any]]) -> int:
    with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False) as out:
        count = 0
        for document in documents:
            out.write(json.dumps(document, ensure_ascii=False) + "\n")
            count += 1
    try:
        return load_file(connection, out.name) if count else 0
    finally:
        Path(out.name).unlink(missing_ok=True)


#: The traces whose calls carried a caller's context: a parent span none of the tools' spans is.
CALLER_TRACES = """
SELECT DISTINCT s.trace_id FROM spans s
WHERE s.scope_name IN ('mcp-pharo', '@evref-bl/plexus') AND s.kind = 'server'
  AND nullif(s.parent_span_id, '') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM spans p WHERE p.trace_id = s.trace_id AND p.span_id = s.parent_span_id
                  AND p.scope_name IN ('mcp-pharo', '@evref-bl/plexus'))
"""


def build_model(connection: duckdb.DuckDBPyConnection) -> None:
    """Calls and sessions, from the spans."""
    connection.execute(sql("model"))
