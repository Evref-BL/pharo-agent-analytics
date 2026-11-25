// The agent's side of the calls: where a session's time goes between the
// tools and the agent, when the tools are used, the turns of the agent host
// that hold the calls, what the host adds to them and what its model spent,
// and what the agent asks evaluate to do.
//
// Each view needs something not every export keeps; without it, the view
// says what is missing instead of drawing nothing.

import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { all, meta, of, type Facet, type Row } from "./data";
import {
  card, chart, count, duration, el, empty, legend, percent, section, segmented, sequential, table, tableView, tile, token,
} from "./ui";

const WIDTH = 520;
const TOGETHER_MS = 100;

/** Why a view is empty: these spans lack what it needs. */
function lacking(text: string): HTMLElement {
  return el("p", { class: "empty" }, text);
}

const NO_SESSION_TIME = "These spans keep no time within a session, so the agent's time cannot be told from the tools'.";
const NO_REAL_TIME = "A filter kept only the week of each span: the hour of the day is gone.";
const NO_CALLER = "No call carried the agent host's trace context (W3C traceparent), so the calls cannot be grouped into the host's turns.";
const NO_HOST = "This export holds none of the agent host's own spans (GenAI semantic conventions), so its time for a call is unknown.";
const NO_TOKENS = "This export holds no model call of the agent host with its token usage (gen_ai.usage.*).";
const NO_CODE = "Content capture was off: the code agents asked evaluate to run is not in these spans.";

export function agentSection(facet: Facet): HTMLElement {
  const { root, body } = section("agent", "The agent's side",
    "Where a session's time goes between the tools and the agent, the host's turns that hold the calls, and what the host's model spent on them.");
  body.append(timeSplit(facet), agentTime(facet), answerTime(facet), hours(facet), traces(facet), host(facet), tokens(facet));
  return root;
}

// ------------------------------------------------------------- time split

function timeSplit(facet: Facet): HTMLElement {
  const view = card("The tool's time and the agent's",
    `For each tool, the median time its calls took (tool) and the median time the agent took after the answer before its next call (agent), on a log scale. ` +
    `Calls whose next one started within ${TOGETHER_MS} ms were asked together, in one answer of the model, and calls whose next one started before they ended overlapped: both are counted apart, not in the agent's time.`, true);
  if (!meta().sessionTime) {
    view.chart.append(lacking(NO_SESSION_TIME));
    return view.root;
  }
  const rows = of("time-split", facet).sort((a, b) => b.calls - a.calls).slice(0, 20);
  if (!rows.length) {
    view.chart.append(empty());
    return view.root;
  }
  const order = rows.map((r) => r.tool as string);
  const points = rows.flatMap((r) => [
    { tool: r.tool, who: "tool", ms: r.tool_p50_ms, p90: r.tool_p90_ms, row: r },
    { tool: r.tool, who: "agent", ms: r.agent_p50_ms, p90: r.agent_p90_ms, row: r },
  ]).filter((p) => p.ms != null && p.ms > 0);
  const colors = { tool: token("--series-1"), agent: token("--series-2") };
  const tip = (d: Row) =>
    `${d.tool}: ${d.who === "tool" ? "the tool" : "the agent"} took ${duration(d.ms)} at the median, ${duration(d.p90)} at the 90th percentile\n` +
    `${count(d.row.calls)} calls · ${count(d.row.sent_together)} asked with the next · ${count(d.row.overlapped)} overlapped it`;
  view.chart.append(
    chart({
      width: WIDTH + 120, height: 50 + 22 * order.length, marginLeft: 140,
      x: { type: "log", label: "median time →", grid: true, tickFormat: (ms: number) => duration(ms) },
      y: { domain: order, label: null },
      marks: [
        Plot.ruleY(rows.filter((r) => r.agent_p50_ms > 0 && r.tool_p50_ms > 0), { y: "tool", x1: "tool_p50_ms", x2: "agent_p50_ms", stroke: token("--axis"), strokeWidth: 2 }),
        Plot.dot(points, { y: "tool", x: "ms", r: 5, fill: (d: Row) => colors[d.who as "tool" | "agent"], stroke: token("--surface"), strokeWidth: 2, tip: true, title: tip }),
      ],
    }),
    legend([["the tool", colors.tool], ["the agent, after the answer", colors.agent]]),
    tableView(rows, [
      { key: "tool", label: "Tool" },
      { key: "calls", label: "Calls", numeric: true, format: count },
      { key: "tool_p50_ms", label: "Tool p50", numeric: true, format: duration },
      { key: "tool_p90_ms", label: "Tool p90", numeric: true, format: duration },
      { key: "agent_p50_ms", label: "Agent p50", numeric: true, format: duration },
      { key: "agent_p90_ms", label: "Agent p90", numeric: true, format: duration },
      { key: "sent_together", label: "Asked with the next", numeric: true, format: count },
      { key: "overlapped", label: "Overlapped", numeric: true, format: count },
    ]),
  );
  return view.root;
}

// ------------------------------------------------------ agent time spread

function agentTime(facet: Facet): HTMLElement {
  const view = card("How long the agent takes between calls",
    `From the end of a call to the start of the next, in powers of two of milliseconds. Below about ${TOGETHER_MS} ms, the two calls came from one answer of the model; before zero, the next call started while this one ran (parallel calls, or subagents sharing the session).`);
  if (!meta().sessionTime) {
    view.chart.append(lacking(NO_SESSION_TIME));
    return view.root;
  }
  const rows = of("agent-time", facet).sort((a, b) => a.ms - b.ms);
  if (!rows.length) {
    view.chart.append(empty());
    return view.root;
  }
  const label = (ms: number) => (ms < 0 ? "overlap" : duration(ms));
  const kind = (ms: number) => (ms < 0 ? "overlapping" : ms < TOGETHER_MS ? "asked together" : "the agent's time");
  const colors: Record<string, string> = {
    overlapping: token("--series-4"), "asked together": token("--series-3"), "the agent's time": token("--series-2"),
  };
  const total = d3.sum(rows, (r) => r.calls);
  view.chart.append(
    chart({
      width: WIDTH, height: 220,
      x: { domain: rows.map((r) => r.ms), tickFormat: label, label: "at least →", tickRotate: -40 },
      y: { label: "↑ calls", grid: true },
      marginBottom: 50,
      marks: [
        Plot.barY(rows, { x: "ms", y: "calls", fill: (d: Row) => colors[kind(d.ms)], inset: 1, rx1: 4,
          tip: true, title: (d: Row) => `${d.ms < 0 ? "the next call started before the answer" : `${label(d.ms)} or more`}: ${count(d.calls)} calls (${percent(d.calls / total)}) in ${count(d.sessions)} sessions` }),
        Plot.ruleY([0], { stroke: token("--axis") }),
      ],
    }),
    legend(Object.entries(colors).filter(([k]) => rows.some((r) => kind(r.ms) === k))),
    tableView(rows, [
      { key: "ms", label: "At least", numeric: true, format: (v) => label(v) },
      { key: "calls", label: "Calls", numeric: true, format: count },
      { key: "sessions", label: "Sessions", numeric: true, format: count },
    ]),
  );
  return view.root;
}

// ------------------------------------------------ answer size, then time

function answerTime(facet: Facet): HTMLElement {
  const view = card("Bigger answers, longer reads?",
    `The agent's time after an answer, by the answer's size in powers of two of bytes: the median (dot) and the 90th percentile (end of the line). Answers asked together with the next call are left out: nobody read them first.`);
  if (!meta().sessionTime) {
    view.chart.append(lacking(NO_SESSION_TIME));
    return view.root;
  }
  const rows = of("answer-time", facet).filter((r) => r.calls >= 3).sort((a, b) => a.bytes - b.bytes);
  if (!rows.length) {
    view.chart.append(empty());
    return view.root;
  }
  const bytes = (b: number) => (b >= 1024 * 1024 ? `${+(b / 1024 / 1024).toFixed(1)} MiB` : b >= 1024 ? `${+(b / 1024).toFixed(1)} KiB` : `${b} B`);
  const color = token("--series-1");
  view.chart.append(
    chart({
      width: WIDTH, height: 240,
      x: { type: "log", label: "answer size, at least →", tickFormat: bytes, ticks: rows.map((r) => r.bytes) },
      y: { type: "log", label: "↑ the agent's time", grid: true, tickFormat: (ms: number) => duration(ms) },
      marks: [
        Plot.ruleX(rows, { x: "bytes", y1: "agent_p50_ms", y2: "agent_p90_ms", stroke: color, strokeOpacity: 0.5, strokeWidth: 2 }),
        Plot.line(rows, { x: "bytes", y: "agent_p50_ms", stroke: color, strokeWidth: 2 }),
        Plot.dot(rows, { x: "bytes", y: "agent_p50_ms", r: 4, fill: color, stroke: token("--surface"), strokeWidth: 2,
          tip: true, title: (d: Row) => `answers of ${bytes(d.bytes)} or more: ${count(d.calls)} calls\nthe agent took ${duration(d.agent_p50_ms)} at the median, ${duration(d.agent_p90_ms)} at the 90th percentile` }),
      ],
    }),
    tableView(rows, [
      { key: "bytes", label: "At least", numeric: true, format: (v) => bytes(v) },
      { key: "calls", label: "Calls", numeric: true, format: count },
      { key: "agent_p50_ms", label: "Agent p50", numeric: true, format: duration },
      { key: "agent_p90_ms", label: "Agent p90", numeric: true, format: duration },
    ]),
  );
  return view.root;
}

// ------------------------------------------------------------------ hours

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function hours(facet: Facet): HTMLElement {
  const view = card("When the tools are used", "Calls by weekday and hour, in UTC as the spans keep time; the darker, the more calls.", true);
  if (!meta().timePrecise) {
    view.chart.append(lacking(NO_REAL_TIME));
    return view.root;
  }
  const rows = of("hours", facet);
  if (!rows.length) {
    view.chart.append(empty());
    return view.root;
  }
  view.chart.append(
    chart({
      width: WIDTH + 200, height: 230, marginLeft: 48,
      x: { domain: d3.range(24), label: "hour (UTC) →", tickFormat: (h: number) => (h % 3 === 0 ? String(h).padStart(2, "0") : "") },
      y: { domain: d3.range(1, 8), tickFormat: (d: number) => WEEKDAYS[d - 1], label: null },
      color: { type: "quantize", n: 5, range: sequential().slice(0, 5) },
      marks: [Plot.cell(rows, { x: "hour", y: "weekday", fill: "calls", inset: 1, rx: 3,
        tip: true, title: (d: Row) => `${WEEKDAYS[d.weekday - 1]} ${String(d.hour).padStart(2, "0")}:00 UTC: ${count(d.calls)} calls in ${count(d.sessions)} sessions` })],
    }),
    tableView([...rows].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour), [
      { key: "weekday", label: "Weekday", format: (v) => WEEKDAYS[v - 1] },
      { key: "hour", label: "Hour (UTC)", numeric: true },
      { key: "calls", label: "Calls", numeric: true, format: count },
      { key: "sessions", label: "Sessions", numeric: true, format: count },
    ]),
  );
  return view.root;
}

// ----------------------------------------------------------------- traces

function traces(facet: Facet): HTMLElement {
  const view = card("The host's turns",
    "When the agent host passes its trace context with a call, the calls one of its traces holds: a turn or a task, as the host draws its traces. How many calls a turn takes, and whether the turns that met a failure ended on a call that worked.");
  if (!meta().callerContext) {
    view.chart.append(lacking(NO_CALLER));
    return view.root;
  }
  const rows = of("traces", facet).sort((a, b) => a.calls - b.calls);
  if (!rows.length) {
    view.chart.append(empty());
    return view.root;
  }
  const turns = d3.sum(rows, (r) => r.traces);
  const failing = d3.sum(rows, (r) => r.with_failure);
  const working = d3.sum(rows, (r) => r.ended_working);
  view.chart.append(
    el("div", { class: "tiles" },
      tile(count(turns), "turns", `${count(d3.sum(rows, (r) => r.calls * r.traces))} calls${rows.some((r) => r.calls >= 20) ? " (20 or more counted as 20)" : ""}`),
      tile(percent(failing / turns), "met a failure", `${count(failing)} turns`),
      tile(failing ? percent(working / failing) : "–", "of those ended working", "their last call did not fail")),
    chart({
      width: WIDTH, height: 200,
      x: { domain: rows.map((r) => r.calls), label: "calls in the turn →", tickFormat: (n: number) => (n >= 20 ? "20+" : String(n)) },
      y: { label: "↑ turns", grid: true },
      marks: [
        Plot.barY(rows, { x: "calls", y: "traces", fill: token("--series-1"), inset: 1, rx1: 4,
          tip: true, title: (d: Row) => `${d.calls >= 20 ? "20 or more" : d.calls} calls: ${count(d.traces)} turns in ${count(d.sessions)} sessions, ${count(d.with_failure)} met a failure, ${count(d.ended_working)} of them ended working` }),
        Plot.ruleY([0], { stroke: token("--axis") }),
      ],
    }),
    tableView(rows, [
      { key: "calls", label: "Calls", numeric: true, format: (v) => (v >= 20 ? "20+" : String(v)) },
      { key: "traces", label: "Turns", numeric: true, format: count },
      { key: "sessions", label: "Sessions", numeric: true, format: count },
      { key: "with_failure", label: "Met a failure", numeric: true, format: count },
      { key: "ended_working", label: "Ended working", numeric: true, format: count },
    ]),
  );
  return view.root;
}

// ------------------------------------------------------------------- host

function host(facet: Facet): HTMLElement {
  const view = card("What the host adds",
    "The agent host's own time for a call, from its execute_tool span, less the tool's: the transport and whatever the host does around the call. The median (dot) and the 90th percentile (end of the line), per tool.");
  if (!meta().hostSpans) {
    view.chart.append(lacking(NO_HOST));
    return view.root;
  }
  const rows = of("host", facet).sort((a, b) => b.calls - a.calls).slice(0, 15);
  if (!rows.length) {
    view.chart.append(lacking("The host's spans in this export do not hold these calls."));
    return view.root;
  }
  const color = token("--series-1");
  view.chart.append(
    chart({
      width: WIDTH, height: 40 + 22 * rows.length, marginLeft: 140,
      x: { label: "the host's time less the tool's →", grid: true, tickFormat: (ms: number) => duration(ms) },
      y: { domain: rows.map((r) => r.tool), label: null },
      marks: [
        Plot.ruleX([0], { stroke: token("--axis") }),
        Plot.ruleY(rows, { y: "tool", x1: "overhead_p50_ms", x2: "overhead_p90_ms", stroke: color, strokeOpacity: 0.5, strokeWidth: 2 }),
        Plot.dot(rows, { y: "tool", x: "overhead_p50_ms", r: 4, fill: color, stroke: token("--surface"), strokeWidth: 2,
          tip: true, title: (d: Row) => `${d.tool}: the host took ${duration(d.host_p50_ms)}, the tool ${duration(d.tool_p50_ms)} (medians of ${count(d.calls)} calls)\nadded ${duration(d.overhead_p50_ms)} at the median, ${duration(d.overhead_p90_ms)} at the 90th percentile` }),
      ],
    }),
    tableView(rows, [
      { key: "tool", label: "Tool" },
      { key: "calls", label: "Calls", numeric: true, format: count },
      { key: "host_p50_ms", label: "Host p50", numeric: true, format: duration },
      { key: "tool_p50_ms", label: "Tool p50", numeric: true, format: duration },
      { key: "overhead_p50_ms", label: "Added p50", numeric: true, format: duration },
      { key: "overhead_p90_ms", label: "Added p90", numeric: true, format: duration },
    ]),
  );
  return view.root;
}

// ----------------------------------------------------------------- tokens

function tokens(facet: Facet): HTMLElement {
  const view = card("What the model spent",
    "Tokens of the agent host's model calls in the traces that hold these tool calls, per session, beside the tool calls made; and the same by model.");
  if (!meta().tokens) {
    view.chart.append(lacking(NO_TOKENS));
    return view.root;
  }
  const [row] = of("tokens", facet);
  if (!row) {
    view.chart.append(lacking("No model call of the host is in the traces of these calls."));
    return view.root;
  }
  const models = all("tokens").filter((r) => r.facet === "model");
  view.chart.append(
    el("div", { class: "tiles" },
      tile(count(row.input_p50), "input tokens", "in a median session"),
      tile(count(row.output_p50), "output tokens", "in a median session"),
      tile(row.tool_calls ? count(row.input_tokens / row.tool_calls) : "–", "input tokens per tool call", `${count(row.model_calls)} model calls, ${count(row.tool_calls)} tool calls`)),
    ...(models.length ? [table(models, [
      { key: "facet_value", label: "Model" },
      { key: "sessions", label: "Sessions", numeric: true, format: count },
      { key: "tool_calls", label: "Tool calls", numeric: true, format: count },
      { key: "model_calls", label: "Model calls", numeric: true, format: count },
      { key: "input_p50", label: "Input p50", numeric: true, format: count },
      { key: "output_p50", label: "Output p50", numeric: true, format: count },
      { key: "input_tokens", label: "Input in all", numeric: true, format: count },
      { key: "output_tokens", label: "Output in all", numeric: true, format: count },
    ])] : []),
  );
  return view.root;
}

// --------------------------------------------------------- evaluate words

/** The classes and messages of the code agents asked evaluate to run: what a tool could do for them instead. */
export function evaluateWords(facet: Facet): HTMLElement {
  const view = card("What evaluate is asked to do",
    "The classes the code names and the messages it sends, by the evaluate calls that used them, and how many of those came right after a failed call. Words only: the code itself is never shown.");
  if (!meta().evaluateCode) {
    view.chart.append(lacking(NO_CODE));
    return view.root;
  }
  const rows = of("evaluate-words", facet);
  if (!rows.length) {
    view.chart.append(empty());
    return view.root;
  }
  const canvas = el("div");
  const draw = (kind: string) => {
    const top = rows.filter((r) => r.kind === kind).sort((a, b) => b.calls - a.calls).slice(0, 20);
    const bars = top.flatMap((r) => [
      { name: r.name, part: "after a failure", n: r.after_failure, row: r },
      { name: r.name, part: "otherwise", n: r.calls - r.after_failure, row: r },
    ]);
    canvas.replaceChildren(
      top.length
        ? chart({
            width: WIDTH, height: 40 + 20 * top.length, marginLeft: 160,
            x: { label: "evaluate calls →", grid: true },
            y: { domain: top.map((r) => r.name), label: null },
            color: { domain: ["otherwise", "after a failure"], range: [token("--series-1"), token("--series-2")] },
            marks: [
              Plot.barX(bars, Plot.stackX({ y: "name", x: "n", fill: "part", inset: 1,
                tip: true, title: (d: Row) => `${d.name}: ${count(d.row.calls)} evaluate calls in ${count(d.row.sessions)} sessions, ${count(d.row.after_failure)} after a failure` })),
              Plot.ruleX([0], { stroke: token("--axis") }),
            ],
          })
        : empty(`No ${kind} shared by enough sessions.`),
      legend([["otherwise", token("--series-1")], ["after a failure", token("--series-2")]]),
      tableView(top, [
        { key: "name", label: kind === "class" ? "Class" : "Message" },
        { key: "calls", label: "Calls", numeric: true, format: count },
        { key: "sessions", label: "Sessions", numeric: true, format: count },
        { key: "after_failure", label: "After a failure", numeric: true, format: count },
      ]),
    );
  };
  view.chart.append(el("div", { class: "controls" }, segmented([["class", "Classes"], ["message", "Messages"]], "class", draw)), canvas);
  draw("class");
  return view.root;
}

/** What these spans could not give, and what an export would need for it. */
export function lacks(): string[] {
  const m = meta();
  const out: string[] = [];
  if (!m.timePrecise) out.push("Real times: a filter kept the week of each span only, so there is no hour of the day and no time across sessions.");
  if (!m.sessionTime) out.push("Time within a session: the agent's time between calls needs each call's start and duration.");
  if (!m.callerContext) out.push("The host's turns: the calls need the agent host's trace context (W3C traceparent in the request's _meta) to be grouped by turn.");
  if (!m.hostSpans) out.push("The host's time, model and agent: the export needs the agent host's own spans by the GenAI semantic conventions, in the same traces.");
  if (!m.tokens) out.push("Tokens: the host's model-call spans with gen_ai.usage.input_tokens and output_tokens.");
  if (!m.evaluateCode) out.push("What evaluate is asked to do: content capture (gen_ai.tool.call.arguments) on evaluate calls.");
  return out;
}
