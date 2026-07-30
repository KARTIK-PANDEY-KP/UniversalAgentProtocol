import { DDL, TABLE_NAMES, type SqlDriver } from "@uap/storage";

export interface TableReport {
  name: string;
  /** Null when the table is not there at all. */
  rows: number | null;
}

export interface DatabaseReport {
  tables: TableReport[];
  missing: string[];
  complete: boolean;
}

/**
 * Creates the schema. Every statement is `IF NOT EXISTS`, so running this
 * against a database that already has it is a no-op rather than an error —
 * which is what makes it safe to put in a deploy pipeline that reruns.
 */
export async function provision(driver: SqlDriver): Promise<void> {
  await driver.init(DDL);
}

/**
 * Asks each table for its row count. A count rather than a mere existence
 * check because the question behind running this is usually "is my data in
 * here", and an empty table answers it as clearly as a missing one.
 *
 * `information_schema` would be one query instead of seventeen, but it does
 * not exist in SQLite, and a catalogue lookup that only works on one backend
 * defeats the point of asking both the same question.
 *
 * The counts have to swallow their errors, since a missing table is the very
 * thing being looked for. So reachability is established first, on a statement
 * no schema can affect — otherwise a refused connection reports as a database
 * with no tables in it, and sends the operator to fix the wrong problem.
 */
export async function inspect(driver: SqlDriver): Promise<DatabaseReport> {
  await driver.all("SELECT 1", []);

  const tables: TableReport[] = [];
  for (const name of TABLE_NAMES) {
    try {
      const rows = await driver.all(`SELECT COUNT(*) AS n FROM ${name}`, []);
      tables.push({ name, rows: Number(rows[0]?.["n"] ?? 0) });
    } catch {
      tables.push({ name, rows: null });
    }
  }
  const missing = tables.filter((table) => table.rows === null).map((t) => t.name);
  return { tables, missing, complete: missing.length === 0 };
}
