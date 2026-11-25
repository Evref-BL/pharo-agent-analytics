// What the reader sees of the report: the build's warnings on the views
// whose calls are too few, and the views the reader chose to show.
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

function icon(): SVGSVGElement {
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
 * facet's own above the report, each view's in a note under its title, and a
 * sign in the corner of every view a warning concerns. */
export function applyWarnings(report: HTMLElement, facet: Facet): void {
  for (const row of of("warnings", facet)) {
    if (row.view === "report") {
      report.prepend(warning(row.message, true));
      continue;
    }
    const view = report.querySelector<HTMLElement>(`[data-view="${CSS.escape(row.view)}"]`);
    if (!view) continue;
    if (row.shown === "sign") {
      sign(view, `${row.message} The note above the report says so for every view.`);
    } else {
      const anchor = view.querySelector(":scope > p.note") ?? view.querySelector(":scope > h3");
      anchor?.after(warning(row.message));
      sign(view, "The note under the title says what these calls are too few for.");
    }
    view.dataset.warning = "true";
  }
}

function views(report: HTMLElement): HTMLElement[] {
  return [...report.querySelectorAll<HTMLElement>("[data-view]")];
}

const lacks = (view: HTMLElement) => view.querySelector(".lacking") != null;

/** Hide the views the reader turned off, and a section with none left, with its link. */
export function applyVisibility(report: HTMLElement): void {
  for (const view of views(report)) view.hidden = hidden.has(view.dataset.view!);
  for (const section of report.querySelectorAll<HTMLElement>("section")) {
    const own = [...section.querySelectorAll<HTMLElement>("[data-view]")];
    section.hidden = own.length > 0 && own.every((v) => v.hidden);
    const link = document.querySelector<HTMLElement>(`.sections a[href="#${section.id}"]`);
    if (link) link.hidden = section.hidden;
  }
}

/** The panel that turns views on and off, grouped by section, each marked when it warns or lacks its data. */
export function fillPanel(panel: HTMLElement, summary: HTMLElement, report: HTMLElement): void {
  const all = views(report);
  const update = () => {
    save();
    applyVisibility(report);
    const n = all.filter((v) => hidden.has(v.dataset.view!)).length;
    summary.textContent = n ? `Views · ${n} hidden` : "Views";
    for (const box of panel.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) box.checked = !hidden.has(box.value);
    for (const refresh of refreshers) refresh();
  };
  // Each action counts the views it would change, and is off when it would change none.
  const refreshers: (() => void)[] = [];
  const action = (label: string, pick: (v: HTMLElement) => boolean, show: boolean) => {
    const button = el("button", { type: "button" });
    const targets = () => all.filter((v) => pick(v) && hidden.has(v.dataset.view!) === show);
    refreshers.push(() => {
      const n = targets().length;
      button.textContent = n ? `${label} (${n})` : label;
      button.disabled = !n;
    });
    button.addEventListener("click", () => {
      for (const v of targets()) show ? hidden.delete(v.dataset.view!) : hidden.add(v.dataset.view!);
      update();
    });
    return button;
  };
  const groups = [...report.querySelectorAll<HTMLElement>("section")].map((section) => {
    const own = [...section.querySelectorAll<HTMLElement>("[data-view]")].filter((v) => v.querySelector("h3"));
    if (!own.length) return null;
    return el("fieldset", {},
      el("legend", {}, section.querySelector("h2")?.textContent ?? section.id),
      ...own.map((view) => {
        const id = view.dataset.view!;
        const box = el("input", { type: "checkbox", value: id });
        box.checked = !hidden.has(id);
        box.addEventListener("change", () => {
          box.checked ? hidden.delete(id) : hidden.add(id);
          update();
        });
        return el("label", {}, box, el("span", {}, view.querySelector("h3")!.textContent ?? id),
          view.dataset.warning ? el("span", { class: "badge few" }, icon(), "few data") : null,
          lacks(view) ? el("span", { class: "badge lacking" }, "no data here") : null);
      }));
  });
  panel.replaceChildren(
    el("p", { class: "note" }, "Choose the views to show; the choice stays in this browser. Views marked few data carry a warning for these calls."),
    el("div", { class: "views-actions" },
      action("Show all", () => true, true),
      action("Hide those these spans cannot fill", lacks, false),
      action("Hide those with few data", (v) => v.dataset.warning === "true", false)),
    ...groups.filter((g): g is HTMLFieldSetElement => g != null),
  );
  update();
}
