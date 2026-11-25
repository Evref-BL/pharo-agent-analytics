// Small pieces every section uses: elements, cards, legends, table views, theme colors.

import type { Row } from "./data";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  for (const child of children) if (child != null) node.append(child);
  return node;
}

export function section(id: string, title: string, lede: string): { root: HTMLElement; body: HTMLElement } {
  const body = el("div", { class: "grid" });
  const root = el("section", { id }, el("div", { class: "section-head" }, el("h2", {}, title), el("p", {}, lede)), body);
  return { root, body };
}

export function card(title: string, note?: string, wide = false): { root: HTMLElement; chart: HTMLElement } {
  const chart = el("div", { class: "chart" });
  const root = el("div", { class: wide ? "card wide" : "card" }, el("h3", {}, title), note ? el("p", { class: "note" }, note) : null, chart);
  return { root, chart };
}

export function empty(text = "Nothing to show for these calls yet."): HTMLElement {
  return el("p", { class: "empty" }, text);
}

/** A CSS custom property of the current theme. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function series(): string[] {
  return [1, 2, 3, 4, 5, 6].map((i) => token(`--series-${i}`));
}

export function sequential(): string[] {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((i) => token(`--seq-${i}`));
}

export function legend(entries: [string, string][]): HTMLElement {
  return el(
    "div",
    { class: "legend" },
    ...entries.map(([label, color]) => {
      const swatch = el("i");
      swatch.style.background = color;
      return el("span", {}, swatch, label);
    }),
  );
}

export const percent = (value: number | null | undefined, digits = 0): string =>
  value == null || Number.isNaN(value) ? "–" : `${(value * 100).toFixed(digits)}%`;

export const count = (value: number | null | undefined): string =>
  value == null ? "–" : Math.round(value).toLocaleString("en");

export interface Column { key: string; label: string; numeric?: boolean; format?: (value: any, row: Row) => string }

/** A sortable table: every chart has one, so no value is read from color or a tooltip alone. */
export function table(rows: Row[], columns: Column[], limit = 500): HTMLElement {
  let sortKey: string | null = null;
  let descending = true;
  const tbody = el("tbody");
  const render = () => {
    const sorted = sortKey
      ? [...rows].sort((a, b) => {
          const x = a[sortKey!], y = b[sortKey!];
          const order = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
          return descending ? -order : order;
        })
      : rows;
    tbody.replaceChildren(
      ...sorted.slice(0, limit).map((row) =>
        el("tr", {}, ...columns.map((c) => el("td", c.numeric ? { class: "num" } : {}, c.format ? c.format(row[c.key], row) : String(row[c.key] ?? "–")))),
      ),
    );
  };
  const head = el(
    "tr",
    {},
    ...columns.map((c) => {
      const th = el("th", c.numeric ? { class: "num", scope: "col" } : { scope: "col" }, c.label);
      th.addEventListener("click", () => {
        descending = sortKey === c.key ? !descending : true;
        sortKey = c.key;
        render();
      });
      return th;
    }),
  );
  render();
  return el("div", { class: "table-wrap" }, el("table", { class: "data" }, el("thead", {}, head), tbody));
}

export function tableView(rows: Row[], columns: Column[], label = "Table view"): HTMLElement {
  return el("details", {}, el("summary", {}, label), table(rows, columns));
}

export function segmented(options: [string, string][], selected: string, onChange: (value: string) => void): HTMLElement {
  const root = el("div", { class: "segmented", role: "group" });
  for (const [value, label] of options) {
    const button = el("button", { type: "button", "aria-pressed": String(value === selected) }, label);
    button.addEventListener("click", () => {
      for (const other of root.querySelectorAll("button")) other.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      onChange(value);
    });
    root.append(button);
  }
  return root;
}

/** Sum a numeric column over rows grouped by a key. */
export function sumBy(rows: Row[], key: (row: Row) => string, value: (row: Row) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) out.set(key(row), (out.get(key(row)) ?? 0) + value(row));
  return out;
}

/** The error kinds, in their fixed color order: a kind keeps its color whatever the facet. */
export const ERROR_KINDS = ["input_schema", "domain", "tool_result", "exception", "refused by PLexus", "other"] as const;
export const ERROR_LABELS: Record<string, string> = {
  input_schema: "input schema",
  domain: "domain",
  tool_result: "tool result",
  exception: "exception",
  "refused by PLexus": "refused by PLexus",
  other: "other",
};
export function errorKind(kind: string | null | undefined): string {
  return kind && (ERROR_KINDS as readonly string[]).includes(kind) ? kind : "other";
}
export function errorColor(kind: string): string {
  return series()[ERROR_KINDS.indexOf(errorKind(kind) as (typeof ERROR_KINDS)[number])];
}
