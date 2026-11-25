# pharo-agent-analytics

What agents do with the Pharo agent tools, read from the OpenTelemetry spans
the tools send: MCP in each image, PLexus in front of them. It makes an
object-centric event log (OCEL 2.0), the analyses that say where agents
struggle and how they get out of it, Markov models of the sessions (how far
back the next call looks, hidden phases, what follows a failure), and a
visual report.

It reads whatever exported the spans, filtered or not: your own collector's
files, a trace store, or an Elasticsearch index. It uses what the spans hold,
from the bare names a study keeps to the full conventions, error messages,
real times and captured content, and the agent host's own spans in the same
traces: its turns, its time for each call, the model and the tokens.

```sh
uv sync
uv run pharo-agent-analytics load spans/*.jsonl    # OTLP JSON, or Elasticsearch documents
uv run pharo-agent-analytics fetch                 # or straight from Elasticsearch
uv run pharo-agent-analytics build                 # the analyses, as the report's data
uv run pharo-agent-analytics ocel --out out/       # the calls as OCEL 2.0, SQLite and JSON

cd site && npm ci && npm run dev                   # the report, from site/public/data
npm run build                                      # static files in site/dist
```

## Getting the spans

MCP and PLexus send OTLP to the endpoint their `OTEL_*` settings name (MCP's
[observability](https://github.com/Evref-BL/MCP/blob/main/docs/user/observability.md),
PLexus's [telemetry](https://github.com/Evref-BL/PLexus/blob/main/docs/telemetry.md)).
To keep them on your machine, run an OpenTelemetry Collector with its file
exporter, and `load` its files:

```yaml
receivers: { otlp: { protocols: { http: { endpoint: 127.0.0.1:4318 } } } }
exporters: { file: { path: ./spans/traces.jsonl } }
service: { pipelines: { traces: { receivers: [otlp], exporters: [file] } } }
```

`load` takes:

- OTLP JSON: a collector's file exporter (one request per line), an OTLP/HTTP
  JSON request, or a trace store's answer that wraps one;
- Elasticsearch documents, one per line, as hits or sources: those
  [pharo-agent-telemetry-import](https://github.com/Evref-BL/pharo-agent-telemetry)
  indexes, and those the Collector's Elasticsearch exporter writes in its
  default `otel` mapping.

`fetch` reads the same documents from Elasticsearch, only the Pharo tools'
spans, by point in time: `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY` (the
`encoded` field of the answer that made a key that may read) and
`ELASTICSEARCH_INDEX` (default `pharo-agent-traces-*,traces-*.otel-*`), from
the environment or else from `~/.config/pharo-agent-analytics/elasticsearch.env`
(`$XDG_CONFIG_HOME` when set), lines of `NAME=value`; `ELASTICSEARCH_CA_FILE`
names a CA bundle when the server's certificate needs one. A key that may
only read:

```
POST /_security/api_key
{"name": "pharo-agent-analytics", "role_descriptors": {"read-traces": {"indices": [
  {"names": ["pharo-agent-traces-*", "traces-*.otel-*"], "privileges": ["read", "view_index_metadata"]}]}}}
```

The spans stay in `data/spans.duckdb`, and nothing made from them is
committed.

## Unfiltered spans

Export everything the tools and the agent host send to the same place:

- the agent host's spans by the GenAI conventions (`invoke_agent`, `chat`,
  `execute_tool`), with the trace context it passes in each call's `_meta`,
  give turns, the host's time for each call, the model, the agent and the
  tokens;
- content capture (`gen_ai.tool.call.arguments`) tells a repeat by its
  arguments, and gives the classes and messages of the code sent to
  `evaluate`, never the code;
- `build --facet ATTRIBUTE` adds a facet for any resource attribute, such as
  a team set in `OTEL_RESOURCE_ATTRIBUTES`.

Each view that needs one of these says so when the spans lack it, and each
view whose calls are too few for what it shows carries a warning; the
report's Views menu hides the views a reader does not want.

## Filtered spans

A filter may keep less than the tools send, as a study does when its
participants' spans leave their machines: the week a span started instead of
its time, hashed ids, counts in buckets, no error message. The analyses use
what is there and say what is not. With only weeks, calls are ordered within
their session by the offset the filter recorded, and every sequence stays
inside one session; with real times, the time between calls is real too.

`build --min-sessions k` hides what fewer than k sessions share: a host or
release of its own, a sequence, a pair, a schema place, an argument name, an
option, an error message. The default, 1, shows everything, for whoever reads
their own spans; set it when others read the report. `--catalog` names the
tools that exist, a pharo-agent-telemetry catalog or a JSON list of names, so
the report lists those nobody called.

## How it is built

| Part | Language | |
| --- | --- | --- |
| `src/pharo_agent_analytics/sql/` | SQL (DuckDB) | spans to calls and sessions, the analyses, the event log |
| `src/pharo_agent_analytics/` | Python (numpy) | reading files and Elasticsearch, OCEL files, the Markov models, the report's data |
| `site/` | TypeScript | the report: Observable Plot, Graphviz (WASM) for process maps, d3-sankey |

- [docs/analyses.md](docs/analyses.md): what each analysis answers, and what keeps it honest.
- [docs/event-log.md](docs/event-log.md): the calls as an object-centric event log.
- [docs/sources.md](docs/sources.md): the research it builds on.

## Tests

```sh
uv run pytest                                      # every source shape, filtered and full spans, OCEL
uv run --group check python scripts/check_ocel.py out/calls.ocel.sqlite   # pm4py reads the log
cd site && npm run build                           # the report typechecks and builds
```

## Licence

Apache-2.0.
