"""From spans to calls, the event log and the report's data."""

import json
import sqlite3
from itertools import count

import pytest

from pharo_agent_analytics import documents, ocel, report, store

ids = count(1)
WEEK = "2026-11-16T00:00:00.000000Z"


def span(scope, kind, tool, trace, session, offset, parent=None, status="unset", **attributes):
    """A document as the import indexes it."""
    span_id = f"s{next(ids):04d}"
    document = {
        "@timestamp": WEEK,
        "duration_ms": 10.0,
        "trace_id": trace,
        "span_id": span_id,
        **({"parent_span_id": parent} if parent else {}),
        "name": f"tools/call {tool}",
        "kind": kind,
        "status": status,
        "scope": {"name": scope, "version": "1"},
        "resource": {"service.name": "plexus" if scope.startswith("@") else "pharo-mcp",
                     "service.version": "0.23.0" if scope.startswith("@") else "4.5.0"},
        "attributes": {"session.id": session, "mcp.method.name": "tools/call", "gen_ai.tool.name": tool,
                       "pharo_agent_telemetry.session.offset_ms": offset, **attributes},
    }
    return {"_id": documents.document_id(document), **document}, span_id


def through_plexus(tool, trace, session, offset, image_status="unset", **image_attributes):
    """A call PLexus forwarded: its server span, its client span, the image's span."""
    server, server_id = span("@evref-bl/plexus", "server", tool, trace, session, offset,
                             **{"plexus.client.name": "claude-code", "plexus.call.forwarded": True})
    client, client_id = span("@evref-bl/plexus", "client", tool, trace, session, offset, parent=server_id)
    image, _ = span("mcp-pharo", "server", tool, trace, session, offset + 1, parent=client_id,
                    status=image_status, **{"pharo.mcp.tool.origin": "mcp", **image_attributes})
    return [server, client, image]


@pytest.fixture
def connection():
    connection = store.connect(":memory:")
    docs = [
        *through_plexus("class_get", "t1", "a", 0),
        *through_plexus("method_compile", "t2", "a", 1000, **{"error.type": "-32602", "pharo.mcp.error.kind": "input_schema",
                                                                "pharo.mcp.error.schema.paths": ["/source"],
                                                                "pharo.mcp.argument.names": ["class", "source"]}),
        *through_plexus("method_compile", "t3", "a", 2000, **{"pharo.mcp.argument.names": ["class", "source", "protocol"]}),
        *through_plexus("tool_search", "t4", "b", 0, **{"pharo.mcp.tool.refs": ["test_run"], "pharo.mcp.result.count": 1}),
        *through_plexus("test_run", "t5", "b", 500, **{"pharo.mcp.test.outcome": "passed"}),
    ]
    # tool_call dispatching evaluate, straight to the image, without PLexus.
    outer, outer_id = span("mcp-pharo", "server", "tool_call", "t6", "c", 0)
    inner, _ = span("mcp-pharo", "server", "evaluate", "t6", "c", 1, parent=outer_id, **{"pharo.mcp.dispatch_path": "via_tool_call"})
    docs += [outer, inner]
    assert store.load_documents(connection, docs) == len(docs)
    store.build_model(connection)
    return connection


def test_a_span_loaded_twice_is_one(connection):
    doc, _ = span("mcp-pharo", "server", "class_get", "t9", "z", 0)
    assert store.load_documents(connection, [doc, doc]) == 1
    assert store.load_documents(connection, [doc]) == 0


def test_otlp_requests_become_the_imports_documents():
    request = {"resourceSpans": [{
        "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "pharo-mcp"}},
                                    {"key": "fileexporter.path_segment", "value": {"stringValue": "2026-11-20"}}]},
        "scopeSpans": [{"scope": {"name": "mcp-pharo"}, "spans": [{
            "traceId": "t", "spanId": "s", "name": "tools/call class_get", "kind": 2,
            "startTimeUnixNano": "1795000000000000000", "status": {"code": 2},
            "attributes": [{"key": "span.duration_ms", "value": {"doubleValue": 12}},
                           {"key": "pharo.mcp.argument.names", "value": {"arrayValue": {"values": [{"stringValue": "class"}]}}}],
        }]}],
    }]}
    [doc] = documents.otlp_documents(request)
    assert doc["kind"] == "server" and doc["status"] == "error" and doc["duration_ms"] == 12
    assert doc["resource"] == {"service.name": "pharo-mcp"}
    assert doc["attributes"] == {"pharo.mcp.argument.names": ["class"]}
    assert doc["_id"].startswith("t-s-")


def test_a_call_through_plexus_is_one_call_named_by_the_image(connection):
    rows = connection.execute("SELECT tool, entry, host, mcp_version, plexus_version FROM calls WHERE session_id = 'a' ORDER BY seq").fetchall()
    assert rows == [("class_get", "plexus", "claude-code", "4.5.0", "0.23.0"),
                    ("method_compile", "plexus", "claude-code", "4.5.0", "0.23.0"),
                    ("method_compile", "plexus", "claude-code", "4.5.0", "0.23.0")]


def test_a_refused_argument_is_a_failed_call(connection):
    assert connection.execute("SELECT list(failed ORDER BY seq) FROM calls WHERE session_id = 'a'").fetchone()[0] == [False, True, False]


def test_a_call_the_image_refused_as_the_callers_fault_says_its_code():
    # The image's span has no error.type for -32602, as the conventions ask of a server; PLexus's client span
    # has it, and PLexus answered the agent with a tool result.
    connection = store.connect(":memory:")
    server, server_id = span("@evref-bl/plexus", "server", "clas_get", "t9", "z", 0, status="error",
                             **{"plexus.call.forwarded": True, "error.type": "tool_error"})
    client, client_id = span("@evref-bl/plexus", "client", "clas_get", "t9", "z", 0, parent=server_id, status="error",
                             **{"error.type": "-32602", "rpc.status_code": "-32602"})
    image, _ = span("mcp-pharo", "server", "clas_get", "t9", "z", 1, parent=client_id,
                    **{"pharo.mcp.tool.origin": "unknown", "pharo.mcp.error.kind": "json_rpc", "rpc.status_code": "-32602"})
    assert store.load_documents(connection, [server, client, image]) == 3
    store.build_model(connection)
    assert connection.execute("SELECT error_type, rpc_status_code, failed FROM calls").fetchone() == ("-32602", "-32602", True)


def test_a_dispatched_call_is_its_own_and_marked(connection):
    rows = connection.execute("SELECT tool, entry, dispatched FROM calls WHERE session_id = 'c' ORDER BY seq").fetchall()
    assert rows == [("tool_call", "image", False), ("evaluate", "dispatch", True)]


@pytest.fixture
def analysed(connection):
    report.build(connection)
    return connection


def test_a_retry_with_other_arguments_that_works_is_a_recovery(analysed):
    rows = analysed.execute("SELECT error_kind, next_action, outcome FROM a_recovery WHERE facet = 'all'").fetchall()
    assert rows == [("input_schema", "same tool, other arguments", "the tool worked later")]


def test_a_search_followed_by_the_tool_it_named(analysed):
    assert analysed.execute("SELECT found, followed FROM a_discovery WHERE facet = 'all'").fetchall() == [("1", True)]


def test_steps_leave_out_dispatched_calls(analysed):
    assert analysed.execute("SELECT list(tool) FROM steps WHERE session_id = 'c'").fetchone()[0] == ["tool_call"]


def test_cumulative_incidence_with_a_competing_end():
    # Four failures: two recover after 1 call, one after 3, one session ends after 2.
    points = report.cumulative_incidence([(1, True, 2), (2, False, 1), (3, True, 1)])
    assert points[0] == (0, 0.0, 0.0, 4)
    assert points[1] == (1, 0.5, 0.0, 2)
    assert points[2] == (2, 0.5, 0.25, 1)
    assert points[3] == (3, 0.75, 0.25, 0)


def test_rare_variants_are_counted_together_never_shown(analysed, tmp_path):
    report.write(analysed, tmp_path, min_sessions=2)
    variants = json.loads((tmp_path / "variants.json").read_text())
    names = [row[variants["columns"].index("variant")] for row in variants["rows"]]
    # Each session's sequence is its own: every facet shows only their count.
    assert set(names) == {"other variants"}
    facets = json.loads((tmp_path / "facets.json").read_text())
    assert all(row[0] == "all" or row[3] >= 2 for row in facets["rows"])


def test_the_event_log_is_ocel_2(analysed, tmp_path):
    ocel.build(analysed)
    ocel.write_sqlite(analysed, tmp_path / "log.sqlite")
    ocel.write_json(analysed, tmp_path / "log.json")
    db = sqlite3.connect(tmp_path / "log.sqlite")
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"event", "object", "event_object", "object_object", "event_map_type", "object_map_type"} <= tables
    assert db.execute("SELECT count(*) FROM event").fetchone()[0] == analysed.execute("SELECT count(*) FROM calls").fetchone()[0]
    # Every event is in a session; a search names the tool use it leads to.
    assert db.execute("SELECT count(*) FROM event WHERE ocel_id NOT IN (SELECT ocel_event_id FROM event_object WHERE ocel_qualifier = 'in')").fetchone()[0] == 0
    named = db.execute("SELECT ocel_object_id FROM event_object WHERE ocel_qualifier = 'names'").fetchall()
    assert named == [("tool use:b/test_run",)]
    log = json.loads((tmp_path / "log.json").read_text())
    assert {"objectTypes", "eventTypes", "objects", "events"} <= log.keys()
    assert len(log["events"]) == db.execute("SELECT count(*) FROM event").fetchone()[0]


def test_a_value_the_filter_could_not_name_reads_as_other():
    assert report.plain("_OTHER") == "(other)"
    assert report.plain(["evaluate", "_OTHER"]) == ["evaluate", "(other)"]


def test_the_report_carries_the_markov_models_of_every_facet(analysed, tmp_path):
    report.write(analysed, tmp_path, max_phases=3)
    read = lambda name: json.loads((tmp_path / f"{name}.json").read_text())
    order = read("markov-order")
    assert {"order", "aic", "bic", "heldout_bits", "chosen_by"} <= set(order["columns"])
    assert {row[0] for row in order["rows"]} >= {"all"}
    fits = read("phase-fits")
    assert sorted({row[fits["columns"].index("phases")] for row in fits["rows"]}) == [1, 2, 3]
    for name in ("markov-memory", "markov-recovery", "phases", "phase-transitions", "phase-places"):
        assert read(name)["columns"][:2] == ["facet", "facet_value"]
    dfg = read("dfg")
    share, facet, value, source = (dfg["columns"].index(c) for c in ("share", "facet", "facet_value", "source"))
    totals = {}
    for row in dfg["rows"]:
        key = (row[facet], row[value], row[source])
        totals[key] = totals.get(key, 0) + row[share]
    assert all(abs(t - 1) < 1e-4 for t in totals.values()), totals  # shares are written to six decimals


def test_a_filtered_export_still_makes_every_file_and_says_what_it_lacks(analysed, tmp_path):
    meta = report.write(analysed, tmp_path, max_phases=2)
    assert not any(meta[k] for k in ("timePrecise", "callerContext", "hostSpans", "tokens", "evaluateCode", "content"))
    for name in ("time-split", "agent-time", "answer-time", "hours", "traces", "host", "tokens", "evaluate-words"):
        data = json.loads((tmp_path / f"{name}.json").read_text())
        assert "rows" in data
    for name in ("hours", "traces", "host", "tokens", "evaluate-words"):
        assert json.loads((tmp_path / f"{name}.json").read_text())["rows"] == []


def test_a_forwarded_call_without_an_image_span_says_why():
    connection = store.connect(":memory:")
    forwarded = {"plexus.client.name": "claude-code", "plexus.call.forwarded": True}
    docs = [
        span("@evref-bl/plexus", "server", "evaluate", "u1", "d", 0, **forwarded, **{"plexus.image.telemetry": "no-backend"})[0],
        span("@evref-bl/plexus", "server", "evaluate", "u2", "d", 10, **forwarded, **{"plexus.image.telemetry": "on"})[0],
        span("@evref-bl/plexus", "server", "evaluate", "u3", "d", 20, status="error",
             **forwarded, **{"plexus.error.code": "no-image-running"})[0],
        span("@evref-bl/plexus", "server", "evaluate", "u4", "d", 30, **forwarded)[0],
        *through_plexus("class_get", "u5", "d", 40),
        span("@evref-bl/plexus", "server", "image_list", "u6", "d", 50,
             **{"plexus.client.name": "claude-code", "plexus.call.forwarded": False})[0],
    ]
    store.load_documents(connection, docs)
    store.build_model(connection)
    assert connection.execute("SELECT list(no_image_span ORDER BY seq) FROM calls").fetchone()[0] == [
        "image does not record", "recording failed or span lost", "refused by PLexus", "not said", None, None]
