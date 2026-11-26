# Getting the spans

MCP and PLexus send OTLP to the endpoint their `OTEL_*` settings name (MCP's
[observability](https://github.com/Evref-BL/MCP/blob/main/docs/user/observability.md),
PLexus's [observability](https://github.com/Evref-BL/PLexus/blob/main/docs/observability.md)).
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
- Elasticsearch documents, one per line, as hits or sources: one span per
  document with OTLP's field names at the top level, as an import of a
  collector's files may index them, and those the Collector's Elasticsearch
  exporter writes in its default `otel` mapping.

`fetch` reads the same documents from Elasticsearch, only the Pharo tools'
spans, by point in time: `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY` (the
`encoded` field of the answer that made a key that may read) and
`ELASTICSEARCH_INDEX` (default `traces-*.otel-*`, the Collector exporter's data streams), from
the environment or else from `~/.config/pharo-agent-analytics/elasticsearch.env`
(`$XDG_CONFIG_HOME` when set), lines of `NAME=value`; `ELASTICSEARCH_CA_FILE`
names a CA bundle when the server's certificate needs one. A key that may
only read:

```
POST /_security/api_key
{"name": "pharo-agent-analytics", "role_descriptors": {"read-traces": {"indices": [
  {"names": ["traces-*.otel-*"], "privileges": ["read", "view_index_metadata"]}]}}}
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
filter at the top of the report's sidebar hides the views a reader does not
want.

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
tools that exist, so the report lists those nobody called: a JSON list of
names, or a pharo-agent-telemetry catalog, as a study keeps it or as its
collector serves it, signed, whose `<project> tools` sets each hold a
project's tools.
