import { DatabaseSync } from "node:sqlite";

import type { SqlDriver, SqlRow } from "./driver.js";
import type { SqlValue } from "./mapper.js";

export interface SqliteDriverOptions {
  filename?: string;
}

/**
 * `node:sqlite` is synchronous, so every method here resolves immediately. The
 * promises are for the interface's sake, not because anything waits.
 */
export class SqliteDriver implements SqlDriver {
  private readonly db: DatabaseSync;

  constructor(options: SqliteDriverOptions = {}) {
    this.db = new DatabaseSync(options.filename ?? ":memory:");
  }

  async init(ddl: string): Promise<void> {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(ddl);
  }

  async all(sql: string, params: SqlValue[]): Promise<SqlRow[]> {
    return this.db.prepare(sql).all(...params) as SqlRow[];
  }

  async run(sql: string, params: SqlValue[]): Promise<number> {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
