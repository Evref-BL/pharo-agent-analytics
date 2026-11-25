// The report's sections. Each takes the facet (all calls, a host, a release)
// and builds its cards from the analyses' files.

import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { sankey, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from "d3-sankey";
import { all, meta, of, type Facet, type Row } from "./data";
import { evaluateWords, lacks } from "./agent";
import { chainRecovery } from "./markov";
import { processMap } from "./process";
import {
  ERROR_KINDS, ERROR_LABELS, card, chart, count, el, empty, errorColor, errorKind, legend, percent,
  section, segmented, sequential, series, sumBy, table, tableView, tile, token, wilson,
} from "./ui";

const WIDTH = 520;

/** What a threshold hides, said only when one is set. */
function hidden(what: string): string {
  const k = meta().minSessions;
  return k > 1 ? ` ${what} shared by fewer than ${k} sessions are not shown.` : "";
}


// ---------------------------------------------------------------- overview

export function overview(facet: Facet): HTMLElement {
  const m = meta();
  const unit = m.period === "day" ? "day" : "week";
  const { root, body } = section("overview", "Overview", `What agents asked of the tools, ${unit} by ${unit}. The spans run from ${m.first} to ${m.last}.`);
  const weekly = of("weekly", facet).sort((a, b) => a.week.localeCompare(b.week));
  const tools = of("tools", facet);
  const sessions = of("sessions", facet);
  const calls = d3.sum(weekly, (w) => w.calls);
  const failed = d3.sum(weekly, (w) => w.failed);
  const sessionCount = sessions.length;
  const failedSessions = sessions.filter((s) => s.any_failed).length;
  const hosts = all("facets").filter((f) => f.facet === "host");
  const tiles = el(
    "div",
    { class: "tiles card wide", style: "background:none;border:0;padding:0" },
    tile(count(calls), "calls", `${count(failed)} failed (${percent(failed / calls)})`),
    tile(count(sessionCount), "sessions", `${percent(failedSessions / sessionCount)} met a failure`),
    tile(count(tools.length), "tools called", `${count(d3.median(sessions, (s) => s.calls) ?? 0)} calls in a median session`),
    tile(count(hosts.length), "agent hosts", hosts.map((h) => h.facet_value).slice(0, 3).join(", ") || "–"),
  );
  body.append(tiles);

  const volume = card("weekly-calls", `Calls per ${unit}`, m.timePrecise ? "By the time each call started." : "A filter kept only the week each span started in.");
  volume.chart.append(
    weekly.length
      ? chart({
          width: WIDTH, height: 220,
          x: { type: "band", label: null, tickFormat: (d: string) => d.slice(5) },
          y: { grid: true, label: "calls" },
          marks: [
            Plot.barY(weekly, { x: "week", y: "calls", fill: token("--series-1"), rx2: 4, inset: 1, tip: true, title: (w: Row) => `${unit === "day" ? "" : "Week of "}${w.week}\n${count(w.calls)} calls in ${count(w.sessions)} sessions` }),
            Plot.ruleY([0], { stroke: token("--axis") }),
          ],
        })
      : empty(),
    tableView(weekly, [{ key: "week", label: unit === "day" ? "Day" : "Week" }, { key: "calls", label: "Calls", numeric: true }, { key: "sessions", label: "Sessions", numeric: true }, { key: "failed", label: "Failed calls", numeric: true }]),
  );
  const failure = card("weekly-failure", "Sessions that met a failure", `Share of the ${unit}'s sessions with at least one failed call, with its 95 % interval.`);
  const rates = weekly.map((w) => ({ ...w, rate: w.sessions_with_failure / w.sessions, ...wilson(w.sessions_with_failure, w.sessions) }));
  failure.chart.append(
    rates.length
      ? chart({
          width: WIDTH, height: 220,
          x: { type: "band", label: null, tickFormat: (d: string) => d.slice(5) },
          y: { grid: true, label: "sessions", domain: [0, 1], tickFormat: "%" },
          marks: [
            Plot.ruleX(rates, { x: "week", y1: "low", y2: "high", stroke: token("--series-1"), strokeOpacity: 0.35, strokeWidth: 6 }),
            Plot.dot(rates, { x: "week", y: "rate", fill: token("--series-1"), r: 4, tip: true, title: (w: Row) => `${w.week}\n${count(w.sessions_with_failure)} of ${count(w.sessions)} sessions (${percent(w.rate)})` }),
            Plot.ruleY([0], { stroke: token("--axis") }),
          ],
        })
      : empty(),
  );
  body.append(volume.root, failure.root);
  return root;
}


// ---------------------------------------------------------------- tools

export function tools(facet: Facet): HTMLElement {
  const { root, body } = section("tools", "Tools", "Which tools are used, which fail more than their use explains, and how.");
  const rows = of("tools", facet);
  if (!rows.length) { body.append(empty()); return root; }

  // Funnel plot: a tool's share of sessions that met its failure, against how many sessions used it.
  const sessions = d3.sum(rows, (r) => r.sessions);
  const p0 = d3.sum(rows, (r) => r.sessions_failed) / sessions;
  const maxN = d3.max(rows, (r) => r.sessions) ?? 1;
  const limits = d3.range(1, maxN + 1, Math.max(1, Math.floor(maxN / 80))).concat([maxN]).map((n) => ({
    n, low: Math.max(0, p0 - 1.96 * Math.sqrt((p0 * (1 - p0)) / n)), high: Math.min(1, p0 + 1.96 * Math.sqrt((p0 * (1 - p0)) / n)),
  }));
  const points = rows.map((r) => ({ ...r, rate: r.sessions_failed / r.sessions, outside: r.sessions_failed / r.sessions > p0 + 1.96 * Math.sqrt((p0 * (1 - p0)) / r.sessions) }));
  const funnel = card("tools", "Failure against use", "Each dot is a tool: the sessions that used it, and the share of them in which it failed. Inside the funnel, the difference from the average is what chance alone would give; a labelled dot is above it.");
  funnel.chart.append(
    chart({
      width: WIDTH, height: 300,
      x: { type: "log", label: "sessions using the tool →", grid: true },
      y: { label: "↑ sessions in which it failed", domain: [0, 1], tickFormat: "%", grid: true },
      marks: [
        Plot.areaY(limits, { x: "n", y1: "low", y2: "high", fill: token("--grid"), fillOpacity: 0.6, curve: "monotone-x" }),
        Plot.ruleY([p0], { stroke: token("--muted") }),
        Plot.dot(points, { x: "sessions", y: "rate", r: 5, fill: (d: Row) => (d.outside ? token("--series-2") : token("--series-1")), stroke: token("--surface"), strokeWidth: 2, tip: true,
          title: (d: Row) => `${d.tool}\n${count(d.sessions_failed)} of ${count(d.sessions)} sessions failed (${percent(d.rate)})\n95 %: ${percent(d.session_failure_low)}–${percent(d.session_failure_high)}\n${count(d.failed)} of ${count(d.calls)} calls failed` }),
        Plot.text(points.filter((d) => d.outside), { x: "sessions", y: "rate", text: "tool", dx: 8, textAnchor: "start", fill: token("--ink") }),
      ],
    }),
    legend([["within chance", token("--series-1")], ["above the funnel", token("--series-2")]]),
  );

  // How each tool failed: kinds in their fixed colors.
  const failing = rows.filter((r) => r.failed > 0).sort((a, b) => b.failed - a.failed).slice(0, 15);
  const kinds = failing.flatMap((r) =>
    ([
      ["input_schema", r.input_schema], ["domain", r.domain], ["tool_result", r.tool_result],
      ["exception", r.exception], ["refused by PLexus", r.refused_by_plexus], ["other", (r.json_rpc ?? 0) + (r.other_failure ?? 0)],
    ] as [string, number][]).filter(([, n]) => n > 0).map(([kind, n]) => ({ tool: r.tool, kind, n })),
  );
  const how = card("tool-errors", "How tools fail", "Failed calls of the 15 tools that fail most, by the kind of error. Input schema: the arguments broke the tool's schema; domain: the tool refused what was asked; tool result: the tool answered with an error.");
  how.chart.append(
    kinds.length
      ? chart({
          width: WIDTH, height: 40 + 22 * failing.length, marginLeft: 130,
          x: { label: "failed calls →", grid: true },
          y: { label: null, domain: failing.map((r) => r.tool) },
          color: { domain: [...ERROR_KINDS], range: ERROR_KINDS.map(errorColor) },
          marks: [
            Plot.barX(kinds, Plot.stackX({ y: "tool", x: "n", fill: "kind", inset: 1, order: [...ERROR_KINDS], tip: true, title: (d: Row) => `${d.tool}\n${ERROR_LABELS[d.kind]}: ${count(d.n)}` })),
            Plot.ruleX([0], { stroke: token("--axis") }),
          ],
        })
      : empty("No call failed."),
    legend(ERROR_KINDS.map((k) => [ERROR_LABELS[k], errorColor(k)])),
  );

  const published = all("published");
  const used = new Set(rows.map((r) => r.tool));
  const unused = published.filter((p) => !used.has(p.tool));
  const inventory = card("tool-inventory", "Every tool", unused.length
    ? `Published but never called here: ${unused.map((u) => u.tool).join(", ")}.`
    : "Click a column to sort.", true);
  inventory.chart.append(table(rows.sort((a, b) => b.calls - a.calls), [
    { key: "tool", label: "Tool" },
    { key: "origin", label: "Origin" },
    { key: "calls", label: "Calls", numeric: true, format: count },
    { key: "sessions", label: "Sessions", numeric: true, format: count },
    { key: "failed", label: "Failed calls", numeric: true, format: count },
    { key: "sessions_failed", label: "Sessions failed", numeric: true, format: (v, r) => `${count(v)} (${percent(v / r.sessions)})` },
    { key: "session_failure_low", label: "95 % interval", numeric: true, format: (v, r) => `${percent(v)}–${percent(r.session_failure_high)}` },
    { key: "p50_ms", label: "Median ms", numeric: true, format: count },
    { key: "p90_ms", label: "p90 ms", numeric: true, format: count },
    { key: "budget_exceeded", label: "Cut to fit", numeric: true, format: count },
    { key: "unknown_arguments", label: "Unknown args", numeric: true, format: count },
  ]));
  const errors = of("errors", facet).sort((a, b) => b.calls - a.calls);
  const words = card("errors", "Failures in their own words", errors.some((e) => e.code || e.message || e.exception_type)
    ? "The error code, the exception's class and the message the client was answered with, numbers and quoted parts blanked so that one message is one row."
    : "These spans carry no error code, class or message: whatever exported them left them out.", true);
  words.chart.append(errors.length ? table(errors, [
    { key: "tool", label: "Tool" },
    { key: "error_kind", label: "Kind", format: (v) => ERROR_LABELS[errorKind(v)] },
    { key: "code", label: "Code" },
    { key: "exception_type", label: "Exception" },
    { key: "message", label: "Message" },
    { key: "calls", label: "Calls", numeric: true, format: count },
    { key: "sessions", label: "Sessions", numeric: true, format: count },
  ]) : empty("No call failed."));
  body.append(funnel.root, how.root, inventory.root, words.root);
  return root;
}

// ---------------------------------------------------------------- process

export function process(facet: Facet): HTMLElement {
  const { root, body } = section("process", "Process map",
    "The calls as an object-centric event log: each session's sequence of calls, and each tool's life within a session.");
  body.append(processMap(facet));
  const entropy = of("next-entropy", facet).filter((r) => r.calls >= 5).sort((a, b) => b.entropy_bits - a.entropy_bits);
  const next = card("next-entropy", "How predictable the next call is", "Entropy, in bits, of the call that follows each tool (tools called at least five times). Low: one move usually follows; high: the agent goes many ways from here.");
  next.chart.append(
    entropy.length
      ? chart({
          width: WIDTH, height: 40 + 18 * entropy.length, marginLeft: 130,
          x: { label: "bits →", grid: true },
          y: { label: null, domain: entropy.map((r) => r.tool) },
          marks: [
            Plot.barX(entropy, { y: "tool", x: "entropy_bits", fill: token("--series-1"), rx2: 4, inset: 1, tip: true, title: (d: Row) => `${d.tool}\n${d.entropy_bits.toFixed(2)} bits over ${d.successors} different next calls\n${count(d.calls)} calls` }),
            Plot.ruleX([0], { stroke: token("--axis") }),
          ],
        })
      : empty(),
  );
  const collocations = of("collocations", facet).filter((r) => r.count >= 3).sort((a, b) => b.lift - a.lift);
  const pairs = card("collocations", "Pairs that go together", "Calls that follow each other more often than their frequencies alone would make them (lift above 1): candidates for a fused tool or a richer answer.");
  pairs.chart.append(collocations.length ? table(collocations, [
    { key: "first", label: "First" },
    { key: "second", label: "Then" },
    { key: "count", label: "Times", numeric: true, format: count },
    { key: "sessions", label: "Sessions", numeric: true, format: count },
    { key: "p_next", label: "P(then | first)", numeric: true, format: (v) => percent(v) },
    { key: "lift", label: "Lift", numeric: true, format: (v) => v.toFixed(1) },
  ]) : empty());
  body.append(next.root, pairs.root);
  return root;
}

// ---------------------------------------------------------------- variants

export function variants(facet: Facet): HTMLElement {
  const { root, body } = section("variants", "Sessions",
    "Each session as the sequence of tools it called, a run of the same tool folded into one step (×).");
  const rows = of("variants", facet).sort((a, b) => b.sessions - a.sessions);
  const total = d3.sum(rows, (r) => r.sessions);
  const max = d3.max(rows, (r) => r.sessions) ?? 1;
  const list = card("variants", "Most common sessions", `The sequences most sessions share.${meta().minSessions > 1 ? ` Those shared by fewer than ${meta().minSessions} sessions are counted together, never shown.` : ""}`, true);
  let covered = 0;
  list.chart.append(
    rows.length
      ? table(rows.slice(0, 40).map((r) => ({ ...r, cumulative: (covered += r.variant === "other variants" ? 0 : r.sessions) / total })), [
          { key: "variant", label: "Sequence", format: (v) => v },
          { key: "length", label: "Steps", numeric: true, format: (v) => (v == null ? "" : String(v)) },
          { key: "sessions", label: "Sessions", numeric: true, format: count },
          { key: "sessions_failed", label: "With a failure", numeric: true, format: (v, r) => `${count(v)} (${percent(v / r.sessions)})` },
          { key: "cumulative", label: "Covered", numeric: true, format: (v, r) => (r.variant === "other variants" ? "" : percent(v)) },
        ])
      : empty(),
  );
  list.chart.querySelectorAll("tbody tr").forEach((tr, i) => {
    const r = rows[i];
    if (!r) return;
    const bar = el("div", { class: "bar" });
    bar.style.width = `${(100 * r.sessions) / max}%`;
    const cell = tr.children[0] as HTMLElement;
    cell.replaceChildren(el("div", { class: "variant" }, r.variant), bar);
  });
  const lengths = of("sessions", facet);
  const shape = card("session-length", "How long sessions are", "Calls per session. Sessions end after 30 minutes without a call, so a long conversation can be several.");
  shape.chart.append(
    lengths.length
      ? chart({
          width: WIDTH, height: 220, marginRight: 30,
          x: { type: "log", label: "calls in the session →" },
          y: { grid: true, label: "↑ sessions" },
          marks: [
            Plot.rectY(lengths, { ...Plot.binX({ y: "count" }, { x: "calls", thresholds: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987] }), fill: token("--series-1"), inset: 1, tip: true }),
            Plot.ruleY([0], { stroke: token("--axis") }),
          ],
        })
      : empty(),
  );
  body.append(list.root, shape.root);
  return root;
}

// ---------------------------------------------------------------- failures

const NEXT_ACTIONS = ["same call again", "same tool, other arguments", "another tool", "looked for a tool", "fell back to evaluate", "ended the session"];

export function failures(facet: Facet): HTMLElement {
  const { root, body } = section("failures", "After a failure",
    "What an agent did right after a failed call, and whether the tool worked for it later in the session.");
  const rows = of("recovery", facet).map((r) => ({ ...r, kind: errorKind(r.error_kind) }));
  const flow = card("recovery", "From failure to outcome", "Failed calls, by the kind of error, then what the agent did next, then whether the same tool worked later in that session. Hover a band for its count.", true);
  flow.chart.append(rows.length ? alluvial(rows) : empty("No call failed."), legend(ERROR_KINDS.map((k) => [ERROR_LABELS[k], errorColor(k)])));
  flow.chart.append(tableView(rows, [
    { key: "error_kind", label: "Error" }, { key: "next_action", label: "Next" }, { key: "outcome", label: "Outcome" },
    { key: "failures", label: "Failures", numeric: true, format: count }, { key: "sessions", label: "Sessions", numeric: true, format: count },
    { key: "median_calls_to_success", label: "Median calls to success", numeric: true, format: (v) => (v == null ? "–" : String(v)) },
  ]));

  const curves = of("recovery-curves", facet);
  const groups = ["all", ...ERROR_KINDS.filter((k) => curves.some((c) => c.group === k))];
  const incidence = card("recovery-curves", "Calls until the tool works", "After a failure, the share of failures whose tool has worked again (blue), and of those whose session ended first (orange), as calls go by. The two compete: counting ended sessions as censored would overstate recovery.");
  const holder = el("div");
  const drawCurves = (group: string) => {
    const data = curves.filter((c) => c.group === group && c.calls <= 30);
    const long = data.flatMap((d) => [
      { calls: d.calls, share: d.reached, outcome: "tool worked", at_risk: d.at_risk },
      { calls: d.calls, share: d.ended, outcome: "session ended first", at_risk: d.at_risk },
    ]);
    const last = (outcome: string) => long.filter((d) => d.outcome === outcome).at(-1);
    holder.replaceChildren(
      long.length
        ? chart({
            width: WIDTH, height: 240, marginRight: 110,
            x: { label: "calls after the failure →", grid: true },
            y: { label: "↑ share of failures", domain: [0, 1], tickFormat: "%", grid: true },
            color: { domain: ["tool worked", "session ended first"], range: [token("--series-1"), token("--series-2")] },
            marks: [
              Plot.line(long, { x: "calls", y: "share", stroke: "outcome", curve: "step-after", strokeWidth: 2 }),
              Plot.text([last("tool worked"), last("session ended first")].filter(Boolean) as Row[], { x: "calls", y: "share", text: (d: Row) => `${d.outcome} ${percent(d.share)}`, dx: 6, textAnchor: "start", fill: token("--ink") }),
              Plot.tip(long, Plot.pointerX({ x: "calls", y: "share", title: (d: Row) => `${d.calls} calls after: ${d.outcome} ${percent(d.share)}\n${count(d.at_risk)} failures still open` })),
            ],
          })
        : empty(),
    );
  };
  incidence.chart.append(segmented(groups.map((g) => [g, g === "all" ? "all errors" : ERROR_LABELS[g]]), "all", drawCurves), holder);
  drawCurves("all");

  const runs = of("failure-runs", facet);
  const repeats = card("failure-runs", "Failing again and again", "Runs of the same tool failing call after call: how long they last and how they end. A long run is the agent repeating what does not work.");
  const runRows = Array.from(d3.rollup(runs, (v) => d3.sum(v, (r) => r.runs), (r) => Math.min(r.length, 6), (r) => r.ending), ([length, endings]) =>
    Array.from(endings, ([ending, n]) => ({ length: length >= 6 ? "6+" : String(length), ending, n }))).flat();
  repeats.chart.append(
    runRows.length
      ? chart({
          width: WIDTH, height: 220,
          x: { label: "failed calls in a row →", domain: ["1", "2", "3", "4", "5", "6+"] },
          y: { grid: true, label: "↑ runs" },
          color: { domain: ["the tool worked", "another tool", "session ended"], range: [token("--series-1"), token("--series-2"), token("--series-3")] },
          marks: [
            Plot.barY(runRows, Plot.stackY({ x: "length", y: "n", fill: "ending", inset: 1, tip: true, title: (d: Row) => `${d.length} in a row, then ${d.ending}: ${count(d.n)}` })),
            Plot.ruleY([0], { stroke: token("--axis") }),
          ],
        })
      : empty("No tool failed twice in a row."),
    legend([["then the tool worked", token("--series-1")], ["then another tool", token("--series-2")], ["then the session ended", token("--series-3")]]),
    tableView(runs, [{ key: "tool", label: "Tool" }, { key: "length", label: "In a row", numeric: true }, { key: "ending", label: "Then" }, { key: "runs", label: "Runs", numeric: true }, { key: "sessions", label: "Sessions", numeric: true }]),
  );
  body.append(flow.root, incidence.root, chainRecovery(facet), repeats.root);
  return root;
}

function alluvial(rows: Row[]): Element {
  const outcomes = ["the tool worked later", "the tool never worked again"];
  const kinds = ERROR_KINDS.filter((k) => rows.some((r) => r.kind === k));
  const nodes = [
    ...kinds.map((k) => ({ id: `k:${k}`, label: ERROR_LABELS[k], column: 0 })),
    ...NEXT_ACTIONS.filter((a) => rows.some((r) => r.next_action === a)).map((a) => ({ id: `a:${a}`, label: a, column: 1 })),
    ...outcomes.filter((o) => rows.some((r) => r.outcome === o)).map((o) => ({ id: `o:${o}`, label: o, column: 2 })),
  ];
  const links = new Map<string, { source: string; target: string; value: number; kind: string }>();
  const add = (source: string, target: string, value: number, kind: string) => {
    const key = `${source}|${target}|${kind}`;
    const link = links.get(key) ?? { source, target, value: 0, kind };
    link.value += value;
    links.set(key, link);
  };
  for (const r of rows) {
    add(`k:${r.kind}`, `a:${r.next_action}`, r.failures, r.kind);
    add(`a:${r.next_action}`, `o:${r.outcome}`, r.failures, r.kind);
  }
  const width = 980, height = 360;
  type N = { id: string; label: string; column: number };
  const layout = sankey<N, { kind: string }>()
    .nodeId((d) => d.id)
    .nodeWidth(10)
    .nodePadding(14)
    .nodeSort(null)
    .extent([[1, 8], [width - 1, height - 8]]);
  const graph = layout({ nodes: nodes.map((d) => ({ ...d })), links: [...links.values()].map((d) => ({ ...d })) });
  // Scaled to the card, so the outcome column is never cut off on a narrow one.
  const svg = d3.create("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("width", "100%")
    .style("max-width", `${width}px`).style("height", "auto")
    .attr("role", "img").attr("aria-label", "Failed calls, what came next, and the outcome")
    .style("font", "11px system-ui, sans-serif");
  svg.append("g").attr("fill", "none").selectAll("path").data(graph.links).join("path")
    .attr("d", sankeyLinkHorizontal())
    .attr("stroke", (d) => errorColor((d as any).kind))
    .attr("stroke-opacity", 0.45)
    .attr("stroke-width", (d) => Math.max(1, d.width ?? 1))
    .append("title").text((d) => {
      const s = d.source as SankeyNode<N, object>, t = d.target as SankeyNode<N, object>;
      return `${ERROR_LABELS[(d as any).kind]}: ${s.label} → ${t.label}: ${count(d.value)}`;
    });
  svg.append("g").selectAll("rect").data(graph.nodes).join("rect")
    .attr("x", (d) => d.x0!).attr("y", (d) => d.y0!).attr("height", (d) => Math.max(1, d.y1! - d.y0!)).attr("width", (d) => d.x1! - d.x0!)
    .attr("rx", 2)
    .attr("fill", (d) => (d.column === 0 ? errorColor(d.id.slice(2)) : token("--ink-2")))
    .append("title").text((d) => `${d.label}: ${count(d.value)}`);
  svg.append("g").selectAll("text").data(graph.nodes).join("text")
    .attr("x", (d) => (d.x0! < width / 2 ? d.x1! + 6 : d.x0! - 6))
    .attr("y", (d) => (d.y0! + d.y1!) / 2)
    .attr("dy", "0.35em")
    .attr("text-anchor", (d) => (d.x0! < width / 2 ? "start" : "end"))
    .attr("fill", token("--ink"))
    .text((d) => `${d.label} · ${count(d.value)}`);
  void ({} as SankeyLink<N, object>);
  return svg.node()!;
}

// ---------------------------------------------------------------- arguments

export function argumentsSection(facet: Facet): HTMLElement {
  const { root, body } = section("arguments", "Arguments",
    "Where calls break a tool's input schema, the argument names agents expect that a tool lacks, and the options they use.");
  const schema = of("schema", facet);
  const cells = Array.from(d3.rollup(schema, (v) => ({ calls: d3.sum(v, (r) => r.calls), sessions: d3.max(v, (r) => r.sessions), keywords: [...new Set(v.map((r) => r.keyword))].join(", ") }), (r) => r.tool, (r) => r.path),
    ([tool, paths]) => Array.from(paths, ([path, value]) => ({ tool, path, ...value }))).flat();
  const heat = card("schema", "Where the schema breaks", `Calls refused for their arguments, by tool and by the place in its input they broke; the rule broken shows on hover. ${hidden("Cells")}`, true);
  const toolsOrder = d3.groupSort(cells, (v) => -d3.sum(v, (d) => d.calls), (d) => d.tool);
  const pathsOrder = d3.groupSort(cells, (v) => -d3.sum(v, (d) => d.calls), (d) => d.path);
  heat.chart.append(
    cells.length
      ? chart({
          width: Math.max(WIDTH, 140 + 70 * pathsOrder.length), height: 60 + 26 * toolsOrder.length, marginLeft: 140, marginBottom: 70,
          x: { domain: pathsOrder, label: null, tickRotate: -30 },
          y: { domain: toolsOrder, label: null },
          color: { type: "quantize", n: 5, range: sequential().slice(0, 5) },
          marks: [
            Plot.cell(cells, { x: "path", y: "tool", fill: "calls", inset: 1, rx: 3, tip: true, title: (d: Row) => `${d.tool} ${d.path}\n${count(d.calls)} calls in ${count(d.sessions)} sessions\nrules: ${d.keywords}` }),
            Plot.text(cells, { x: "path", y: "tool", text: (d: Row) => count(d.calls), fill: token("--seq-ink") }),
          ],
        })
      : empty("No call broke a tool's schema."),
  );
  const unknown = of("unknown-arguments", facet).sort((a, b) => b.calls - a.calls);
  const words = card("unknown-arguments", "Names agents expect", "Argument names calls gave that the tool does not take: a name many agents reach for is a candidate variant to accept, while the description keeps the canonical one.");
  words.chart.append(unknown.length ? table(unknown, [
    { key: "tool", label: "Tool" }, { key: "name", label: "Name given" },
    { key: "calls", label: "Calls", numeric: true, format: count }, { key: "sessions", label: "Sessions", numeric: true, format: count },
    { key: "failed", label: "Failed", numeric: true, format: count },
  ]) : empty("No call gave a name its tool lacks."));
  const options = of("options", facet).sort((a, b) => b.calls - a.calls);
  const used = card("options", "Options in use", "The options calls chose: a property given, a value of an enumeration, or a list for several targets. An option missing here is one nobody uses.");
  used.chart.append(options.length ? table(options, [
    { key: "tool", label: "Tool" }, { key: "option", label: "Option" },
    { key: "calls", label: "Calls", numeric: true, format: count }, { key: "sessions", label: "Sessions", numeric: true, format: count },
    { key: "failed", label: "Failed", numeric: true, format: (v, r) => `${count(v)} (${percent(v / r.calls)})` },
  ]) : empty());
  body.append(heat.root, words.root, used.root);
  return root;
}

// ---------------------------------------------------------------- discovery

export function discovery(facet: Facet): HTMLElement {
  const { root, body } = section("discovery", "Discovery and fallbacks",
    "Whether searching for a tool leads to calling it, what agents do when a search has more, and what precedes evaluate.");
  const rows = of("discovery", facet);
  const funnelCard = card("discovery", "From search to call", "Discovery calls, those that found something, and those followed within five calls by a call of a tool they named.");
  const searches = d3.sum(rows, (r) => r.calls);
  const found = d3.sum(rows.filter((r) => r.found !== "nothing" && r.found !== "not counted"), (r) => r.calls);
  const followed = d3.sum(rows.filter((r) => r.followed), (r) => r.calls);
  const stages = [
    { stage: "searched", n: searches }, { stage: "found something", n: found }, { stage: "then called a tool it named", n: followed },
  ];
  funnelCard.chart.append(
    searches
      ? chart({
          width: WIDTH, height: 150, marginLeft: 190,
          x: { label: "calls →", grid: true },
          y: { domain: stages.map((s) => s.stage), label: null },
          marks: [
            Plot.barX(stages, { y: "stage", x: "n", fill: token("--series-1"), rx2: 4, inset: 2, tip: true, title: (d: Row) => `${d.stage}: ${count(d.n)} (${percent(d.n / searches)})` }),
            Plot.text(stages, { y: "stage", x: "n", text: (d: Row) => `${count(d.n)} · ${percent(d.n / searches)}`, dx: 6, textAnchor: "start", fill: token("--ink") }),
            Plot.ruleX([0], { stroke: token("--axis") }),
          ],
        })
      : empty("No discovery call."),
    tableView(rows, [{ key: "tool", label: "Tool" }, { key: "found", label: "Found" }, { key: "more", label: "More existed" }, { key: "followed", label: "Followed" }, { key: "calls", label: "Calls", numeric: true }]),
  );
  const evaluate = of("evaluate", facet);
  const before = Array.from(d3.rollup(evaluate, (v) => d3.sum(v, (r) => r.calls), (r) => r.before, (r) => (r.before_failed ? "after it failed" : "after it worked")),
    ([tool, outcome]) => Array.from(outcome, ([after, n]) => ({ tool, after, n }))).flat();
  const order = d3.groupSort(before, (v) => -d3.sum(v, (d) => d.n), (d) => d.tool).slice(0, 15);
  const fallback = card("evaluate", "What comes before evaluate", "The call just before each evaluate, and whether it had failed: evaluate after a failure is a fallback, a sign a tool did not serve.");
  fallback.chart.append(
    before.length
      ? chart({
          width: WIDTH, height: 40 + 22 * order.length, marginLeft: 130,
          x: { label: "evaluate calls →", grid: true },
          y: { domain: order, label: null },
          color: { domain: ["after it worked", "after it failed"], range: [token("--series-1"), token("--series-2")] },
          marks: [
            Plot.barX(before.filter((d) => order.includes(d.tool)), Plot.stackX({ y: "tool", x: "n", fill: "after", inset: 1, tip: true, title: (d: Row) => `${d.tool}, ${d.after}: ${count(d.n)}` })),
            Plot.ruleX([0], { stroke: token("--axis") }),
          ],
        })
      : empty("No evaluate call."),
    legend([["after it worked", token("--series-1")], ["after it failed", token("--series-2")]]),
  );
  const more = of("more-results", facet);
  const moreCard = card("more-results", "When there were more results", "Answers that said more existed than they gave, and the agent's next move.");
  moreCard.chart.append(more.length ? table(more, [
    { key: "tool", label: "Tool" }, { key: "next_action", label: "Then" },
    { key: "calls", label: "Calls", numeric: true, format: count }, { key: "sessions", label: "Sessions", numeric: true, format: count },
  ]) : empty());
  body.append(funnelCard.root, fallback.root, evaluateWords(facet), moreCard.root);
  return root;
}

// ---------------------------------------------------------------- tests

export function tests(facet: Facet): HTMLElement {
  const { root, body } = section("tests", "Tests", "The field's nearest thing to a verifier: how test runs end, and how an edit gets to passing tests.");
  const rows = of("tests", facet);
  const matrix = card("tests", "One test run to the next", "How each test run ended, by how the session's previous run had ended (▶: the session's first).");
  const outcomes = ["▶", "passed", "failed", "errored", "none"];
  matrix.chart.append(
    rows.length
      ? chart({
          width: WIDTH, height: 220, marginLeft: 70,
          x: { domain: outcomes.slice(1), label: "this run", axis: "top" },
          y: { domain: outcomes, label: "previous" },
          color: { type: "quantize", n: 5, range: sequential().slice(0, 5) },
          marks: [
            Plot.cell(rows, { x: "test_outcome", y: "previous_outcome", fill: "runs", inset: 1, rx: 3, tip: true, title: (d: Row) => `${d.previous_outcome} → ${d.test_outcome}: ${count(d.runs)} runs in ${count(d.sessions)} sessions` }),
            Plot.text(rows, { x: "test_outcome", y: "previous_outcome", text: (d: Row) => count(d.runs), fill: token("--seq-ink") }),
          ],
        })
      : empty("No test run."),
  );
  const green = of("green-curves", facet).filter((r) => r.calls <= 40);
  const toGreen = card("green-curves", "From a compile to passing tests", "Sessions that compiled a method: the share whose tests passed after it (blue), and of those that ended first (orange), as calls go by.");
  const long = green.flatMap((d) => [{ calls: d.calls, share: d.reached, outcome: "tests passed" }, { calls: d.calls, share: d.ended, outcome: "session ended first" }]);
  toGreen.chart.append(
    long.length
      ? chart({
          width: WIDTH, height: 220, marginRight: 110,
          x: { label: "calls after the compile →", grid: true },
          y: { domain: [0, 1], tickFormat: "%", grid: true, label: "↑ sessions" },
          color: { domain: ["tests passed", "session ended first"], range: [token("--series-1"), token("--series-2")] },
          marks: [
            Plot.line(long, { x: "calls", y: "share", stroke: "outcome", curve: "step-after", strokeWidth: 2 }),
            Plot.text(["tests passed", "session ended first"].map((o) => long.filter((d) => d.outcome === o).at(-1)).filter(Boolean) as Row[],
              { x: "calls", y: "share", text: (d: Row) => `${d.outcome} ${percent(d.share)}`, dx: 6, textAnchor: "start", fill: token("--ink") }),
            Plot.tip(long, Plot.pointerX({ x: "calls", y: "share", title: (d: Row) => `${d.calls} calls after: ${d.outcome} ${percent(d.share)}` })),
          ],
        })
      : empty("No session compiled a method."),
  );
  body.append(matrix.root, toGreen.root);
  return root;
}

// ---------------------------------------------------------------- time and size

export function timeAndSize(facet: Facet): HTMLElement {
  const { root, body } = section("time", "Time and size", "How long each tool takes and how much it answers.");
  const latency = of("latency", facet);
  const order = d3.groupSort(latency, (v) => -d3.sum(v, (d) => d.calls), (d) => d.tool).slice(0, 20);
  const bins = [...new Set(latency.map((d) => d.bin_ms as number))].sort((a, b) => a - b);
  const time = card("latency", "Time per tool", "Calls by how long they took, in powers of two of milliseconds; the darker, the more calls.", true);
  const label = (ms: number) => (ms >= 1000 ? `${ms / 1000 >= 10 ? Math.round(ms / 1000) : (ms / 1000).toFixed(1)} s` : `${ms} ms`);
  time.chart.append(
    latency.length
      ? chart({
          width: Math.max(WIDTH, 160 + 44 * bins.length), height: 50 + 22 * order.length, marginLeft: 140,
          x: { domain: bins, tickFormat: label, label: "at least →" },
          y: { domain: order, label: null },
          color: { type: "quantize", n: 5, range: sequential().slice(0, 5) },
          marks: [Plot.cell(latency.filter((d) => order.includes(d.tool)), { x: "bin_ms", y: "tool", fill: "calls", inset: 1, rx: 3, tip: true, title: (d: Row) => `${d.tool}, ${label(d.bin_ms)} or more: ${count(d.calls)} calls` })],
        })
      : empty(),
  );
  const output = of("output", facet);
  const sizes = Array.from(d3.rollup(output, (v) => ({ calls: d3.sum(v, (r) => r.calls), cut: d3.sum(v, (r) => r.cut), median: d3.quantile(v.flatMap((r) => Array(r.calls).fill(r.output_bytes)), 0.5) ?? 0, p90: d3.quantile(v.flatMap((r) => Array(r.calls).fill(r.output_bytes)).sort(d3.ascending), 0.9) ?? 0 }), (r) => r.tool),
    ([tool, v]) => ({ tool, ...v })).sort((a, b) => b.p90 - a.p90).slice(0, 20);
  const size = card("output", "Answer sizes", "The median and 90th percentile of each tool's answer, in bytes (sizes are kept in powers of two), and how many answers were cut to fit the output budget.");
  size.chart.append(
    sizes.length
      ? chart({
          width: WIDTH, height: 40 + 20 * sizes.length, marginLeft: 140,
          x: { type: "log", label: "bytes →", grid: true },
          y: { domain: sizes.map((s) => s.tool), label: null },
          marks: [
            Plot.ruleY(sizes, { y: "tool", x1: (d: Row) => Math.max(1, d.median), x2: (d: Row) => Math.max(1, d.p90), stroke: token("--series-1"), strokeWidth: 2 }),
            Plot.dot(sizes, { y: "tool", x: (d: Row) => Math.max(1, d.median), fill: token("--series-1"), r: 4 }),
            Plot.dot(sizes, { y: "tool", x: (d: Row) => Math.max(1, d.p90), stroke: token("--series-1"), fill: token("--surface"), r: 4, strokeWidth: 2, tip: true, title: (d: Row) => `${d.tool}\nmedian ${count(d.median)} B, p90 ${count(d.p90)} B\n${count(d.cut)} of ${count(d.calls)} answers cut` }),
          ],
        })
      : empty(),
    legend([["median (filled)", token("--series-1")], ["90th percentile (ring)", token("--series-1")]]),
  );
  const images = all("images");
  const lifecycle = card("images", "Images", "What PLexus did to images for agents, from its own spans: how often, how it ended, how long it took.");
  lifecycle.chart.append(images.length ? table(images, [
    { key: "operation", label: "Operation" }, { key: "status", label: "Status" }, { key: "error_type", label: "Error" },
    { key: "spans", label: "Times", numeric: true, format: count }, { key: "sessions", label: "Sessions", numeric: true, format: count },
    { key: "p50_ms", label: "Median ms", numeric: true, format: count }, { key: "p90_ms", label: "p90 ms", numeric: true, format: count },
  ]) : empty());
  body.append(time.root, size.root, lifecycle.root);
  return root;
}

// ---------------------------------------------------------------- releases

export function releases(): HTMLElement {
  const { root, body } = section("releases", "Releases",
    "Each tool's share of sessions in which it failed, release by release, with its 95 % interval; the ring is the same rate as if every release had seen the same mix of agent hosts.");
  const rows = all("releases");
  const holder = el("div");
  const draw = (component: string) => {
    const data = rows.filter((r) => r.component === component);
    const multi = d3.groups(data, (r) => r.tool).filter(([, v]) => v.length > 1).sort((a, b) => d3.sum(b[1], (r) => r.sessions) - d3.sum(a[1], (r) => r.sessions)).slice(0, 12);
    const shown = multi.flatMap(([, v]) => v);
    const releasesOrder = [...new Set(data.map((r) => r.release as string))].sort((a, b) => d3.ascending(...[a, b].map((v) => v.split(".").map((n) => n.padStart(4, "0")).join(".")) as [string, string]));
    holder.replaceChildren(
      shown.length
        ? chart({
            width: 980, height: 40 + multi.length * (22 + 16 * releasesOrder.length), marginLeft: 80,
            fy: { label: null, domain: multi.map(([tool]) => tool) },
            y: { domain: releasesOrder, label: null },
            x: { domain: [0, 1], tickFormat: "%", grid: true, label: "sessions in which the tool failed →" },
            facet: { marginRight: 120 },
            marks: [
              Plot.frame({ stroke: token("--grid") }),
              Plot.ruleY(shown, { fy: "tool", y: "release", x1: "rate_low", x2: "rate_high", stroke: token("--series-1"), strokeOpacity: 0.4, strokeWidth: 6 }),
              Plot.dot(shown, { fy: "tool", y: "release", x: "rate", fill: token("--series-1"), r: 4, tip: true,
                title: (d: Row) => `${d.tool} in ${component} ${d.release}\n${count(d.sessions_failed)} of ${count(d.sessions)} sessions (${percent(d.rate)})\n95 %: ${percent(d.rate_low)}–${percent(d.rate_high)}\nsame host mix: ${percent(d.standardised_rate)}${d.covered < 0.999 ? ` (covers ${percent(d.covered)} of it)` : ""}` }),
              Plot.dot(shown, { fy: "tool", y: "release", x: "standardised_rate", stroke: token("--ink"), r: 6, strokeWidth: 1.5 }),
            ],
          })
        : empty(`No tool was called under two ${component} releases yet.`),
    );
  };
  const control = segmented([["MCP", "MCP"], ["PLexus", "PLexus"]], "MCP", draw);
  const wide = el("div", { class: "card wide", "data-view": "releases" }, el("h3", {}, "Release against release"), el("div", { class: "controls" }, control), holder,
    tableView(rows, [
      { key: "component", label: "Component" }, { key: "release", label: "Release" }, { key: "tool", label: "Tool" },
      { key: "sessions", label: "Sessions", numeric: true }, { key: "sessions_failed", label: "Failed", numeric: true },
      { key: "rate", label: "Rate", numeric: true, format: (v) => percent(v) },
      { key: "rate_low", label: "95 %", numeric: true, format: (v, r) => `${percent(v)}–${percent(r.rate_high)}` },
      { key: "standardised_rate", label: "Same host mix", numeric: true, format: (v) => percent(v) },
      { key: "hosts", label: "Hosts", numeric: true },
    ]));
  draw("MCP");
  body.append(wide);
  return root;
}

// ---------------------------------------------------------------- method

export function method(): HTMLElement {
  const m = meta();
  const { root, body } = section("method", "Method", "What these numbers are, and what they cannot say.");
  body.append(
    el("div", { class: "method card wide", "data-view": "method" },
      el("p", {}, `Built ${m.generated.slice(0, 10)} from ${count(m.spans)} spans of MCP and PLexus: ${count(m.calls)} calls in ${count(m.sessions)} sessions, from ${m.first} to ${m.last}.`),
      el("h3", {}, "Calls and sessions"),
      el("ul", {},
        el("li", {}, "A call is the spans one tool call left: PLexus's span and the image's, joined within their trace. A call an image's tool_call dispatched is counted as dispatched, not as a call the agent made."),
        el("li", {}, "A session ends after 30 minutes without a call. Subagents of one agent share its session, so their calls interleave in it."),
        el("li", {}, m.timePrecise
          ? "Calls are ordered by the time they started, and the time between two calls is real."
          : "A filter kept only the week of each span, and each call's offset in its session: calls are ordered within their session only, and every sequence here lives inside one session."),
        el("li", {}, "A call failed when its span is an error, or names an error type, an MCP error kind or a PLexus refusal: a refused argument is not an error on the span by OpenTelemetry's conventions, but it is a failed call here.")),
      el("h3", {}, "Rates"),
      el("ul", {},
        el("li", {}, "Calls of one session are not independent: a rate is given per session as well as per call, and its 95 % interval (Wilson) is the session's."),
        el("li", {}, "Recovery and compile-to-tests curves are cumulative incidence (Aalen–Johansen), with the session's end as a competing outcome."),
        el("li", {}, "Release comparisons are also given with every release weighted to the same mix of agent hosts (direct standardisation): hosts fail differently, and their mix moves between releases.")),
      el("h3", {}, "Markov models"),
      el("ul", {},
        el("li", {}, "The process map is a first-order Markov chain's counts, and its arrows by probability are the chain's transition probabilities. The order test says whether the next call depends on more than the last one."),
        el("li", {}, "Orders and numbers of phases are judged by the likelihood ratio, AIC and BIC, which charge for every probability a model estimates, and by the likelihood of whole sessions held out of the fit; phases are held out while the calls are 50,000 or fewer, BIC deciding alone beyond."),
        el("li", {}, "Every model runs on whatever calls there are, and says what they support: a penalised criterion choosing less memory or fewer phases than the others means the calls are still too few for more."),
        el("li", {}, "Subagents share their agent's session, so their calls interleave: transitions nobody made in sequence, which make the chain look less predictable than each agent is.")),
      el("h3", {}, "What is left out"),
      el("ul", {},
        el("li", {}, m.minSessions > 1
          ? `A host or release with fewer than ${m.minSessions} sessions has no view of its own. A sequence, a pair, a schema place, an argument name, an option or an error message shared by fewer than ${m.minSessions} sessions is not shown; rare sequences are counted together.`
          : "Nothing: every session counts, as for spans read by whoever made them. A report read by others should be built with a threshold (--min-sessions)."),
        el("li", {}, m.filtered
          ? "A filter chose what these spans keep before they were exported; what it dropped, this report cannot show."
          : "These spans are as the tools sent them."),
        el("li", {}, m.content
          ? "Some spans carry the calls' arguments and answers (content capture was on): the report compares a repeated call's arguments and names the classes and messages of evaluate's code, but shows no value, answer or code."
          : "The spans hold no argument value or answer (content capture was off) and no prompt: the report says where agents struggle, never why.")),
      el("h3", {}, "Few data"),
      el("p", {}, `A view warns when the calls are too few for what it shows: when its shares rest on fewer than ${m.enough ?? 39} calls or sessions, so their 95 % interval is wider than ±${Math.round(100 * (m.rough ?? 0.15))} points, or when the criteria that choose a model disagree, AIC and BIC choosing less memory or fewer phases than held-out sessions. The Views menu hides views, those with few data among them.`),
      el("h3", {}, "What these spans could not give"),
      ((missing) => missing.length
        ? el("ul", {}, ...missing.map((text) => el("li", {}, text)))
        : el("p", {}, "Nothing: every view of this report has what it needs."))(lacks()),
      el("h3", {}, "The event log"),
      el("p", {}, "The same calls are written as an OCEL 2.0 object-centric event log (`pharo-agent-analytics ocel`): events are calls, objects the session, the tool as used in a session, the input places a call broke, the tool, the agent host and the releases, and, when the spans hold them, the host's trace, the agent and the model."),
    ),
  );
  return root;
}
