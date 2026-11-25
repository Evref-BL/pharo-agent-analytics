"""The report's data: each analysis as a small JSON file of aggregates.

With a threshold of k sessions, nothing the report reads describes fewer
than k sessions: a facet (an agent host, a release) with fewer is left out,
and so is any row that tells a sequence or a word fewer share; variants below
it are counted together as "other". The default, 1, shows everything, for
whoever reads their own spans; a report shared beyond the people whose spans
it reads should set one.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import duckdb

from . import content, markov, sufficiency
from .store import sql

#: Tables whose rows tell a sequence or a word, and so need `min_sessions` sessions.
THRESHOLDED = {
    "a_variants",
    "a_collocations",
    "a_schema",
    "a_unknown_arguments",
    "a_options",
    "a_tool_use_dfg",
    "a_failure_runs",
    "a_errors",
}

#: The report's files, from the analyses' tables.
TABLES = {
    "weekly": "a_weekly",
    "tools": "a_tools",
    "dfg": "a_dfg",
    "tool-use-dfg": "a_tool_use_dfg",
    "variants": "a_variants",
    "recovery": "a_recovery",
    "schema": "a_schema",
    "unknown-arguments": "a_unknown_arguments",
    "options": "a_options",
    "discovery": "a_discovery",
    "evaluate": "a_evaluate",
    "collocations": "a_collocations",
    "tests": "a_tests",
    "latency": "a_latency",
    "output": "a_output",
    "sessions": "a_sessions",
    "failure-runs": "a_failure_runs",
    "more-results": "a_more_results",
    "compile-to-green": "a_compile_to_green",
    "next-entropy": "a_next_entropy",
    "errors": "a_errors",
    "time-split": "a_time_split",
    "agent-time": "a_agent_time",
    "answer-time": "a_answer_time",
    "hours": "a_hours",
    "traces": "a_traces",
    "host": "a_host",
    "tokens": "a_tokens",
}


def build(connection: duckdb.DuckDBPyConnection, facets: list[str] | None = None) -> None:
    """The analyses; `facets` names resource attributes to facet by besides."""
    connection.execute("CREATE OR REPLACE TABLE custom_facets (key VARCHAR)")
    for key in facets or []:
        connection.execute("INSERT INTO custom_facets VALUES (?)", [key])
    connection.execute(sql("analyses"))


def rows(connection: duckdb.DuckDBPyConnection, query: str, params: list | None = None) -> dict[str, Any]:
    result = connection.execute(query, params or [])
    columns = [d[0] for d in result.description]
    return {"columns": columns, "rows": [[plain(v) for v in row] for row in result.fetchall()]}


#: What a filter keeps in place of a value its catalog does not name (a tool
#: a later release added, an agent host not listed), and how the report says it.
UNNAMED = ("_OTHER", "(other)")


def plain(value: Any) -> Any:
    if isinstance(value, str):
        return value.replace(*UNNAMED)
    if isinstance(value, list):
        return [plain(v) for v in value]
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, float):
        return None if math.isnan(value) else round(value, 6)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def kept_facets(connection: duckdb.DuckDBPyConnection, min_sessions: int) -> None:
    connection.execute(
        "CREATE OR REPLACE TEMP TABLE kept AS SELECT facet, facet_value FROM facets WHERE facet = 'all' OR sessions >= ?",
        [min_sessions],
    )


def table(connection: duckdb.DuckDBPyConnection, name: str, min_sessions: int) -> dict[str, Any]:
    where = "TRUE"
    if name in THRESHOLDED:
        where = f"sessions >= {int(min_sessions)}"
    query = f"SELECT t.* FROM {name} t JOIN kept USING (facet, facet_value) WHERE {where}"
    data = rows(connection, query)
    if name == "a_variants":
        other = connection.execute(
            f"""SELECT facet, facet_value, 'other variants' AS variant, NULL AS length,
                       sum(sessions) AS sessions, sum(sessions_failed) AS sessions_failed
                FROM {name} JOIN kept USING (facet, facet_value)
                WHERE sessions < ? GROUP BY ALL""",
            [min_sessions],
        ).fetchall()
        data["rows"].extend([[plain(v) for v in row] for row in other])
    return data


def cumulative_incidence(observations: list[tuple[int, bool, int]]) -> list[tuple[int, float, float, int]]:
    """Aalen-Johansen, with two competing outcomes: the tool worked, or the session ended first.

    Each observation is (calls, worked, count). Answers, at each number of
    calls, the share of failures whose tool had worked by then, and the share
    whose session had ended without it; counting the ends as censored would
    overstate recovery.
    """
    at_risk = sum(n for _, _, n in observations)
    still, worked, ended = 1.0, 0.0, 0.0
    points = [(0, 0.0, 0.0, at_risk)]
    for time in sorted({t for t, _, _ in observations}):
        recovered = sum(n for t, r, n in observations if t == time and r)
        gave_up = sum(n for t, r, n in observations if t == time and not r)
        if at_risk:
            worked += still * recovered / at_risk
            ended += still * gave_up / at_risk
            still *= 1 - (recovered + gave_up) / at_risk
        at_risk -= recovered + gave_up
        points.append((time, round(worked, 6), round(ended, 6), at_risk))
    return points


def incidence_curves(connection: duckdb.DuckDBPyConnection, table_name: str, group: str) -> dict[str, Any]:
    groups: dict[tuple, list] = defaultdict(list)
    query = f"SELECT facet, facet_value, {group}, calls, {'recovered' if table_name == 'a_recovery_times' else 'reached'}, " \
            f"{'failures' if table_name == 'a_recovery_times' else 'sessions'} FROM {table_name} JOIN kept USING (facet, facet_value)"
    for facet, value, kind, calls, reached, count in connection.execute(query).fetchall():
        groups[(facet, value, kind)].append((calls, reached, count))
        if kind != "all":
            groups[(facet, value, "all")].append((calls, reached, count))
    rows_out = [
        [facet, plain(value), kind, time, worked, ended, at_risk]
        for (facet, value, kind), observations in groups.items()
        for time, worked, ended, at_risk in cumulative_incidence(observations)
    ]
    return {"columns": ["facet", "facet_value", "group", "calls", "reached", "ended", "at_risk"], "rows": rows_out}


def published_tools(catalog: Path) -> dict[str, Any]:
    """The tools that exist, for those nobody called: a catalog as pharo-agent-telemetry writes it
    (its `MCP tools` and `PLexus tools` sets), or a JSON list of tool names."""
    data = json.loads(catalog.read_text())
    if isinstance(data, list):
        return {"columns": ["component", "tool"], "rows": [[None, tool] for tool in data]}
    sets = data.get("sets", {})
    out = []
    for component in ("MCP", "PLexus"):
        for tool in sets.get(f"{component} tools", []):
            out.append([component, tool])
    return {"columns": ["component", "tool"], "rows": out}


def records(dicts: list[dict], facet: str, value: str, columns: list[str] | None = None) -> dict[str, Any]:
    """Rows of dicts as a report file's columns and rows, under their facet."""
    columns = columns or (list(dicts[0]) if dicts else [])
    return {"columns": ["facet", "facet_value", *columns],
            "rows": [[facet, plain(value), *(plain(d.get(c)) for c in columns)] for d in dicts]}


def merge(files: list[dict[str, Any]]) -> dict[str, Any]:
    columns = next((f["columns"] for f in files if f["rows"]), ["facet", "facet_value"])
    return {"columns": columns, "rows": [row for f in files for row in f["rows"]]}


def markov_files(connection: duckdb.DuckDBPyConnection, min_sessions: int, max_order: int = 3,
                 max_phases: int = 6) -> dict[str, dict[str, Any]]:
    """The Markov models of each kept facet: the chain's order, memory beyond
    one call, what the chain expects after a failure, and hidden phases."""
    observed = {
        (f, v, t): (n, k, s, m, ms) for f, v, t, n, k, s, m, ms in connection.execute(
            "SELECT facet, facet_value, tool, count(*), count(recovered_at), count(DISTINCT session_id), "
            "quantile_cont(recovered_at - step, 0.5), quantile_cont(recovered_ms, 0.5) "
            "FROM recoveries GROUP BY ALL").fetchall()
    }
    out: dict[str, list] = defaultdict(list)
    # A facet holding the same calls as another (one release among all
    # calls) gets the same models: fitted once.
    fitted: dict[tuple, tuple] = {}
    for (facet, value), seqs in sorted(markov.sequences(connection).items()):
        key = tuple(tuple(seq) for seq in seqs)
        if key not in fitted:
            tools = [[c[0] for c in seq] for seq in seqs]
            fitted[key] = (markov.order_test(tools, max_order), markov.memory(tools), markov.recovery(seqs),
                           markov.phases(seqs, max_phases))
        order, memory, chain, (fits, phases, transitions, places) = fitted[key]
        out["markov-order"].append(records(order, facet, value))
        out["markov-memory"].append(records([m for m in memory if m["sessions"] >= min_sessions][:40], facet, value))
        recovery = []
        for row in chain:
            n, k, s, m, ms = observed.get((facet, value, row["tool"]), (0, 0, 0, None, None))
            recovery.append({**row, "failures": n, "recovered": k, "sessions": s, "median_calls": m,
                             "median_seconds": None if ms is None else ms / 1000})
        out["markov-recovery"].append(records(recovery, facet, value))
        out["phase-fits"].append(records(fits, facet, value))
        out["phases"].append(records(phases, facet, value))
        out["phase-transitions"].append(records(transitions, facet, value))
        out["phase-places"].append(records(places, facet, value))
    return {name: merge(parts) for name, parts in out.items()}


def evaluate_words(connection: duckdb.DuckDBPyConnection, min_sessions: int) -> dict[str, Any]:
    """The classes and messages of the code agents asked evaluate to run, when
    content was captured: per facet, the calls and sessions naming each, and
    how many came right after a failed call. Words fewer sessions share than
    the threshold are not written."""
    counts: dict[tuple, dict[str, Any]] = {}
    for facet, value, session, prev_failed, arguments in connection.execute(
        "SELECT facet, facet_value, session_id, coalesce(prev_failed, FALSE), content_arguments FROM faceted "
        "JOIN kept USING (facet, facet_value) WHERE tool = 'evaluate' AND content_arguments IS NOT NULL"
    ).fetchall():
        code = content.code_of(arguments)
        if not code:
            continue
        classes, messages = content.words(code)
        for kind, names in (("class", classes), ("message", messages)):
            for name in names:
                entry = counts.setdefault((facet, value, kind, name), {"calls": 0, "sessions": set(), "after_failure": 0})
                entry["calls"] += 1
                entry["sessions"].add(session)
                entry["after_failure"] += bool(prev_failed)
    columns = ["facet", "facet_value", "kind", "name", "calls", "sessions", "after_failure"]
    out = [[f, plain(v), kind, name, e["calls"], len(e["sessions"]), e["after_failure"]]
           for (f, v, kind, name), e in counts.items() if len(e["sessions"]) >= min_sessions]
    out.sort(key=lambda r: (r[0], r[1], r[2], -r[4]))
    return {"columns": columns, "rows": out}


def write(connection: duckdb.DuckDBPyConnection, out: Path, min_sessions: int = 1, catalog: Path | None = None,
          max_order: int = 3, max_phases: int = 6) -> dict[str, Any]:
    out.mkdir(parents=True, exist_ok=True)
    kept_facets(connection, min_sessions)
    files = {}
    for file, name in TABLES.items():
        files[file] = table(connection, name, min_sessions)
    files["recovery-curves"] = incidence_curves(connection, "a_recovery_times", "error_kind")
    files["green-curves"] = incidence_curves(connection, "a_compile_to_green", "'all'")
    files["releases"] = rows(connection, "SELECT * FROM a_releases WHERE sessions >= ? ORDER BY component, tool, release", [min_sessions])
    files["facets"] = rows(connection, "SELECT f.* FROM facets f JOIN kept USING (facet, facet_value) ORDER BY facet, calls DESC")
    files["images"] = rows(connection, "SELECT * FROM a_images WHERE sessions >= ? ORDER BY spans DESC", [min_sessions])
    files.update(markov_files(connection, min_sessions, max_order, max_phases))
    files["evaluate-words"] = evaluate_words(connection, min_sessions)
    if catalog:
        files["published"] = published_tools(catalog)
    totals = connection.execute(
        "SELECT count(*), count(DISTINCT session_id), min(start_time), max(start_time), count(*) FILTER (WHERE failed) FROM steps"
    ).fetchone()
    meta = {
        "generated": datetime.now(UTC).isoformat(timespec="seconds"),
        "calls": totals[0],
        "sessions": totals[1],
        "first": plain(totals[2]),
        "last": plain(totals[3]),
        "failed": totals[4],
        "minSessions": min_sessions,
        "period": connection.execute("SELECT unit FROM period").fetchone()[0],
        "timePrecise": bool(connection.execute("SELECT coalesce(bool_and(time_precise), FALSE) FROM steps").fetchone()[0]),
        "filtered": bool(connection.execute("SELECT count(*) FILTER (WHERE filter_version IS NOT NULL) > 0 FROM spans").fetchone()[0]),
        "content": bool(connection.execute(
            "SELECT count(*) > 0 FROM spans WHERE json_exists(attributes, '$.\"gen_ai.tool.call.arguments\"')").fetchone()[0]),
        "spans": connection.execute("SELECT count(*) FROM spans").fetchone()[0],
        # What these spans hold beyond what every export keeps: each view that needs one says so.
        "sessionTime": bool(connection.execute("SELECT count(agent_ms) > 0 FROM steps").fetchone()[0]),
        "callerContext": bool(connection.execute("SELECT count(*) FILTER (WHERE caller_span_id IS NOT NULL) > 0 FROM steps").fetchone()[0]),
        "hostSpans": bool(connection.execute("SELECT count(*) > 0 FROM host_spans").fetchone()[0]),
        "tokens": bool(connection.execute("SELECT count(*) > 0 FROM session_tokens").fetchone()[0]),
        "evaluateCode": bool(connection.execute(
            "SELECT count(*) > 0 FROM steps WHERE tool = 'evaluate' AND content_arguments IS NOT NULL").fetchone()[0]),
        "customFacets": [k for (k,) in connection.execute("SELECT key FROM custom_facets").fetchall()],
        # A share of fewer observations than this is known to worse than ±ROUGH: the views warn.
        "enough": sufficiency.ENOUGH,
        "rough": sufficiency.ROUGH,
    }
    files["meta"] = meta
    files["warnings"] = sufficiency.warnings(files, meta)
    for file, data in files.items():
        (out / f"{file}.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    return meta
