// What the reader sees of the report: the build's warnings on the views
// whose calls are too few, and the views the reader chose to show (chosen in
// the sidebar's filter).
//
// Every view is an element with `data-view`; the warnings name views by the
// same ids. The choice of views is a convenience of this browser only.

import { of, type Facet } from "./data";
import { el } from "./ui";

const KEY = "pharo-agent-analytics:hidden-views";

function stored(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

const hidden = stored();

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...hidden]));
  } catch {
    // Private windows and blocked storage: the choice lasts until the page closes.
  }
}

export function icon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("warning-icon");
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute("d", "M8 1.5 15 14H1z");
  shape.setAttribute("class", "warning-shape");
  const mark = document.createElementNS(ns, "path");
  mark.setAttribute("d", "M8 6v4M8 11.6v.4");
  mark.setAttribute("class", "warning-mark");
  svg.append(shape, mark);
  return svg;
}

export function warning(text: string, banner = false): HTMLElement {
  return el("div", { class: banner ? "warning banner" : "warning", role: "note" },
    icon(), el("p", {}, el("strong", {}, "Few data. "), text));
}

let signs = 0;

/** A sign in the view's corner, found at a glance; hovering, focusing or tapping it says why. */
function sign(view: HTMLElement, text: string): void {
  let tip = view.querySelector<HTMLElement>(":scope > .flag .tip");
  if (!tip) {
    const id = `few-data-${++signs}`;
    tip = el("div", { class: "tip", role: "tooltip", id }, el("strong", {}, "Few data"));
    const button = el("button", { type: "button", class: "flag-button", "aria-label": "Few data", "aria-describedby": id }, icon());
    const flag = el("span", { class: "flag" }, button, tip);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      flag.classList.toggle("open");
    });
    view.append(flag);
  }
  tip.append(el("p", {}, text));
}

// A tapped sign stays open until a tap elsewhere or Escape.
const closeSigns = () => document.querySelectorAll(".flag.open").forEach((f) => f.classList.remove("open"));
document.addEventListener("click", closeSigns);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSigns(); });

/** Put the build's warnings for this facet on the views they concern: the
 * facet's own above the report, and on each view one mark only. A view's own
 * warning is a note under its title; a view the facet's warning concerns, and
 * no warning of its own, gets a sign in its corner, whose details are the note
 * above the report. */
export function applyWarnings(report: HTMLElement, facet: Facet): void {
  const rows = of("warnings", facet);
  const noted = new Set(rows.filter((r) => r.shown !== "sign").map((r) => r.view));
  for (const row of rows) {
    if (row.view === "report") {
      report.prepend(warning(row.message, true));
      continue;
    }
    const view = report.querySelector<HTMLElement>(`[data-view="${CSS.escape(row.view)}"]`);
    if (!view) continue;
    if (row.shown !== "sign") {
      const anchor = view.querySelector(":scope > p.note") ?? view.querySelector(":scope > h3");
      anchor?.after(warning(row.message));
    } else if (!noted.has(row.view)) {
      sign(view, `${row.message} The note above the report says so for every view.`);
      view.dataset.sign = "true";
    }
    view.dataset.warning = "true";
  }
}

function views(report: HTMLElement): HTMLElement[] {
  return [...report.querySelectorAll<HTMLElement>("[data-view]")];
}

/** The view shows nothing: these spans lack what it needs. */
export const lacks = (view: HTMLElement) => view.querySelector(".lacking") != null;

export const isHidden = (id: string) => hidden.has(id);

/** Turn views off or on, and remember it in this browser. */
export function setHidden(ids: string[], hide: boolean): void {
  for (const id of ids) hide ? hidden.add(id) : hidden.delete(id);
  save();
}

/** Hide the views the reader turned off, and a section with none left. */
export function applyVisibility(report: HTMLElement): void {
  for (const view of views(report)) view.hidden = hidden.has(view.dataset.view!);
  for (const section of report.querySelectorAll<HTMLElement>("section")) {
    const own = [...section.querySelectorAll<HTMLElement>("[data-view]")];
    section.hidden = own.length > 0 && own.every((v) => v.hidden);
  }
}
