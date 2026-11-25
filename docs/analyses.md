# The analyses

Each analysis is a table in `sql/analyses.sql`, computed once per facet: all
calls, and the calls of each agent host, MCP release, PLexus release, Pharo
version and environment. Comparing hosts or releases is choosing a facet.

The spans hold no prompt or model, and argument values and answers only when
content capture is on. They say where agents struggle with the tools and how
they get out of it, rarely why: runs whose transcripts are kept say why. A
number here points at what to look at; it decides nothing, and each comes
with the number that would show it being gamed.

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
- **Order** comes from each call's start time. When a filter kept only the
  week, it comes from the offset in its session the filter recorded, then
  from PLexus's count of the session's calls, and nothing is ordered across
  sessions.
- **Versions** of agent hosts and of Pharo are compared at major.minor.
- Calls of one session are not independent: a rate is given per session as
  well as per call, with a Wilson interval on sessions.

## What each one answers

| Analysis | Question | Shown as | Kept honest by |
| --- | --- | --- | --- |
| `a_weekly` | How much, and how often a session meets a failure, per day (real times over a few months at most) or week | bars; dots with intervals | sessions, not only calls |
| `a_tools` | Which tools fail more than their use explains | funnel plot of session failure against sessions | the funnel's chance limits; raw counts in the table |
| `a_tools` (kinds) | How each tool fails | stacked bars by error kind | the table view |
| `a_errors` | Failures in their own words: code, exception class, the JSON-RPC message with numbers and quotes blanked | table | sessions per message |
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
| `markov-order` | How far back the next call looks: chains of 0 to 3 calls | held-out bits per order, with each criterion's pick | AIC and BIC charge for every probability; held-out sessions were not fitted |
| `markov-memory` | Pairs of calls after which the next call differs from what the last alone predicts | table | sessions per pair, as for sequences |
| `markov-recovery` | After a failure, what the first-order chain over (tool, outcome) expects: the chance the tool works before the session ends, and the calls it takes | dots beside the observed share | the observed share and its interval: far apart, the last call is not all that matters |
| `phases` | Phases a session goes through, unnamed in the spans: a hidden Markov model of 1 to 6 phases | where each phase comes in a session; what phase comes next; each phase's tools | BIC and held-out sessions say how many phases the calls support |
| `a_releases` | A tool's failure release against release, as it came and with every release given the same mix of agent hosts | forest plot | the share of the mix each release saw |
| `a_images` | What PLexus did to images: create, start, stop, delete | table | |

## Markov models

The directly-follows graph (`a_dfg`) is a first-order Markov chain's counts;
its `share` is the transition probability P(next | tool), which the process
map draws on request. The models in `markov.py` take the same sequences, one
per session and facet:

- **Order**: for k = 0 to 3, a chain of the last k calls, with one
  probability per next call (each tool, or the end) for every context of k
  calls seen. Each order is judged by the likelihood ratio against the order
  below (chi-square), AIC, BIC, and the bits it needs per call of sessions
  held out of the fit (five folds of whole sessions, add-one smoothing).
- **Memory**: for each pair (before, last), the information knowing `before`
  adds about the next call, n · KL(P(next | before, last) ‖ P(next | last)).
- **Absorbing chain**: the first-order chain over (tool, worked or failed),
  with the tool working and the session ending absorbing. With N = (I − Q)⁻¹,
  N·R gives the chances of each, N·1 the calls until one happens, and
  (N·b)/b the calls until the tool works, given that it does.
- **Phases**: a hidden Markov model over the tools called, fitted by
  Baum–Welch from three random starts, for 1 to 6 phases (`--max-phases`),
  compared by BIC and, up to 50,000 calls, by held-out sessions (three folds).
  Phases are numbered by their mean place in the session; each is described
  by its posterior weight on the calls.

Every model runs on whatever calls there are. When the penalised criteria
choose less memory or fewer phases than the others, the calls are too few to
estimate more, and the report says so beside the model rather than leaving it
out.

## Thresholds

`--min-sessions` (1 by default: everything) applies to every facet and to
every row that tells a sequence or a word (variants, pairs, pairs that change
what follows, schema places,
argument names, options, a tool's life, runs, error messages). Variants below
it are counted together. Rows that count calls of a tool are kept whatever
the threshold. Set it for a report read beyond the people whose spans it
holds.
