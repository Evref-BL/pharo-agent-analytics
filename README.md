# pharo-agent-analytics

What agents do with the Pharo agent tools, from the spans the tools send:
an object-centric event log (OCEL 2.0), the analyses that say where agents
struggle, and a visual report.

It reads any spans of MCP and PLexus: a study's Elasticsearch index, a
collector's OTLP archive, or the documents either holds. It names no study.

```sh
uv sync
uv run pharo-agent-analytics fetch                 # from Elasticsearch: ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY (read)
uv run pharo-agent-analytics load archive/*.jsonl  # or from files: a collector's archive, or documents
uv run pharo-agent-analytics build --catalog ../pharo-agent-study/catalog.json
uv run pharo-agent-analytics ocel --out out/        # the calls as OCEL 2.0, SQLite and JSON

cd site && npm ci && npm run dev                    # the report, from site/public/data
npm run build                                       # static files in site/dist
```

The spans stay in `data/spans.duckdb`, and nothing made from them is
committed. The report holds aggregates only: a host or release with fewer
sessions than `--min-sessions` (3) has no view of its own, and a sequence,
pair, schema place, argument name or option shared by fewer sessions is not
shown.

## How it is built

| Part | Language | |
| --- | --- | --- |
| `src/pharo_agent_analytics/sql/` | SQL (DuckDB) | spans to calls, sessions, the analyses, the event log |
| `src/pharo_agent_analytics/` | Python | reading Elasticsearch and archives, OCEL files, the report's data |
| `site/` | TypeScript | the report: Observable Plot, Graphviz (WASM) for process maps, d3-sankey |

- [docs/analyses.md](docs/analyses.md): what each analysis answers, and what keeps it honest.
- [docs/event-log.md](docs/event-log.md): the calls as an object-centric event log.
- [docs/sources.md](docs/sources.md): the research it builds on.

## Tests

```sh
uv run pytest                                       # spans to calls, recovery, thresholds, OCEL
uv run --group check python scripts/check_ocel.py out/calls.ocel.sqlite   # pm4py reads the log
cd site && npm run build                            # the report typechecks and builds
```
