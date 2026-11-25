"""Reading spans from Elasticsearch: settings, the key's shape, paging through a point in time."""

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from pharo_agent_analytics import cli, elasticsearch, settings, store

KEY = base64.b64encode(b"id:secret").decode()


class Stub(BaseHTTPRequestHandler):
    """Elasticsearch as far as fetch uses it: open a point in time, page with search_after, close."""

    hits: list = []
    requests: list = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        Stub.requests.append((self.path, body, self.headers.get("Authorization")))
        if "/_pit?" in self.path:
            return self.answer({"id": "pit-1"})
        start = body.get("search_after", [-1])[0] + 1
        page = Stub.hits[start:start + body["size"]]
        return self.answer({"pit_id": "pit-2", "hits": {"hits": page}})

    def do_DELETE(self):
        Stub.requests.append((self.path, None, None))
        return self.answer({"succeeded": True})

    def answer(self, data):
        payload = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


@pytest.fixture
def server(monkeypatch):
    monkeypatch.setattr(elasticsearch, "PAGE", 2)
    Stub.requests = []
    Stub.hits = [
        {"_id": f"d{i}", "sort": [i], "_source": {
            "@timestamp": "2026-11-16T00:00:00.000000Z", "trace_id": f"t{i}", "span_id": f"s{i}",
            "name": "tools/call class_get", "kind": "server", "status": "unset",
            "scope": {"name": "mcp-pharo"}, "resource": {"service.version": "4.5.0"},
            "attributes": {"session.id": "a", "gen_ai.tool.name": "class_get", "pharo_agent_telemetry.session.offset_ms": i},
        }}
        for i in range(5)
    ]
    httpd = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()


def test_every_page_is_read_and_the_point_in_time_closed(server):
    client = elasticsearch.Elasticsearch(server, KEY)
    assert [d["_id"] for d in client.documents("traces-*")] == ["d0", "d1", "d2", "d3", "d4"]
    searches = [body for path, body, _ in Stub.requests if path == "/_search"]
    assert [s.get("search_after") for s in searches] == [None, [1], [3], [4]]
    assert searches[-1]["pit"]["id"] == "pit-2"
    assert Stub.requests[-1][0] == "/_pit"
    assert all(auth == f"ApiKey {KEY}" for path, _, auth in Stub.requests if path != "/_pit")


def test_fetch_loads_the_documents_from_the_settings_file(server, tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.delenv("ELASTICSEARCH_URL", raising=False)
    monkeypatch.delenv("ELASTICSEARCH_API_KEY", raising=False)
    (tmp_path / "pharo-agent-analytics").mkdir()
    (tmp_path / "pharo-agent-analytics" / "elasticsearch.env").write_text(
        f"# read-only key\nELASTICSEARCH_URL={server}\nELASTICSEARCH_API_KEY={KEY}\nELASTICSEARCH_INDEX=study-traces-*\n")
    database = tmp_path / "spans.duckdb"
    assert cli.main(["--database", str(database), "fetch"]) == 0
    assert Stub.requests[0][0].startswith("/study-traces-*/_pit?")
    assert cli.main(["--database", str(database), "fetch"]) == 0
    connection = store.connect(database)
    assert connection.execute("SELECT count(*), count(DISTINCT doc_id) FROM spans").fetchone() == (5, 5)


def test_the_environment_wins_over_the_file(tmp_path, monkeypatch):
    path = tmp_path / "elasticsearch.env"
    path.write_text("ELASTICSEARCH_URL=https://file\nELASTICSEARCH_API_KEY=from-file\n")
    monkeypatch.setenv("ELASTICSEARCH_URL", "https://environment")
    monkeypatch.delenv("ELASTICSEARCH_API_KEY", raising=False)
    assert settings.elasticsearch(path) == {"ELASTICSEARCH_URL": "https://environment", "ELASTICSEARCH_API_KEY": "from-file"}


def test_a_key_that_is_not_the_encoded_field_is_refused():
    assert settings.key_problem(KEY) is None
    assert settings.key_problem("Xy3_a1B2c3D4e5F6g7H8iJ") is not None
