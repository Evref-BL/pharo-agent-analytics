// The report's data: one JSON file per analysis, written by `pharo-agent-analytics build`.

export type Row = Record<string, any>;
interface Table { columns: string[]; rows: unknown[][] }

export interface Meta {
  generated: string;
  calls: number;
  sessions: number;
  first: string;
  last: string;
  failed: number;
  minSessions: number;
  spans: number;
  period: "day" | "week";
  timePrecise: boolean;
  filtered: boolean;
  content: boolean;
  /** What these spans hold beyond what every export keeps. */
  sessionTime: boolean;
  callerContext: boolean;
  hostSpans: boolean;
  tokens: boolean;
  evaluateCode: boolean;
  customFacets: string[];
}

export interface Facet { facet: string; value: string }

const cache = new Map<string, Row[]>();

function objects(table: Table): Row[] {
  return table.rows.map((row) => Object.fromEntries(table.columns.map((column, i) => [column, row[i]])));
}

export async function load(names: string[]): Promise<void> {
  await Promise.all(
    names.map(async (name) => {
      // A file a build did not write (no catalog, say) is no rows: a server may answer it with a page instead of a 404.
      let json: any = null;
      try {
        const response = await fetch(`./data/${name}.json`);
        if (response.ok) json = await response.json();
      } catch {
        json = null;
      }
      cache.set(name, json == null ? [] : Array.isArray(json.rows) ? objects(json) : [json]);
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
