import { all, load, meta, type Facet } from "./data";
import {
  argumentsSection, discovery, failures, method, overview, process, releases, tests, timeAndSize, tools, variants,
} from "./sections";
import { agentSection } from "./agent";
import { markovSection } from "./markov";
import { count, el } from "./ui";
import { buildToc, setUpToc } from "./toc";
import { applyVisibility, applyWarnings, fillPanel, setUpViewsMenu } from "./views";

const FILES = [
  "meta", "facets", "weekly", "tools", "dfg", "tool-use-dfg", "variants", "recovery", "recovery-curves", "schema",
  "unknown-arguments", "options", "discovery", "evaluate", "collocations", "tests", "green-curves", "latency", "output",
  "sessions", "failure-runs", "more-results", "next-entropy", "releases", "images", "published", "errors",
  "markov-order", "markov-memory", "markov-recovery", "phase-fits", "phases", "phase-transitions", "phase-places",
  "time-split", "agent-time", "answer-time", "hours", "traces", "host", "tokens", "evaluate-words", "warnings",
];

const FACET_LABELS: Record<string, string> = {
  host: "Agent host", MCP: "MCP release", PLexus: "PLexus release", Pharo: "Pharo version", environment: "Environment",
  OS: "Operating system", VM: "Pharo VM", model: "Model", agent: "Agent",
};


async function main() {
  await load(FILES);
  const m = meta();
  if (!m) {
    document.getElementById("report")!.append(el("p", { class: "empty" }, "No data: run `pharo-agent-analytics build` first."));
    return;
  }

  const select = document.getElementById("facet") as HTMLSelectElement;
  select.append(el("option", { value: "all|all" }, `All calls (${count(m.calls)})`));
  // The facets every export can have, then the resource attributes the build was asked to facet by.
  for (const kind of [...Object.keys(FACET_LABELS), ...(m.customFacets ?? [])]) {
    const values = all("facets").filter((f) => f.facet === kind);
    if (!values.length) continue;
    const group = el("optgroup", { label: FACET_LABELS[kind] ?? kind });
    for (const v of values) group.append(el("option", { value: `${kind}|${v.facet_value}` }, `${v.facet_value} (${count(v.sessions)} sessions)`));
    select.append(group);
  }

  const report = document.getElementById("report")!;
  const panel = document.getElementById("views-panel")!;
  const summary = document.querySelector<HTMLElement>("#views > summary")!;
  const toc = document.getElementById("toc")!;
  setUpToc();
  setUpViewsMenu();
  let facet: Facet = { facet: "all", value: "all" };
  const render = () => {
    report.replaceChildren(
      overview(facet), tools(facet), process(facet), markovSection(facet), variants(facet), failures(facet),
      argumentsSection(facet), discovery(facet), tests(facet), timeAndSize(facet), agentSection(facet), releases(), method(),
    );
    applyWarnings(report, facet);
    // The sidebar follows the views shown, drawn again when the reader changes them.
    fillPanel(panel, summary, report, () => buildToc(toc, report));
    applyVisibility(report);
  };
  select.addEventListener("change", () => {
    const [kind, value] = select.value.split("|");
    facet = { facet: kind, value };
    render();
  });
  // Colors come from the theme's tokens: draw again when it changes.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  render();
  // The report is drawn after the page loads: go to the section or view a link named.
  if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}

main();
