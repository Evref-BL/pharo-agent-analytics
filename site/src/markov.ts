// The calls as Markov models: how far back the next call looks, where a
// longer memory matters, the phases sessions go through, and what the chain
// expects after a failure. Each view shows what the criteria say the calls
// support, whatever they support.

import * as Plot from "@observablehq/plot";
import { meta, of, type Facet, type Row } from "./data";
import { card, chart, count, duration, el, empty, legend, percent, section, segmented, sequential, series, table, tableView, token, wilson } from "./ui";

const WIDTH = 520;


const bits = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(2));
const fixed = (v: number | null | undefined, digits = 1) => (v == null ? "–" : v.toLocaleString("en", { maximumFractionDigits: digits, minimumFractionDigits: digits }));

/** "BIC: 0 · held-out sessions: 1": what each criterion picks. */
function verdict(rows: Row[], key: string, unit: (n: number) => string): string {
  const picks = new Map<string, number>();
  for (const row of rows) for (const name of row.chosen_by ?? []) picks.set(name, row[key]);
  return [...picks].map(([name, n]) => `${name}: ${unit(n)}`).join(" · ");
}

export function markovSection(facet: Facet): HTMLElement {
  const { root, body } = section("markov", "Markov models",
    "The calls as a Markov chain: how far back the next call looks, where a longer memory matters, and the phases sessions go through.");
  body.append(order(facet), memory(facet), phases(facet));
  return root;
}

function order(facet: Facet): HTMLElement {
  const rows = of("markov-order", facet).sort((a, b) => a.order - b.order);
  const view = card("markov-order", "How far back the next call looks",
    "Chains that remember the last 0 to 3 calls, each judged four ways: the likelihood ratio of each order against the one below, AIC and BIC, which charge for every probability a chain estimates, and how well each predicts sessions it was not fitted on.");
  if (!rows.length) {
    view.chart.append(empty());
    return view.root;
  }
  const first = rows.find((r) => r.order === 1);
  const picks = verdict(rows, "order", (n) => (n === 0 ? "no memory" : `${n} call${n > 1 ? "s" : ""} back`));
  const support = first
    ? `A chain of the last call estimates ${count(first.parameters)} probabilities from ${count(first.transitions)} transitions.`
    : "";
  const heldout = rows.filter((r) => r.heldout_bits != null);
  view.chart.append(
    el("p", { class: "verdict" }, picks),
    el("p", { class: "note" }, support),
    heldout.length
      ? chart({
          width: 440, height: 200,
          x: { label: "calls remembered →", ticks: rows.map((r) => r.order), tickFormat: (d: number) => String(d) },
          y: { label: "↑ bits to predict a held-out call", grid: true, zero: false },
          marks: [
            Plot.line(heldout, { x: "order", y: "heldout_bits", stroke: token("--series-1"), strokeWidth: 2 }),
            Plot.dot(heldout, { x: "order", y: "heldout_bits", fill: token("--series-1"), r: 4, stroke: token("--surface"), strokeWidth: 2,
              tip: true, title: (d: Row) => `${d.order} call${d.order === 1 ? "" : "s"} back: ${bits(d.heldout_bits)} bits per held-out call` }),
          ],
        })
      : empty("Too few sessions to hold any out."),
    tableView(rows, [
      { key: "order", label: "Calls back", numeric: true },
      { key: "contexts", label: "Contexts seen", numeric: true, format: count },
      { key: "parameters", label: "Probabilities", numeric: true, format: count },
      { key: "log_likelihood", label: "Log-likelihood", numeric: true, format: (v) => fixed(v) },
      { key: "lr", label: "Ratio (df)", numeric: true, format: (v, r) => (v == null ? "–" : `${fixed(v)} (${count(r.df)})`) },
      { key: "p_value", label: "p", numeric: true, format: (v) => (v == null ? "–" : v < 0.001 ? "< 0.001" : v.toFixed(3)) },
      { key: "aic", label: "AIC", numeric: true, format: (v) => fixed(v) },
      { key: "bic", label: "BIC", numeric: true, format: (v) => fixed(v) },
      { key: "heldout_bits", label: "Held-out bits", numeric: true, format: bits },
      { key: "chosen_by", label: "Chosen by", format: (v) => (v?.length ? v.join(", ") : "") },
    ]),
  );
  return view.root;
}

function memory(facet: Facet): HTMLElement {
  const k = meta().minSessions;
  const rows = of("markov-memory", facet).filter((r) => r.gain_bits > 0).slice(0, 15);
  const view = card("markov-memory", "Where the call before last matters",
    "Pairs of calls after which the next call differs most from what the last call alone predicts, ranked by the information the earlier call adds over the times the pair occurred." +
      (k > 1 ? ` Pairs shared by fewer than ${k} sessions are not shown.` : ""));
  view.chart.append(rows.length ? table(rows, [
    { key: "before", label: "Before" },
    { key: "last", label: "Last" },
    { key: "next", label: "Then" },
    { key: "p_after_both", label: "After both", numeric: true, format: (v) => percent(v) },
    { key: "p_after_last", label: "After the last", numeric: true, format: (v) => percent(v) },
    { key: "times", label: "Times", numeric: true, format: count },
    { key: "sessions", label: "Sessions", numeric: true, format: count },
    { key: "gain_bits", label: "Bits added", numeric: true, format: (v) => fixed(v) },
  ]) : empty("No pair changes what follows."));
  return view.root;
}

function phases(facet: Facet): HTMLElement {
  const fits = of("phase-fits", facet).sort((a, b) => a.phases - b.phases);
  const view = card("phases", "Phases of a session",
    "A hidden Markov model: each call comes from a phase the spans do not name, phases follow one another as a chain, and each phase calls tools of its own. Phases are numbered by when they come in a session.",
    true);
  const counts = fits.map((f) => f.phases).filter((n) => n >= 2);
  if (!counts.length) {
    view.chart.append(empty());
    return view.root;
  }
  const pick = (name: string) => fits.find((f) => f.chosen_by?.includes(name))?.phases as number | undefined;
  const preferred = [pick("held-out sessions"), pick("BIC")].find((n) => n != null && n >= 2) ?? 2;
  const picks = verdict(fits, "phases", (n) => `${n} phase${n > 1 ? "s" : ""}`);
  const holder = el("div", { class: "phases" });
  const draw = (k: number) => holder.replaceChildren(...phaseViews(facet, k));
  view.chart.append(
    el("p", { class: "verdict" }, picks),
    el("div", { class: "controls" }, el("label", {}, "Phases", segmented(counts.map((n) => [String(n), String(n)]), String(preferred), (v) => draw(Number(v))))),
    holder,
    tableView(fits, [
      { key: "phases", label: "Phases", numeric: true },
      { key: "parameters", label: "Probabilities", numeric: true, format: count },
      { key: "log_likelihood", label: "Log-likelihood", numeric: true, format: (v) => fixed(v) },
      { key: "bic", label: "BIC", numeric: true, format: (v) => fixed(v) },
      { key: "heldout_bits", label: "Held-out bits", numeric: true, format: bits },
      { key: "chosen_by", label: "Chosen by", format: (v) => (v?.length ? v.join(", ") : "") },
    ], "Model comparison"),
  );
  draw(preferred);
  return view.root;
}

function phaseViews(facet: Facet, k: number): Node[] {
  const colors = series();
  const domain = Array.from({ length: k }, (_, i) => `Phase ${i + 1}`);
  const name = (n: number) => `Phase ${n}`;
  const rows = of("phases", facet).filter((r) => r.phases === k).sort((a, b) => a.phase - b.phase);
  const places = of("phase-places", facet).filter((r) => r.phases === k).map((r) => ({ ...r, name: name(r.phase), tenth: r.decile + 1 }));
  const transitions = of("phase-transitions", facet).filter((r) => r.phases === k).map((r) => ({ ...r, from: name(r.source), to: name(r.target) }));
  const color = { domain, range: colors.slice(0, k) };

  const flow = el("div", { class: "phase-chart" },
    el("h4", {}, "Where each phase comes"),
    chart({
      width: WIDTH, height: 220,
      x: { label: "tenth of the session →", ticks: [1, 5, 10] },
      y: { label: "↑ share of calls", tickFormat: "%", grid: true },
      color,
      marks: [
        Plot.areaY(places, Plot.stackY({ x: "tenth", y: "share", fill: "name", curve: "monotone-x", order: domain,
          stroke: token("--surface"), strokeWidth: 1.5,
          tip: true, title: (d: Row) => `${d.name}, tenth ${d.tenth}: ${percent(d.share)} of calls` })),
        Plot.ruleY([0], { stroke: token("--axis") }),
      ],
    }),
    legend(domain.map((d, i) => [d, colors[i]])),
  );

  const ramp = sequential();
  const matrix = el("div", { class: "phase-chart" },
    el("h4", {}, "What phase comes next"),
    chart({
      width: Math.min(WIDTH, 120 + 64 * k), height: 60 + 40 * k, marginLeft: 70,
      x: { label: "next →", domain, axis: "top", tickFormat: (d: string) => d.replace("Phase ", "") },
      y: { label: null, domain },
      color: { type: "linear", domain: [0, 1], range: [ramp[0], ramp[7]] },
      marks: [
        Plot.cell(transitions, { x: "to", y: "from", fill: "p", inset: 1, rx: 3,
          tip: true, title: (d: Row) => `${d.from} → ${d.to}: ${percent(d.p)}` }),
        Plot.text(transitions, { x: "to", y: "from", text: (d: Row) => percent(d.p), fill: (d: Row) => (d.p > 0.55 ? token("--surface") : token("--seq-ink")) }),
      ],
    }),
  );

  const phaseTable = table(rows, [
    { key: "phase", label: "Phase", format: (v) => `Phase ${v}` },
    { key: "tools", label: "Its tools", format: (v, r) => (v as string[]).map((t, i) => `${t} ${percent(r.probabilities[i])}`).join(", ") },
    { key: "share", label: "Calls", numeric: true, format: (v) => percent(v) },
    { key: "failed", label: "Failed", numeric: true, format: (v) => percent(v) },
    { key: "dwell", label: "Stays, calls", numeric: true, format: (v) => fixed(v) },
    { key: "starts", label: "Starts sessions", numeric: true, format: (v) => percent(v) },
    { key: "ends", label: "Ends sessions", numeric: true, format: (v) => percent(v) },
  ]);
  return [el("div", { class: "phase-row" }, flow, matrix), phaseTable];
}

/** For the failures section: the chain's answer beside what was observed. */
export function chainRecovery(facet: Facet): HTMLElement {
  const rows = of("markov-recovery", facet).filter((r) => r.failures > 0).sort((a, b) => b.failures - a.failures).slice(0, 15)
    .map((r): Row => ({ ...r, observed: r.recovered / r.failures, ...wilson(r.recovered, r.failures) }));
  const view = card("markov-recovery", "What the chain expects after a failure",
    "The first-order chain over each tool, worked or failed, from every transition of these sessions: from a failed call, the chance the tool works before the session ends (dot), beside the share of failures whose tool did work later (ring, with its 95 % interval). Far apart, what the agent does next depends on more than its last call. When the spans keep each call's place in its session, the chain also says how long until the tool works, from each state's mean time (a semi-Markov chain), beside the observed median.");
  if (!rows.length) {
    view.chart.append(empty("No call failed."));
    return view.root;
  }
  view.chart.append(
    chart({
      width: WIDTH, height: 40 + 24 * rows.length, marginLeft: 150,
      x: { label: "chance the tool works before the session ends →", domain: [0, 1], tickFormat: "%", grid: true },
      y: { label: null, domain: rows.map((r) => r.tool) },
      marks: [
        Plot.ruleY(rows, { y: "tool", x1: "low", x2: "high", stroke: token("--series-2"), strokeOpacity: 0.6 }),
        Plot.dot(rows, { y: "tool", x: "observed", r: 5, stroke: token("--series-2"), strokeWidth: 2, fill: token("--surface"),
          tip: true, title: (d: Row) => `${d.tool}: worked later after ${count(d.recovered)} of ${count(d.failures)} failures (${percent(d.observed)})` }),
        Plot.dot(rows, { y: "tool", x: "p_works", r: 4, fill: token("--series-1"), stroke: token("--surface"), strokeWidth: 2,
          tip: true, title: (d: Row) => `${d.tool}: the chain gives ${percent(d.p_works)}, in ${fixed(d.calls_if_works)} calls${d.seconds_if_works != null ? ` and ${duration(d.seconds_if_works * 1000)}` : ""} on average when it works` }),
      ],
    }),
    legend([["the chain", token("--series-1")], ["observed", token("--series-2")]]),
    tableView(rows, [
      { key: "tool", label: "Tool" },
      { key: "failures", label: "Failures", numeric: true, format: count },
      { key: "recovered", label: "Worked later", numeric: true, format: count },
      { key: "p_works", label: "Chain: works", numeric: true, format: (v) => percent(v) },
      { key: "p_ends", label: "Chain: ends first", numeric: true, format: (v) => percent(v) },
      { key: "calls_if_works", label: "Chain: mean calls until it works", numeric: true, format: (v) => fixed(v) },
      { key: "median_calls", label: "Observed: median calls", numeric: true, format: (v) => fixed(v) },
      ...(rows.some((r) => r.seconds_if_works != null) ? [
        { key: "seconds_if_works", label: "Chain: mean time until it works", numeric: true, format: (v: number | null) => duration(v == null ? null : v * 1000) },
        { key: "median_seconds", label: "Observed: median time", numeric: true, format: (v: number | null) => duration(v == null ? null : v * 1000) },
      ] : []),
    ]),
  );
  return view.root;
}
