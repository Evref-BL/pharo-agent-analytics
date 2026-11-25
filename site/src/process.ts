// The process map: an object-centric directly-follows graph, laid out by Graphviz.
//
// Two object types have a life worth drawing: the session (which call follows
// which) and a tool as used in one session (the calls that named it, then its
// own calls, ok or failed). Time across sessions is not kept, so no other
// object gets a sequence. Arrows show how often a step is taken, its chance
// (the Markov chain's), or the median time between the two calls' starts.

import type { Viz } from "@viz-js/viz";
import { of, type Facet, type Row } from "./data";
import { count, duration, el, empty, percent, segmented, sequential, token } from "./ui";

let viz: Promise<Viz> | null = null;

const ARROWS: Record<string, string> = {
  count: "Arrows: times taken",
  share: "Arrows: the chance a call follows the tool, P(next | tool), out of all its next calls, those hidden here included",
  time: "Arrows: the median time from one call's start to the next's, thicker the longer",
};

const START = "▶";
const END = "■";

function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

type Arrows = "count" | "share" | "time";

interface Graph { nodes: Map<string, { calls: number; failed: number }>; edges: Row[] }

function sessionGraph(facet: Facet, keep: number, minEdge: number): { graph: Graph; total: number } {
  const tools = of("tools", facet).sort((a, b) => b.calls - a.calls);
  const kept = new Set(tools.slice(0, keep).map((t) => t.tool as string));
  kept.add(START).add(END);
  const nodes = new Map<string, { calls: number; failed: number }>();
  for (const t of tools) if (kept.has(t.tool)) nodes.set(t.tool, { calls: t.calls, failed: t.failed });
  const edges = of("dfg", facet).filter((e) => kept.has(e.source) && kept.has(e.target) && e.count >= minEdge);
  return { graph: { nodes, edges }, total: tools.length };
}

function toolUseGraph(facet: Facet, tool: string, minEdge: number): Graph {
  const edges = of("tool-use-dfg", facet).filter((e) => e.tool === tool && e.count >= minEdge);
  const nodes = new Map<string, { calls: number; failed: number }>();
  for (const e of edges) {
    for (const name of [e.source, e.target]) {
      if (name === START) continue;
      const node = nodes.get(name) ?? { calls: 0, failed: 0 };
      nodes.set(name, node);
    }
    const target = nodes.get(e.target)!;
    target.calls += e.count;
    if (e.target === "failed") target.failed += e.count;
  }
  return { nodes, edges };
}

function dot(graph: Graph, colorBy: "calls" | "failure", arrows: Arrows): string {
  const ramp = sequential();
  const ink = token("--ink");
  const ink2 = token("--ink-2");
  const muted = token("--muted");
  const ring = token("--axis");
  const seqInk = token("--seq-ink");
  const maxCalls = Math.max(1, ...[...graph.nodes.values()].map((n) => n.calls));
  const maxEdge = Math.max(1, ...graph.edges.map((e) => e.count));
  const maxGap = Math.max(1, ...graph.edges.map((e) => (e.median_gap_ms as number | null) ?? 0));
  const fill = (node: { calls: number; failed: number }) => {
    const share = colorBy === "calls" ? Math.sqrt(node.calls / maxCalls) : node.calls ? node.failed / node.calls : 0;
    // The light end of the ramp recedes toward the surface; labels stay ink on the first five steps.
    return ramp[Math.min(4, Math.floor(share * 5))];
  };
  const lines = [
    "digraph G {",
    `graph [rankdir=TB, bgcolor="transparent", nodesep=0.35, ranksep=0.45, fontname="system-ui", pad=0.2];`,
    `node [shape=box, style="rounded,filled", fontname="system-ui", fontsize=11, penwidth=1, color=${quote(ring)}, fontcolor=${quote(seqInk)}, margin="0.14,0.06"];`,
    `edge [fontname="system-ui", fontsize=9, color=${quote(muted)}, fontcolor=${quote(ink2)}, arrowsize=0.6];`,
    `${quote(START)} [shape=circle, label="", width=0.18, style=filled, fillcolor=${quote(ink)}, color=${quote(ink)}, tooltip="start"];`,
    `${quote(END)} [shape=doublecircle, label="", width=0.14, style=filled, fillcolor=${quote(ink)}, color=${quote(ink)}, tooltip="end"];`,
  ];
  for (const [name, node] of graph.nodes) {
    if (name === START || name === END) continue;
    const failure = node.calls ? node.failed / node.calls : 0;
    const detail = node.failed ? `${count(node.calls)} · ${percent(failure)} failed` : count(node.calls);
    lines.push(
      `${quote(name)} [label=${quote(`${name}\n${detail}`)}, fillcolor=${quote(fill(node))}, tooltip=${quote(`${name}: ${count(node.calls)} calls, ${count(node.failed)} failed`)}];`,
    );
  }
  for (const e of graph.edges) {
    // By count, how much traffic an arrow carries; by share, the Markov
    // chain's P(target | source), out of everything that followed the source.
    // By time, the median time from the source call's start to the target's,
    // on a log scale: the slow steps of a session stand out.
    const gapMs = e.median_gap_ms as number | null;
    const width = arrows === "count" ? 0.6 + 5 * Math.sqrt(e.count / maxEdge)
      : arrows === "share" ? 0.6 + 5 * e.share
      : gapMs != null && gapMs > 0 ? 0.6 + 5 * Math.log1p(gapMs) / Math.log1p(maxGap) : 0.6;
    const label = arrows === "count" ? (e.count >= maxEdge * 0.04 ? count(e.count) : "")
      : arrows === "share" ? (e.share >= 0.05 ? percent(e.share) : "")
      : gapMs != null && e.count >= maxEdge * 0.04 ? duration(gapMs) : "";
    const gap = gapMs != null ? `, ${duration(gapMs)} apart at the median` : "";
    lines.push(
      `${quote(e.source)} -> ${quote(e.target)} [penwidth=${width.toFixed(2)}, label=${quote(label)}, tooltip=${quote(`${e.source} → ${e.target}: ${count(e.count)} times in ${count(e.sessions)} sessions, ${percent(e.share)} of what followed ${e.source}${gap}`)}];`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

// The fewest times an arrow must be taken for the map of `keep` tools to draw
// about two arrows per tool, beyond which a map is more knot than map.
function readableMinEdge(facet: Facet, keep: number): number {
  const counts = sessionGraph(facet, keep, 1).graph.edges.map((e) => e.count as number).sort((a, b) => b - a);
  return Math.max(1, counts[2 * keep - 1] ?? 1);
}

export function processMap(facet: Facet): HTMLElement {
  const tools = of("tools", facet).sort((a, b) => b.calls - a.calls);
  if (!tools.length) return empty();
  const keep = Math.min(14, tools.length);
  const state = { object: "session", tool: tools[0].tool as string, keep, minEdge: readableMinEdge(facet, keep), colorBy: "calls" as "calls" | "failure", arrows: "count" as Arrows };
  const busiest = Math.max(1, ...of("dfg", facet).map((e) => e.count as number));
  const canvas = el("div", { class: "process", role: "img", "aria-label": "Process map of the calls" });
  const caption = el("p", { class: "note" });

  const toolSelect = el("select", { "aria-label": "Tool" }, ...tools.map((t) => el("option", { value: t.tool }, t.tool)));
  const keepInput = el("input", { type: "range", min: "3", max: String(Math.max(3, tools.length)), value: String(state.keep) });
  const edgeInput = el("input", { type: "range", min: "1", max: String(Math.min(busiest, 50)), value: String(state.minEdge) });
  const keepLabel = el("span");
  const edgeLabel = el("span");
  const toolControl = el("label", {}, "Tool", toolSelect);
  const keepControl = el("label", {}, "Tools shown", keepInput, keepLabel);

  const draw = async () => {
    // Graphviz is a large WASM module: loaded with the first map, never with the page.
    viz ??= import("@viz-js/viz").then((module) => module.instance());
    keepLabel.textContent = String(state.keep);
    edgeLabel.textContent = `≥ ${state.minEdge}`;
    toolControl.hidden = state.object !== "tool";
    keepControl.hidden = state.object !== "session";
    let graph: Graph;
    if (state.object === "session") {
      const built = sessionGraph(facet, state.keep, state.minEdge);
      graph = built.graph;
      caption.textContent =
        `Each box is a tool, each arrow a call that followed another in a session; ▶ starts and ■ ends a session. ` +
        `${state.keep} of ${built.total} tools, arrows taken at least ${state.minEdge} time${state.minEdge > 1 ? "s" : ""}. ` +
        `Shade: ${state.colorBy === "calls" ? "how often the tool is called" : "the share of its calls that failed"}. ` +
        `${ARROWS[state.arrows]}. Click a tool to follow its own use.`;
    } else {
      graph = toolUseGraph(facet, state.tool, state.minEdge);
      caption.textContent =
        `The life of ${state.tool} within each session: the calls that named it (a search), then its own calls, ok or failed. ` +
        `An arrow from failed to ok is a recovery; failed to failed, a repeat. ` +
        `${state.arrows === "share" ? "Arrows: the chance of what comes next in the tool's life" : ARROWS[state.arrows]}.`;
    }
    if (!graph.edges.length) {
      canvas.replaceChildren(empty("No arrow is taken that often here."));
      return;
    }
    const svg = (await viz).renderSVGElement(dot(graph, state.colorBy, state.arrows));
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    for (const node of svg.querySelectorAll<SVGGElement>("g.node")) {
      const name = node.querySelector("title")?.textContent ?? "";
      if (state.object === "session" && name !== START && name !== END) {
        node.style.cursor = "pointer";
        node.addEventListener("click", () => {
          state.object = "tool";
          state.tool = name;
          toolSelect.value = name;
          objectSwitch.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String(i === 1)));
          draw();
        });
      }
    }
    canvas.replaceChildren(svg);
  };

  const objectSwitch = segmented(
    [["session", "Sessions"], ["tool", "A tool's use"]],
    state.object,
    (value) => { state.object = value; draw(); },
  );
  const colorSwitch = segmented(
    [["calls", "Shade by calls"], ["failure", "Shade by failure"]],
    state.colorBy,
    (value) => { state.colorBy = value as "calls" | "failure"; draw(); },
  );
  const arrowSwitch = segmented(
    [["count", "Arrows by count"], ["share", "Arrows by probability"], ["time", "Arrows by time"]],
    state.arrows,
    (value) => { state.arrows = value as Arrows; draw(); },
  );
  toolSelect.addEventListener("change", () => { state.tool = toolSelect.value; draw(); });
  keepInput.addEventListener("input", () => { state.keep = Number(keepInput.value); draw(); });
  edgeInput.addEventListener("input", () => { state.minEdge = Number(edgeInput.value); draw(); });

  const controls = el("div", { class: "controls" }, el("label", {}, "Object", objectSwitch), toolControl, keepControl,
    el("label", {}, "Arrows taken", edgeInput, edgeLabel), colorSwitch, arrowSwitch);
  draw();
  return el("div", { class: "card wide", "data-view": "process-map" }, el("h3", {}, "Process map"), controls, caption, canvas);
}
