import { readFileSync } from "node:fs";

import pg from "pg";

import type { SqlDriver, SqlRow } from "./driver.js";
import type { SqlValue } from "./mapper.js";

const { Pool, types } = pg;

// int8 arrives as a string, because Postgres allows values a double cannot
// hold. Every int8 here is a millisecond timestamp or a small counter, both far
// below 2^53, and the mappers expect numbers as SQLite hands them over.
types.setTypeParser(types.builtins.INT8, Number);

export interface PostgresDriverOptions {
  connectionString: string;
  /**
   * Schema to own the tables, created if absent. Worth setting: hosted
   * Postgres often publishes `public` through a REST layer, and these tables
   * hold credentials that should not be one misconfigured grant from the
   * internet.
   */
  schema?: string;
  /** Caps concurrent connections; managed Postgres plans are usually stingy. */
  maxConnections?: number;
}

/**
 * Schema names cannot be parameterised, so they are interpolated, so they are
 * checked. Anything outside this shape would need quoting to be safe and
 * nothing here needs quoting.
 */
function assertIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(name)) {
    throw new Error(`Unsafe Postgres schema name: ${name}`);
  }
  return name;
}

/**
 * Rewrites `?` placeholders into `$1, $2, ...`.
 *
 * Safe only because no statement in this package puts a `?` inside a string
 * literal. Keep it that way: a driver is the wrong place to start parsing SQL.
 */
export function toDollarPlaceholders(sql: string): string {
  let index = 0;
  return sql.replaceAll("?", () => `$${++index}`);
}

/**
 * Reads TLS intent from the connection string the way libpq defines it, and
 * then removes the parameters that carried it.
 *
 * The removal is the point. node-postgres parses these itself, currently reads
 * `require` as the far stricter `verify-full`, lets what it parsed win over an
 * explicit setting, and has announced that this will change again. Deciding
 * here and handing onward a URL that says nothing about TLS leaves one place
 * that determines what happens, whichever version is installed.
 *
 * `require` encrypts without establishing who is on the other end, which is
 * what hosted Postgres behind a private CA offers. Authenticating the server
 * needs `verify-full` and a CA to check it against, via `sslrootcert`.
 */
export function tlsFor(connectionString: string): {
  connectionString: string;
  ssl: pg.PoolConfig["ssl"];
} {
  const url = new URL(connectionString);
  const mode = url.searchParams.get("sslmode");
  const rootCert = url.searchParams.get("sslrootcert");
  url.searchParams.delete("sslmode");
  url.searchParams.delete("sslrootcert");
  const stripped = url.toString();
  const ca = rootCert ? { ca: readFileSync(rootCert, "utf8") } : {};

  switch (mode) {
    case "verify-ca":
    case "verify-full":
      return { connectionString: stripped, ssl: { rejectUnauthorized: true, ...ca } };
    case "allow":
    case "prefer":
    case "require":
      return { connectionString: stripped, ssl: { rejectUnauthorized: false, ...ca } };
    case "disable":
    case null:
      // Absent means off, as it does for node-postgres itself. Encryption to a
      // database holding credentials is worth asking for on purpose.
      return { connectionString: stripped, ssl: false };
    default:
      throw new Error(`Unknown sslmode: ${mode}`);
  }
}

export class PostgresDriver implements SqlDriver {
  private readonly pool: pg.Pool;
  private readonly schema: string | null;

  constructor(options: PostgresDriverOptions) {
    this.schema = options.schema ? assertIdentifier(options.schema) : null;
    this.pool = new Pool({
      ...tlsFor(options.connectionString),
      max: options.maxConnections ?? 10,
      // A startup parameter rather than a SET on connect, because the pool
      // opens connections whenever it likes and a statement that reached one
      // before the SET did would quietly resolve against the wrong schema.
      ...(this.schema ? { options: `-c search_path=${this.schema}` } : {}),
    });
    // A pooled connection dropped while idle is routine with managed Postgres,
    // and the default reaction to an error on it is to crash the process.
    this.pool.on("error", () => undefined);
  }

  async init(ddl: string): Promise<void> {
    // Ordering is safe: search_path is resolved per statement, so connections
    // opened while the schema was still missing pick it up once it exists.
    if (this.schema) {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    }
    await this.pool.query(ddl);
  }

  async all(sql: string, params: SqlValue[]): Promise<SqlRow[]> {
    const result = await this.pool.query(toDollarPlaceholders(sql), params);
    return result.rows as SqlRow[];
  }

  async run(sql: string, params: SqlValue[]): Promise<number> {
    const result = await this.pool.query(toDollarPlaceholders(sql), params);
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
