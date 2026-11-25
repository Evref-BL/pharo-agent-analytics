# The calls as an object-centric event log

`pharo-agent-analytics ocel --out DIR` writes the calls as OCEL 2.0, in its
SQLite and JSON forms, which pm4py, Ocelot, OCPQ, Rust4PM and Celonis read.
The tables are built in SQL (`sql/ocel.sql`), the same model the report's
process maps draw.

## Why object-centric

A classic event log gives each event one case. A call belongs to several
things at once: its session, the tool it calls, the tools a search named, the
places in its input it broke, the release that served it. Flattening onto one
of them copies or loses events: a search naming three tools becomes three
events when the case is the tool, and a successful call disappears when the
case is an error. OCEL keeps every relation, qualified.

## Time

OCEL gives each event one time: the call's start. When a filter kept only
the week of each span and its offset in its session, the time is the week's
Monday plus that offset: true within a session, meaningless across sessions,
where every session starts on the Monday. So:

- every object whose life is mined lives inside one session, whatever the
  times: a tool's life across sessions interleaves work nobody did together;
- with real times, waiting and sojourn times between a session's calls are
  real; with weeks only, compute none across sessions, and take durations
  from the spans themselves.

## Objects

| Type | Id | Lives in | Related to events as |
| --- | --- | --- | --- |
| `session` | its `session.id` | one session | `in` |
| `tool use` | session / tool: a tool as used in one session | one session | `calls`, and `names` from a search that named it |
| `input path` | session / tool + JSON pointer | one session | `breaks` |
| `tool` | the tool's name | everywhere | through its tool uses (`of`) |
| `agent host` | name and major.minor | everywhere | through sessions (`runs on`) |
| `release` | MCP or PLexus and its version, or Pharo's major.minor | everywhere | through sessions (`served by`, `runs in`) |
| `trace` | the caller's trace, when the agent host passed its context | one session | `within`; `of` its session |
| `agent` | the agent the host's spans name (`gen_ai.agent.name`) | everywhere | `asked by` |
| `model` | the model of the host's model calls in the call's trace | everywhere | `chosen by` |

`tool use` is what event knowledge graphs call a derived entity: the pair
(session, tool) reified, so that the directly-follows relation between a
tool's calls in one session (failed, then failed, then ok) is a lifecycle of
its own. A tool's global lifecycle would interleave sessions in an order the
spans do not keep, which is why `tool` gets none.

Event attributes: status, error kind and type, the JSON-RPC error code, PLexus's refusal, entry
(through PLexus, to the image, dispatched), duration, answer size and whether
it was cut, result count and whether there were more, test outcome and count,
the call's place in its session, the host's time for it and the agent's
time after its answer, when the spans give them.

Not exported: anything below the report's thresholds is still in the log,
which is call-level. Keep it where the spans are kept.
