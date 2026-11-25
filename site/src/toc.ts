// The sidebar, in two modes. Contents: every section of the report and the
// views shown in it, warned ones signed, the one in view marked while
// scrolling. Filter: every view with a box to show or hide it, remembered in
// this browser. Beside the report on a wide screen; a drawer the Contents
// button opens on a narrow one.

import { el } from "./ui";
import { applyVisibility, icon, isHidden, lacks, setHidden } from "./views";

let spy: IntersectionObserver | null = null;

export function closeToc(): void {
  document.body.classList.remove("toc-open");
  document.getElementById("toc-button")?.setAttribute("aria-expanded", "false");
}

/** Mark the link of the view (and its section) nearest the top of the screen. */
function mark(toc: HTMLElement, id: string): void {
  let active: HTMLElement | null = null;
  for (const link of toc.querySelectorAll<HTMLAnchorElement>("a")) {
    const on = link.hash === `#${id}`;
    if (on) {
      link.setAttribute("aria-current", "location");
      active = link;
    } else {
      link.removeAttribute("aria-current");
    }
  }
  const section = active?.closest("li.toc-section")?.querySelector<HTMLAnchorElement>(":scope > a");
  for (const link of toc.querySelectorAll("li.toc-section > a")) link.classList.toggle("within", link === section && link !== active);
  // Keep the marked link in sight inside the sidebar, without moving the page.
  if (active) {
    const box = toc.getBoundingClientRect(), at = active.getBoundingClientRect();
    if (at.top < box.top + 40 || at.bottom > box.bottom - 40) toc.scrollTop += at.top - box.top - box.height / 3;
  }
}

/** The sidebar's two modes: contents to go to a view, or the filter that chooses the views shown. */
let filtering = false;

function svgIcon(paths: string[], dots: [number, number][] = []): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("mode-icon");
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  for (const [cx, cy] of dots) {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", "1.2");
    svg.append(dot);
  }
  return svg;
}

/** Three bars, shorter and shorter: filter. */
const filterIcon = () => svgIcon(["M3 5.5h14", "M5.5 10h9", "M8 14.5h4"]);
/** A bulleted list: the contents. */
const contentsIcon = () => svgIcon(["M7.5 5.5h9", "M7.5 10h9", "M7.5 14.5h9"], [[4, 5.5], [4, 10], [4, 14.5]]);

interface Entry { section: HTMLElement; views: HTMLElement[] }

function entries(report: HTMLElement): Entry[] {
  return [...report.querySelectorAll<HTMLElement>("section")].map((section) => ({
    section,
    views: [...section.querySelectorAll<HTMLElement>("[data-view]")].filter((v) => v.querySelector(":scope > h3")),
  }));
}

const title = (view: HTMLElement) => view.querySelector(":scope > h3")?.textContent ?? view.dataset.view!;
const sectionTitle = (section: HTMLElement) => section.querySelector("h2")?.textContent ?? section.id;

/** The contents: the sections and views shown, the one in view marked while scrolling. */
function contents(toc: HTMLElement, list: Entry[]): { items: HTMLElement[]; targets: HTMLElement[] } {
  const items: HTMLElement[] = [];
  const targets: HTMLElement[] = [];
  for (const { section, views } of list) {
    if (section.hidden) continue;
    const links = views.filter((v) => !v.hidden).map((view) => {
      targets.push(view);
      const lacking = lacks(view);
      return el("li", lacking ? { class: "lacking" } : {},
        el("a", { href: `#${view.id}`, title: lacking ? "These spans lack what this view needs" : "" },
          el("span", {}, title(view)), view.dataset.warning ? icon() : null));
    });
    targets.push(section);
    items.push(el("li", { class: "toc-section" }, el("a", { href: `#${section.id}` }, sectionTitle(section)),
      links.length ? el("ul", {}, ...links) : null));
  }
  for (const item of items) {
    for (const link of item.querySelectorAll<HTMLAnchorElement>("a")) {
      link.addEventListener("click", () => {
        closeToc();
        mark(toc, decodeURIComponent(link.hash.slice(1)));
      });
    }
  }
  return { items, targets };
}

/** The filter: every view, hidden ones too, each with its box; a section's box turns all of its views. */
function filter(list: Entry[], changed: () => void): { items: HTMLElement[]; refresh: () => void } {
  const boxes: [HTMLInputElement, HTMLElement[]][] = [];
  const refresh = () => {
    for (const [box, views] of boxes) {
      const shown = views.filter((v) => !isHidden(v.dataset.view!)).length;
      box.checked = shown === views.length;
      box.indeterminate = shown > 0 && shown < views.length;
      box.closest("li")?.classList.toggle("off", shown === 0);
    }
  };
  const toggle = (views: HTMLElement[], box: HTMLInputElement) => {
    box.addEventListener("change", () => {
      // A section partly shown shows all of its views; one fully shown hides them all.
      const allShown = views.every((v) => !isHidden(v.dataset.view!));
      setHidden(views.map((v) => v.dataset.view!), allShown);
      changed();
    });
    boxes.push([box, views]);
    return box;
  };
  const items = list.filter((e) => e.views.length).map(({ section, views }) => el("li", { class: "toc-section" },
    el("label", {}, toggle(views, el("input", { type: "checkbox" })), el("span", {}, sectionTitle(section))),
    el("ul", {}, ...views.map((view) => el("li", lacks(view) ? { class: "lacking" } : {},
      el("label", { title: lacks(view) ? "These spans lack what this view needs" : view.dataset.warning ? "Few data: these calls are too few for what this view shows" : "" },
        toggle([view], el("input", { type: "checkbox" })), el("span", {}, title(view)),
        view.dataset.warning ? icon() : null))))));
  return { items, refresh };
}

/** Fill the sidebar from the report as it is drawn, in the mode the reader chose. */
export function buildToc(toc: HTMLElement, report: HTMLElement): void {
  const list = entries(report);
  for (const { views } of list) for (const view of views) view.id ||= `view-${view.dataset.view}`;
  const all = list.flatMap((e) => e.views);
  const count = el("span", { class: "toc-count" });
  const mode = el("button", {
    type: "button", class: "toc-mode", "aria-pressed": String(filtering),
    "aria-label": "Filter views", title: filtering ? "Back to contents" : "Filter views",
  }, filtering ? contentsIcon() : filterIcon());
  mode.addEventListener("click", () => {
    filtering = !filtering;
    const scroll = toc.scrollTop;
    buildToc(toc, report);
    toc.scrollTop = scroll;
    toc.querySelector<HTMLElement>(".toc-mode")?.focus();
  });
  const head = el("div", { class: "toc-head" }, el("p", { class: "toc-title" }, filtering ? "Views shown" : "Contents", count), mode);
  const counted = () => {
    const n = all.filter((v) => isHidden(v.dataset.view!)).length;
    count.textContent = n ? ` · ${n} hidden` : "";
  };

  spy?.disconnect();
  if (filtering) {
    const actions: (() => void)[] = [];
    const changed = () => {
      applyVisibility(report);
      counted();
      refresh();
      for (const update of actions) update();
    };
    const action = (label: string, pick: (v: HTMLElement) => boolean, show: boolean) => {
      const button = el("button", { type: "button" });
      const targets = () => all.filter((v) => pick(v) && isHidden(v.dataset.view!) === show);
      actions.push(() => {
        const n = targets().length;
        button.textContent = n ? `${label} (${n})` : label;
        button.disabled = !n;
      });
      button.addEventListener("click", () => {
        setHidden(targets().map((v) => v.dataset.view!), !show);
        changed();
      });
      return button;
    };
    const { items, refresh } = filter(list, changed);
    toc.replaceChildren(head,
      el("p", { class: "note" }, "Tick the views to show; the choice stays in this browser."),
      el("div", { class: "views-actions" },
        action("Show all", () => true, true),
        action("Hide those with no data", lacks, false),
        action("Hide those with few data", (v) => v.dataset.warning === "true", false)),
      el("ul", { class: "toc-filter" }, ...items));
    changed();
    return;
  }

  const { items, targets } = contents(toc, list);
  toc.replaceChildren(head, el("ul", {}, ...items));
  counted();
  // The view nearest the top, among those crossing the upper part of the screen.
  const visible = new Map<HTMLElement, number>();
  spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.set(entry.target as HTMLElement, entry.boundingClientRect.top);
      else visible.delete(entry.target as HTMLElement);
    }
    for (const target of visible.keys()) visible.set(target, target.getBoundingClientRect().top);
    // A view wins over its section: the section is the fallback between its views.
    const ranked = [...visible.entries()].sort((a, b) =>
      Number(a[0].tagName === "SECTION") - Number(b[0].tagName === "SECTION") || Math.abs(a[1]) - Math.abs(b[1]));
    const nearest = ranked[0];
    if (!nearest) return;
    // Views side by side share their top: the one the address names, if any, else the first.
    const named = decodeURIComponent(location.hash.slice(1));
    const row = ranked.filter(([t, top]) => t.tagName === nearest[0].tagName && Math.abs(top - nearest[1]) < 8);
    mark(toc, (row.find(([t]) => t.id === named) ?? nearest)[0].id);
  }, { rootMargin: `-${getComputedStyle(document.documentElement).getPropertyValue("--masthead-h").trim() || "140px"} 0px -55% 0px` });
  for (const target of targets) spy.observe(target);
}

/** The Contents button, the drawer's backdrop, and the masthead's height the sidebar sits under. */
export function setUpToc(): void {
  const button = document.getElementById("toc-button")!;
  const backdrop = document.getElementById("toc-backdrop")!;
  button.addEventListener("click", () => {
    const open = document.body.classList.toggle("toc-open");
    button.setAttribute("aria-expanded", String(open));
  });
  backdrop.addEventListener("click", closeToc);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeToc(); });
  const masthead = document.querySelector<HTMLElement>(".masthead")!;
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--masthead-h", `${Math.ceil(masthead.getBoundingClientRect().height)}px`);
  }).observe(masthead);
}
