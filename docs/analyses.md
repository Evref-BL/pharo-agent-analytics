# The analyses

Each analysis is a table in `sql/analyses.sql`, computed once per facet: all
calls, and the calls of each agent host, MCP release, PLexus release and
environment. Comparing hosts or releases is choosing a facet.

The spans hold no argument value, answer, prompt or model. They say where
agents struggle with the tools and how they get out of it, never why: the
evaluations say why, on runs whose transcripts are kept. A number here points
at what to look at; it decides nothing, and each comes with the number that
would show it being gamed.

## Units and rates

- **A call** is what one tool call left: PLexus's server span, the client
  span it forwarded with, the image's span, joined within their trace,
  session and week. A call an image's `tool_call` dispatched is a call of its
  own, marked dispatched, and left out of the agent's sequence.
- **A failed call** is a span with status error, or one naming an error
  type, an MCP error kind or a PLexus refusal. OpenTelemetry's MCP
  conventions do not mark a refused argument (-32602) as an error on the
  server's span; it is a failed call here.
- **A session** ends after 30 minutes without a call. Subagents share their
  agent's session, so their calls interleave in it.
- **Order** within a session comes from when the participant's machine saw
  each call start; spans keep only their week, so nothing is ordered across
  sessions.
- Calls of one session are not independent: a rate is given per session as
  well as per call, with a Wilson interval on sessions.

## What each one answers

| Analysis | Question | Shown as | Kept honest by |
| --- | --- | --- | --- |
| `a_weekly` | How much, and how often a session meets a failure | bars; dots with intervals | sessions, not only calls |
| `a_tools` | Which tools fail more than their use explains | funnel plot of session failure against sessions | the funnel's chance limits; raw counts in the table |
| `a_tools` (kinds) | How each tool fails | stacked bars by error kind | the table view |
| `a_dfg` | Which call follows which | process map (Graphviz) | edges below a count hidden, never merged |
| `a_tool_use_dfg` | A tool's life in a session: named by a search, called, failed, worked | process map of one tool | sessions per arc |
| `a_variants` | What whole sessions look like | sequences with their coverage | rare ones counted together |
| `a_next_entropy` | How predictable the next call is after a tool | bars, in bits | calls per tool, since entropy falls with fewer tools |
| `a_collocations` | Pairs that follow each other more than chance (lift): fused tool or richer answer | table | at least three occurrences |
| `a_recovery` | After a failure: the same call again, other arguments, another tool, a search, evaluate, or the end | alluvial, error kind → next move → outcome | the share of sessions with any failure |
| `a_recovery_times` | Calls until the failed tool works | cumulative incidence, with the session's end competing | failures still open at each step |
| `a_failure_runs` | The same tool failing call after call | stacked bars by run length and ending | identical repeats that succeed are not counted |
| `a_schema` | Where arguments break a tool's schema: tool, place, rule | heatmap | the tool's calls that pass the schema |
| `a_unknown_arguments` | Names agents reach for that a tool lacks | table | sessions, so one agent cannot make a variant |
| `a_options` | Options in use, and by their absence those nobody uses | table | failure per option |
| `a_discovery` | Does a search lead to calling a tool it named | funnel | searches that found nothing |
| `a_more_results` | When an answer had more, what the agent did | table | |
| `a_evaluate` | What precedes evaluate, after a success or a failure | stacked bars | evaluate as a first choice |
| `a_tests` | How a test run ends after the previous one | heatmap | how many tests run |
| `a_compile_to_green` | From a compile to passing tests | cumulative incidence | sessions that never test |
| `a_latency`, `a_output` | Time and size per tool, answers cut to fit | heatmap; ranges | |
| `a_releases` | A tool's failure release against release, as it came and with every release given the same mix of agent hosts | forest plot | the share of the mix each release saw |
| `a_images` | What PLexus did to images: create, start, stop, delete | table | |

## Thresholds

`--min-sessions` (3) applies to every facet and to every row that tells a
sequence or a word (variants, pairs, schema places, argument names, options,
a tool's life, runs). Variants below it are counted together. Rows that only
count calls of a published tool are kept, since the study publishes those
names.
