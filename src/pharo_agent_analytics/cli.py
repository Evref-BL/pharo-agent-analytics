"""pharo-agent-analytics: from the Pharo tools' spans to an event log and a report.

    pharo-agent-analytics load FILE...          OTLP JSON (a collector's file exporter, a request) or documents
    pharo-agent-analytics fetch [--since DATE]  from Elasticsearch, with a key that may read
    pharo-agent-analytics build [--out DIR]     the analyses, as the report's data
    pharo-agent-analytics ocel --out DIR        the calls as OCEL 2.0 (SQLite and JSON)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import documents, ocel, report, settings, store
from .elasticsearch import Elasticsearch, ElasticsearchError

DEFAULT_DATABASE = Path(os.environ.get("PHARO_AGENT_ANALYTICS_DB", "data/spans.duckdb"))


def first_line(path: Path) -> str:
    with path.open() as file:
        for line in file:
            if line.strip():
                return line
    return ""


def load(args: argparse.Namespace) -> int:
    connection = store.connect(args.database)
    for path in map(Path, args.files):
        line = first_line(path)
        try:
            first = json.loads(line)
        except ValueError:
            first = None
        if first is None:
            # One JSON value over several lines: an OTLP request, or a trace store's answer.
            docs = list(documents.json_documents(json.loads(path.read_text())))
            print(f"{path.name}: {store.load_documents(connection, docs)} new of {len(docs)} spans")
        elif any(documents.requests_in(first)):
            docs, malformed = documents.archive_documents(path.open())
            new = store.load_documents(connection, docs)
            print(f"{path.name}: {new} new of {len(docs)} spans" + (f", {malformed} lines not a request" if malformed else ""))
        elif "_source" in first or isinstance((first.get("resource") or {}).get("attributes"), dict):
            # Elasticsearch hits, or documents the Collector's exporter wrote.
            with path.open() as file:
                docs = [documents.hit_document(hit if "_source" in hit else {"_id": None, "_source": hit})
                        for hit in map(json.loads, filter(str.strip, file))]
            for doc in docs:
                if doc.get("_id") is None:
                    doc["_id"] = documents.document_id({k: v for k, v in doc.items() if k != "_id"})
            print(f"{path.name}: {store.load_documents(connection, docs)} new of {len(docs)} spans")
        else:
            print(f"{path.name}: {store.load_file(connection, path)} new spans")
    return 0


def fetch(args: argparse.Namespace) -> int:
    values = settings.elasticsearch()
    url, key = values.get("ELASTICSEARCH_URL"), values.get("ELASTICSEARCH_API_KEY")
    if not (url and key):
        print(f"Set ELASTICSEARCH_URL and ELASTICSEARCH_API_KEY (a key that may read the index), "
              f"in the environment or in {settings.settings_file()}.", file=sys.stderr)
        return 2
    if problem := settings.key_problem(key):
        print(problem, file=sys.stderr)
        return 2
    client = Elasticsearch(url, key, values.get("ELASTICSEARCH_CA_FILE"))
    index = args.index or values.get("ELASTICSEARCH_INDEX") or settings.DEFAULT_INDEX
    connection = store.connect(args.database)
    try:
        batch, total, new = [], 0, 0
        for document in client.documents(index, args.since):
            batch.append(document)
            if len(batch) == 10_000:
                new += store.load_documents(connection, batch)
                total += len(batch)
                batch = []
        new += store.load_documents(connection, batch)
        total += len(batch)
        # Calls that carried their caller's trace context: the host's own spans of those traces.
        traces = [t for (t,) in connection.execute(store.CALLER_TRACES).fetchall()]
        hosted = store.load_documents(connection, list(client.related(index, traces))) if traces else 0
    except ElasticsearchError as error:
        print(error, file=sys.stderr)
        return 1
    print(f"{new} new of {total} spans" + (f", and {hosted} of the agent host's in their traces" if hosted else ""))
    return 0


def build(args: argparse.Namespace) -> int:
    connection = store.connect(args.database)
    store.build_model(connection)
    report.build(connection, args.facet)
    meta = report.write(connection, Path(args.out), args.min_sessions, Path(args.catalog) if args.catalog else None,
                        args.max_order, args.max_phases)
    print(json.dumps(meta))
    return 0


def export_ocel(args: argparse.Namespace) -> int:
    connection = store.connect(args.database)
    store.build_model(connection)
    ocel.build(connection)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ocel.write_sqlite(connection, out / "calls.ocel.sqlite")
    ocel.write_json(connection, out / "calls.ocel.json")
    counts = connection.execute(
        "SELECT (SELECT count(*) FROM ocel_events), (SELECT count(DISTINCT id) FROM ocel_objects), (SELECT count(*) FROM ocel_relations)"
    ).fetchone()
    print(f"{counts[0]} events, {counts[1]} objects, {counts[2]} event-object relations in {out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pharo-agent-analytics", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database", default=DEFAULT_DATABASE, type=Path, help="the span store (default %(default)s)")
    commands = parser.add_subparsers(dest="command", required=True)

    command = commands.add_parser("load", help="load documents or OTLP archive files")
    command.add_argument("files", nargs="+")
    command.set_defaults(run=load)

    command = commands.add_parser("fetch", help="read the spans from Elasticsearch")
    command.add_argument("--index", help="the indices or data streams, comma-separated (default: ELASTICSEARCH_INDEX, "
                                          f"else {settings.DEFAULT_INDEX}, the OpenTelemetry Collector exporter's)")
    command.add_argument("--since", help="the first week to read, YYYY-MM-DD (default: all)")
    command.set_defaults(run=fetch)

    command = commands.add_parser("build", help="compute the analyses and write the report's data")
    command.add_argument("--out", default="site/public/data")
    command.add_argument("--min-sessions", type=int, default=1,
                         help="sessions a facet, sequence or word needs to be reported; set it for a report "
                              "read beyond the people whose spans it holds (default %(default)s)")
    command.add_argument("--catalog", help="the tools that exist, for those nobody called: a pharo-agent-telemetry "
                                           "catalog, or a JSON list of names")
    command.add_argument("--max-order", type=int, default=3, help="the longest memory the order test tries (default %(default)s)")
    command.add_argument("--max-phases", type=int, default=6, help="the most hidden phases tried (default %(default)s)")
    command.add_argument("--facet", action="append", default=[], metavar="ATTRIBUTE",
                         help="a resource attribute to compare by besides host, releases, OS, model and agent "
                              "(repeatable), such as deployment.environment.name or a team's own")
    command.set_defaults(run=build)

    command = commands.add_parser("ocel", help="write the calls as OCEL 2.0")
    command.add_argument("--out", required=True)
    command.set_defaults(run=export_ocel)

    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
