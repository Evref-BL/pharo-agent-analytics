# pharo-agent-analytics

What agents do with the Pharo agent tools, read from the OpenTelemetry spans
the tools send: MCP in each image, PLexus in front of them. It makes an
object-centric event log (OCEL 2.0), the analyses that say where agents
struggle and how they get out of it, Markov models of the sessions, and a
visual report.

It reads any export of those spans, filtered or not: a collector's files, a
trace store, or an Elasticsearch index. It uses what the spans hold, from the
bare names a study keeps to real times, captured content and the agent host's
own spans, and each view says what the spans lack or are too few for.

```sh
uv sync
uv run pharo-agent-analytics load spans/*.jsonl    # OTLP JSON, or Elasticsearch documents
uv run pharo-agent-analytics fetch                 # or straight from Elasticsearch
uv run pharo-agent-analytics build                 # the analyses, as the report's data
uv run pharo-agent-analytics ocel --out out/       # the calls as OCEL 2.0, SQLite and JSON

cd site && npm ci && npm run dev                   # the report, from site/public/data
npm run build                                      # static files in site/dist
```

The spans, the store and everything made from them stay where they are read;
none of it is committed.

## Documentation

- [Getting the spans](docs/getting-the-spans.md): exporting them, what `load` and `fetch` read, filtered and unfiltered spans.
- [The analyses](docs/analyses.md): what each one answers, what keeps it honest, and when the calls are too few.
- [The event log](docs/event-log.md): the calls as an object-centric event log.
- [Sources](docs/sources.md): the research it builds on.

## Development

| Part | Language | |
| --- | --- | --- |
| `src/pharo_agent_analytics/sql/` | SQL (DuckDB) | spans to calls and sessions, the analyses, the event log |
| `src/pharo_agent_analytics/` | Python (numpy) | reading files and Elasticsearch, OCEL files, the Markov models, the report's data |
| `site/` | TypeScript | the report: Observable Plot, Graphviz (WASM) for process maps, d3-sankey |

```sh
uv run pytest                                      # every source shape, filtered and full spans, OCEL
uv run --group check python scripts/check_ocel.py out/calls.ocel.sqlite   # pm4py reads the log
cd site && npm run build                           # the report typechecks and builds
```

## Licence

[Apache-2.0](LICENSE).
