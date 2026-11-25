"""Everything an unfiltered export can hold: real times, the caller's trace
context, the agent host's own spans by the GenAI conventions, captured
content and resource attributes of one's own."""

import json

import pytest

from pharo_agent_analytics import cli, markov, report, store
from test_full_telemetry import T0, SECOND, attrs

MS = SECOND // 1000


def span(trace, span_id, name, start_ms, ms, parent=None, kind=1, error=False, **attributes):
    return {
        "traceId": trace, "spanId": span_id, "parentSpanId": parent or "", "name": name, "kind": kind,
        "startTimeUnixNano": str(T0 + start_ms * MS), "endTimeUnixNano": str(T0 + (start_ms + ms) * MS),
        "attributes": attrs(**attributes), "status": {"code": 2, "message": "failed"} if error else {},
    }


def call(span_id, parent, tool, start_ms, ms, error=False, code=None):
    extra = {"gen_ai.tool.call.arguments": json.dumps({"code": code})} if code else {}
    if error:
        extra.update({"error.type": "tool_error", "pharo.mcp.error.kind": "domain",
                      "pharo.mcp.error.code": "EvaluationRuntimeError"})
    return span("h1", span_id, f"tools/call {tool}", start_ms, ms, parent=parent, kind=2, error=error, **{
        "mcp.method.name": "tools/call", "gen_ai.tool.name": tool, "session.id": "y",
        "pharo.mcp.tool.origin": "mcp", "pharo.mcp.client.name": "agent-host", "pharo.mcp.client.version": "3.2.0",
        "pharo.mcp.output.bytes": 900, **extra})


CODE = "Smalltalk at: #Foo put: 3"


def requests():
    host = [
        span("h1", "ia", "invoke_agent coder", 0, 60_000, **{"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "coder"}),
        span("h1", "c1", "chat model-x", 0, 2_000, parent="ia", **{
            "gen_ai.operation.name": "chat", "gen_ai.request.model": "model-x", "gen_ai.provider.name": "acme",
            "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 50}),
        span("h1", "e1", "execute_tool evaluate", 2_000, 500, parent="ia", **{"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "evaluate"}),
        span("h1", "c2", "chat model-x", 3_000, 2_000, parent="ia", **{
            "gen_ai.operation.name": "chat", "gen_ai.request.model": "model-x",
            "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 40}),
        span("h1", "e2", "execute_tool evaluate", 5_000, 400, parent="ia", **{"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "evaluate"}),
        span("h1", "e3", "execute_tool class_get", 5_290, 120, parent="ia", **{"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "class_get"}),
        span("h1", "e4", "execute_tool method_get", 5_410, 120, parent="ia", **{"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "method_get"}),
    ]
    image = [
        call("i1", "e1", "evaluate", 2_100, 300, error=True, code=CODE),
        call("i2", "e2", "evaluate", 5_050, 300, code=CODE),
        call("i3", "e3", "class_get", 5_300, 100),     # starts before i2 ends: the calls overlap
        call("i4", "e4", "method_get", 5_420, 100),    # 20 ms after i3 ends: asked together with it
    ]
    return [
        {"resourceSpans": [{
            "resource": {"attributes": attrs(**{"service.name": "agent-host", "service.version": "3.2.0"})},
            "scopeSpans": [{"scope": {"name": "agent-host-sdk"}, "spans": host}]}]},
        {"resourceSpans": [{
            "resource": {"attributes": attrs(**{
                "service.name": "pharo-mcp", "service.version": "4.6.0", "os.type": "linux", "team": "tools",
                "process.runtime.version": "Pharo-14.0.0+SNAPSHOT.build.800 (64 Bit)",
                "process.runtime.description": "VM build 123"})},
            "scopeSpans": [{"scope": {"name": "mcp-pharo", "version": "4.6.0"}, "spans": image}]}]},
    ]


@pytest.fixture
def connection(tmp_path):
    path = tmp_path / "export.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in requests()))
    database = tmp_path / "spans.duckdb"
    assert cli.main(["--database", str(database), "load", str(path)]) == 0
    connection = store.connect(database)
    store.build_model(connection)
    report.build(connection, ["team"])
    return connection


def one(connection, query):
    return connection.execute(query).fetchall()


def test_calls_know_their_host_model_and_agent(connection):
    assert one(connection, "SELECT DISTINCT model, provider, agent_name FROM calls") == [("model-x", "acme", "coder")]
    assert one(connection, "SELECT count(*) FROM calls WHERE caller_span_id IS NOT NULL") == [(4,)]
    assert one(connection, "SELECT round(host_duration_ms - duration_ms) FROM calls WHERE tool = 'evaluate' ORDER BY seq") == [(200.0,), (100.0,)]


def test_facets_by_model_agent_os_vm_and_ones_own(connection):
    facets = dict(one(connection, "SELECT facet, facet_value FROM facets WHERE facet <> 'all' AND facet <> 'host'"))
    assert facets["model"] == "model-x" and facets["agent"] == "coder" and facets["team"] == "tools"
    assert facets["OS"] == "linux" and facets["VM"] == "VM build 123"


def test_the_tokens_of_the_session(connection):
    assert one(connection, "SELECT input_tokens, output_tokens, model_calls FROM session_tokens") == [(2200, 90, 2)]
    assert one(connection, "SELECT tool_calls, input_tokens FROM a_tokens WHERE facet = 'all'") == [(4, 2200)]


def test_the_agents_time_and_calls_sent_together_or_at_once(connection):
    rows = {r[0]: r[1:] for r in one(connection,
            "SELECT tool, agent_p50_ms, sent_together, overlapped FROM a_time_split WHERE facet = 'all'")}
    assert rows["evaluate"] == (2650.0, 0, 1)
    assert rows["class_get"] == (None, 1, 0)
    assert one(connection, "SELECT sum(calls) FROM a_hours WHERE facet = 'all'") == [(4,)]


def test_one_trace_of_the_caller_holds_the_turn(connection):
    assert one(connection, "SELECT calls, traces, with_failure, ended_working FROM a_traces WHERE facet = 'all'") == [(4, 1, 1, 1)]


def test_a_repeat_is_the_same_arguments_when_content_was_captured(connection):
    assert one(connection, "SELECT next_action FROM recoveries WHERE facet = 'all'") == [("same call again",)]


def test_the_report_holds_everything_and_says_so(connection, tmp_path):
    meta = report.write(connection, tmp_path, max_phases=2)
    assert all(meta[k] for k in ("timePrecise", "sessionTime", "callerContext", "hostSpans", "tokens", "evaluateCode", "content"))
    assert meta["customFacets"] == ["team"]
    words = json.loads((tmp_path / "evaluate-words.json").read_text())
    named = {(r[2], r[3]): (r[4], r[6]) for r in words["rows"] if r[0] == "all"}
    assert named == {("class", "Smalltalk"): (2, 1), ("message", "at:put:"): (2, 1)}
    chain = json.loads((tmp_path / "markov-recovery.json").read_text())
    row = dict(zip(chain["columns"], next(r for r in chain["rows"] if r[0] == "all")))
    assert row["seconds_if_works"] == pytest.approx(2.95) and row["median_seconds"] == pytest.approx(2.95)



def test_the_event_log_holds_the_trace_the_agent_and_the_model(connection, tmp_path):
    from pharo_agent_analytics import ocel
    ocel.build(connection)
    types = dict(one(connection, "SELECT type, count(*) FROM ocel_objects GROUP BY type"))
    assert types["trace"] == 1 and types["agent"] == 1 and types["model"] == 1
    assert one(connection, "SELECT DISTINCT qualifier FROM ocel_relations WHERE object_id LIKE 'model:%'") == [("chosen by",)]
    ocel.write_sqlite(connection, tmp_path / "log.sqlite")
