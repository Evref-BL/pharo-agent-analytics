// The report's data: one JSON file per analysis, written by `pharo-agent-analytics build`.

export type Row = Record<string, any>;
interface Table { columns: string[]; rows: unknown[][] }

export interface Meta {
  generated: string;
  calls: number;
  sessions: number;
  firstWeek: string;
  lastWeek: string;
  failed: number;
  minSessions: number;
  spans: number;
}

export interface Facet { facet: string; value: string }

const cache = new Map<string, Row[]>();

function objects(table: Table): Row[] {
  return table.rows.map((row) => Object.fromEntries(table.columns.map((column, i) => [column, row[i]])));
}

export async function load(names: string[]): Promise<void> {
  await Promise.all(
    names.map(async (name) => {
      const response = await fetch(`./data/${name}.json`);
      if (!response.ok) {
        cache.set(name, []);
        return;
      }
      const json = await response.json();
      cache.set(name, Array.isArray(json.rows) ? objects(json) : [json]);
    }),
  );
}

export function all(name: string): Row[] {
  return cache.get(name) ?? [];
}

/** The rows of one facet: all calls, or those of one host, release or environment. */
export function of(name: string, facet: Facet): Row[] {
  return all(name).filter((row) => row.facet === facet.facet && row.facet_value === facet.value);
}

export function meta(): Meta {
  return all("meta")[0] as Meta;
}
