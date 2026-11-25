// The sidebar: every section of the report and the views in it, as the
// reader sees them (hidden views left out, warned ones signed), with the one
// in view marked while scrolling. Beside the report on a wide screen; a
// drawer the Contents button opens on a narrow one.

import { el } from "./ui";
import { icon } from "./views";

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

/** Fill the sidebar from the report as it is drawn. */
export function buildToc(toc: HTMLElement, report: HTMLElement): void {
  const items: HTMLElement[] = [];
  const targets: HTMLElement[] = [];
  for (const section of report.querySelectorAll<HTMLElement>("section")) {
    if (section.hidden) continue;
    const views = [...section.querySelectorAll<HTMLElement>("[data-view]")].filter((v) => !v.hidden && v.querySelector(":scope > h3"));
    const links = views.map((view) => {
      view.id ||= `view-${view.dataset.view}`;
      targets.push(view);
      const lacking = view.querySelector(".lacking") != null;
      return el("li", lacking ? { class: "lacking" } : {},
        el("a", { href: `#${view.id}`, title: lacking ? "These spans lack what this view needs" : "" },
          el("span", {}, view.querySelector(":scope > h3")!.textContent ?? ""),
          view.dataset.warning ? icon() : null));
    });
    targets.push(section);
    items.push(el("li", { class: "toc-section" },
      el("a", { href: `#${section.id}` }, section.querySelector("h2")?.textContent ?? section.id),
      links.length ? el("ul", {}, ...links) : null));
  }
  toc.replaceChildren(el("p", { class: "toc-title" }, "Contents"), el("ul", {}, ...items));
  for (const link of toc.querySelectorAll("a")) link.addEventListener("click", closeToc);

  // The view nearest the top, among those crossing the upper part of the screen.
  spy?.disconnect();
  const visible = new Map<HTMLElement, number>();
  spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.set(entry.target as HTMLElement, entry.boundingClientRect.top);
      else visible.delete(entry.target as HTMLElement);
    }
    for (const target of visible.keys()) visible.set(target, target.getBoundingClientRect().top);
    // A view wins over its section: the section is the fallback between its views.
    const nearest = [...visible.entries()].sort((a, b) =>
      Number(a[0].tagName === "SECTION") - Number(b[0].tagName === "SECTION") || Math.abs(a[1]) - Math.abs(b[1]))[0];
    if (nearest) mark(toc, nearest[0].id);
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
