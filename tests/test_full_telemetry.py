"""Spans as the tools send them, with no filter between: real times, error messages, full versions."""

import json

import pytest

from pharo_agent_analytics import cli, documents, ocel, report, store

T0 = 1_795_600_000_000_000_000  # nanoseconds, a Tuesday afternoon
SECOND = 1_000_000_000


def value(v):
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": str(v)}
    if isinstance(v, list):
        return {"arrayValue": {"values": [value(x) for x in v]}}
    return {"stringValue": v}


def attrs(**kv):
    return [{"key": k.replace("__", "."), "value": value(v)} for k, v in kv.items()]


def image_span(trace, span, tool, start, seconds, session, error=None, message=None, **extra):
    span_doc = {
        "traceId": trace, "spanId": span, "name": f"tools/call {tool}", "kind": 2,
        "startTimeUnixNano": str(start), "endTimeUnixNano": str(start + int(seconds * SECOND)),
        "attributes": attrs(**{"mcp.method.name": "tools/call", "gen_ai.tool.name": tool, "session.id": session,
                               "pharo.mcp.tool.origin": "mcp", "pharo.mcp.client.name": "claude-code",
                               "pharo.mcp.client.version": "2.1.34", "jsonrpc.request.id": span}),
        "status": {"code": 2, "message": message} if error else {},
    }
    if error:
        span_doc["attributes"] += attrs(**{"error.type": error, "pharo.mcp.error.kind": "domain",
                                           "pharo.mcp.error.code": "CompileSyntaxError"})
    span_doc["attributes"] += attrs(**extra)
    return span_doc


def request(spans):
    return {"resourceSpans": [{
        "resource": {"attributes": attrs(**{"service.name": "pharo-mcp", "service.version": "4.5.0",
                                            "process.runtime.version": "Pharo-14.0.0+SNAPSHOT.build.791.sha.42a90c7 (64 Bit)"})},
        "scopeSpans": [{"scope": {"name": "mcp-pharo", "version": "4.5.0"}, "spans": spans}],
    }]}


@pytest.fixture
def connection(tmp_path):
    spans = [
        image_span("a1", "s1", "class_get", T0, 0.2, "x"),
        image_span("a2", "s2", "method_compile", T0 + 30 * SECOND, 0.5, "x", error="-32603",
                   message="Syntax error at 12: 'foo' is not understood"),
        image_span("a3", "s3", "method_compile", T0 + 75 * SECOND, 0.4, "x", error="-32603",
                   message="Syntax error at 40: 'bar' is not understood"),
        image_span("a4", "s4", "method_compile", T0 + 100 * SECOND, 0.3, "x"),
        image_span("a5", "s5", "test_run", T0 + 160 * SECOND, 2.0, "x", **{"pharo.mcp.test.outcome": "passed",
                                                                          "pharo.mcp.output.bytes": 3000}),
    ]
    # A trace store's answer wraps the request, written over several lines.
    path = tmp_path / "trace.json"
    path.write_text(json.dumps({"result": request(spans[:2])}, indent=2))
    lines = tmp_path / "archive.jsonl"
    lines.write_text(json.dumps(request(spans[2:])) + "\n")
    database = tmp_path / "spans.duckdb"
    assert cli.main(["--database", str(database), "load", str(path), str(lines)]) == 0
    connection = store.connect(database)
    store.build_model(connection)
    report.build(connection)
    return connection


def test_times_are_kept_and_order_the_session(connection):
    rows = connection.execute("SELECT tool, time_precise, duration_ms FROM calls ORDER BY seq").fetchall()
    assert [r[0] for r in rows] == ["class_get", "method_compile", "method_compile", "method_compile", "test_run"]
    assert all(r[1] for r in rows)
    assert rows[0][2] == pytest.approx(200)


def test_the_time_between_calls_is_real(connection):
    gaps = connection.execute("SELECT list(gap_ms ORDER BY step) FROM steps").fetchone()[0]
    assert gaps == [None, 30_000, 45_000, 25_000, 60_000]
    assert connection.execute("SELECT unit FROM period").fetchone()[0] == "day"


def test_versions_compare_at_major_minor(connection):
    assert connection.execute("SELECT DISTINCT pharo_release, host_release FROM calls").fetchall() == [("14.0", "2.1")]
    facets = {f for (f,) in connection.execute("SELECT DISTINCT facet || ' ' || facet_value FROM facets").fetchall()}
    assert {"Pharo 14.0", "host claude-code 2.1", "MCP 4.5.0"} <= facets


def test_one_message_whatever_it_quoted(connection):
    rows = connection.execute("SELECT code, message, calls FROM a_errors WHERE facet = 'all'").fetchall()
    assert rows == [("CompileSyntaxError", "Syntax error at #: … is not understood", 2)]


def test_answer_sizes_in_powers_of_two(connection):
    assert connection.execute("SELECT output_bytes FROM a_output WHERE facet = 'all'").fetchall() == [(2048,)]


def test_the_event_log_keeps_real_times(connection, tmp_path):
    ocel.build(connection)
    times = connection.execute("SELECT strftime(time, '%H:%M:%S') FROM ocel_events ORDER BY time").fetchall()
    assert len({t for (t,) in times}) == 5
    ocel.write_json(connection, tmp_path / "log.json")
    assert json.loads((tmp_path / "log.json").read_text())["events"][0]["time"].endswith("Z")


def test_the_report_says_the_times_are_kept(connection, tmp_path):
    meta = report.write(connection, tmp_path)
    assert meta["timePrecise"] and not meta["filtered"] and meta["period"] == "day" and meta["minSessions"] == 1


def test_the_collectors_elasticsearch_documents_load(tmp_path):
    doc = {
        "@timestamp": "2026-11-24T14:02:03.123456789Z", "trace_id": "t", "span_id": "s", "name": "tools/call class_get",
        "kind": "Server", "duration": 250_000_000, "status": {"code": "Error", "message": "No class named Foo"},
        "attributes": {"gen_ai.tool.name": "class_get", "session.id": "y", "mcp.method.name": "tools/call",
                       "error.type": "tool_error"},
        "resource": {"attributes": {"service.name": "pharo-mcp", "service.version": "4.5.0"}},
        "scope": {"name": "mcp-pharo", "version": "4.5.0"},
    }
    path = tmp_path / "hits.ndjson"
    path.write_text(json.dumps({"_id": "h1", "_source": doc}) + "\n")
    database = tmp_path / "spans.duckdb"
    assert cli.main(["--database", str(database), "load", str(path)]) == 0
    connection = store.connect(database)
    row = connection.execute("SELECT kind, status, status_message, duration_ms, time_precise, service_version FROM spans").fetchone()
    assert row == ("server", "error", "No class named Foo", 250.0, True, "4.5.0")


def test_a_request_refused_as_the_callers_fault_is_a_failed_call(tmp_path):
    # The conventions leave a server's span unmarked for -32602: only its code says the call was refused.
    spans = [
        image_span("r1", "q1", "class_get", T0, 0.1, "y"),
        image_span("r2", "q2", "clas_get", T0 + 10 * SECOND, 0.1, "y", **{"rpc.status_code": "-32602"}),
    ]
    lines = tmp_path / "refused.jsonl"
    lines.write_text(json.dumps(request(spans)) + "\n")
    database = tmp_path / "spans.duckdb"
    assert cli.main(["--database", str(database), "load", str(lines)]) == 0
    connection = store.connect(database)
    store.build_model(connection)
    rows = connection.execute("SELECT tool, rpc_status_code, failed FROM calls ORDER BY seq").fetchall()
    assert rows == [("class_get", None, False), ("clas_get", "-32602", True)]
