import type { SqlValue } from "./mapper.js";

export type SqlRow = Record<string, unknown>;

/**
 * Everything the repositories need from a database, which is deliberately
 * almost nothing: the schema uses no type, function or clause that SQLite and
 * Postgres do not both understand, so one set of statements serves both and a
 * driver is only the thing that runs them.
 *
 * Statements are written with `?` placeholders. A driver whose database wants
 * another form rewrites them, so no caller has to know which one it is talking
 * to.
 */
export interface SqlDriver {
  /** Runs a statement that returns rows. */
  all(sql: string, params: SqlValue[]): Promise<SqlRow[]>;
  /** Runs a statement that does not, and answers with the rows it affected. */
  run(sql: string, params: SqlValue[]): Promise<number>;
  /** Runs the schema. Separate from the constructor because it is I/O. */
  init(ddl: string): Promise<void>;
  close(): Promise<void>;
}
