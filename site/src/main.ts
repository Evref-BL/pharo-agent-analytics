import { all, load, meta, type Facet } from "./data";
import {
  argumentsSection, discovery, failures, method, overview, process, releases, tests, timeAndSize, tools, variants,
} from "./sections";
import { count, el } from "./ui";

const FILES = [
  "meta", "facets", "weekly", "tools", "dfg", "tool-use-dfg", "variants", "recovery", "recovery-curves", "schema",
  "unknown-arguments", "options", "discovery", "evaluate", "collocations", "tests", "green-curves", "latency", "output",
  "sessions", "failure-runs", "more-results", "next-entropy", "releases", "images", "published",
];

const FACET_LABELS: Record<string, string> = { host: "Agent host", MCP: "MCP release", PLexus: "PLexus release", environment: "Environment" };

function facetFromHash(): Facet {
  // #facet=MCP:4.5.0 is not a plain name the viewer passes on, so the facet lives in the page only.
  return { facet: "all", value: "all" };
}

async function main() {
  await load(FILES);
  const m = meta();
  const lede = document.getElementById("lede")!;
  if (!m) {
    lede.textContent = "No data: run `pharo-agent-analytics build` first.";
    return;
  }
  lede.textContent = `${count(m.calls)} tool calls in ${count(m.sessions)} sessions, weeks of ${m.firstWeek} to ${m.lastWeek}.`;

  const select = document.getElementById("facet") as HTMLSelectElement;
  select.append(el("option", { value: "all|all" }, `All calls (${count(m.calls)})`));
  for (const kind of ["host", "MCP", "PLexus", "environment"]) {
    const values = all("facets").filter((f) => f.facet === kind);
    if (!values.length) continue;
    const group = el("optgroup", { label: FACET_LABELS[kind] });
    for (const v of values) group.append(el("option", { value: `${kind}|${v.facet_value}` }, `${v.facet_value} (${count(v.sessions)} sessions)`));
    select.append(group);
  }

  const report = document.getElementById("report")!;
  let facet = facetFromHash();
  const render = () => {
    report.replaceChildren(
      overview(facet), tools(facet), process(facet), variants(facet), failures(facet),
      argumentsSection(facet), discovery(facet), tests(facet), timeAndSize(facet), releases(), method(),
    );
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
}

main();
