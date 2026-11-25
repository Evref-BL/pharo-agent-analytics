"""pharo-agent-analytics: from the Pharo tools' spans to an event log and a report.

    pharo-agent-analytics load FILE...          documents or a collector's OTLP archive
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

from . import documents, ocel, report, store
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
        if '"resourceSpans"' in first_line(path):
            docs, malformed = documents.archive_documents(path.open())
            new = store.load_documents(connection, docs)
            print(f"{path.name}: {new} new of {len(docs)} spans" + (f", {malformed} lines not a request" if malformed else ""))
        else:
            print(f"{path.name}: {store.load_file(connection, path)} new spans")
    return 0


def fetch(args: argparse.Namespace) -> int:
    url, key = os.environ.get("ELASTICSEARCH_URL"), os.environ.get("ELASTICSEARCH_API_KEY")
    if not (url and key):
        print("Set ELASTICSEARCH_URL and ELASTICSEARCH_API_KEY (a key that may read the index).", file=sys.stderr)
        return 2
    client = Elasticsearch(url, key, os.environ.get("NODE_EXTRA_CA_CERTS") or os.environ.get("SSL_CERT_FILE"))
    connection = store.connect(args.database)
    try:
        batch, total, new = [], 0, 0
        for document in client.documents(f"{args.index}-*", args.since):
            batch.append(document)
            if len(batch) == 10_000:
                new += store.load_documents(connection, batch)
                total += len(batch)
                batch = []
        new += store.load_documents(connection, batch)
        total += len(batch)
    except ElasticsearchError as error:
        print(error, file=sys.stderr)
        return 1
    print(f"{new} new of {total} spans")
    return 0


def build(args: argparse.Namespace) -> int:
    connection = store.connect(args.database)
    store.build_model(connection)
    report.build(connection)
    meta = report.write(connection, Path(args.out), args.min_sessions, Path(args.catalog) if args.catalog else None)
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
    command.add_argument("--index", default="pharo-agent-traces", help="the index prefix (default %(default)s)")
    command.add_argument("--since", help="the first week to read, YYYY-MM-DD (default: all)")
    command.set_defaults(run=fetch)

    command = commands.add_parser("build", help="compute the analyses and write the report's data")
    command.add_argument("--out", default="site/public/data")
    command.add_argument("--min-sessions", type=int, default=3,
                         help="sessions a facet, sequence or word needs to be reported (default %(default)s)")
    command.add_argument("--catalog", help="a study's catalog.json, for the tools nobody called")
    command.set_defaults(run=build)

    command = commands.add_parser("ocel", help="write the calls as OCEL 2.0")
    command.add_argument("--out", required=True)
    command.set_defaults(run=export_ocel)

    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
