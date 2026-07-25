import { GatewayError } from "@uap/core";

import type { SqlDriver } from "./driver.js";
import {
  fromRow,
  patchToRow,
  toRow,
  type Column,
  type Mapper,
  type SqlValue,
} from "./mapper.js";

export type Where = Record<string, SqlValue>;

function normalize(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return String(value);
}

function normalizeRow(row: Record<string, unknown>): Record<string, SqlValue> {
  const output: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(row)) output[key] = normalize(value);
  return output;
}

/**
 * Thin typed access layer over a `SqlDriver`. All repositories share it so
 * that tenant scoping and JSON encoding are expressed once.
 */
export class Table<T> {
  constructor(
    private readonly db: SqlDriver,
    private readonly table: string,
    private readonly mapper: Mapper<T>,
  ) {}

  async insert(entity: T): Promise<T> {
    const row = toRow(this.mapper, entity);
    const columns = Object.keys(row);
    const sql = `INSERT INTO ${this.table} (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")})`;
    await this.db.run(
      sql,
      columns.map((column) => row[column] ?? null),
    );
    return entity;
  }

  /**
   * Inserts, or updates the row that already holds this natural key. The
   * stored row is what comes back, and neither the surrogate `id` nor
   * `created_at` is rewritten: other tables hold the existing id as a foreign
   * key, so an upsert carrying a freshly minted id would orphan every one of
   * them, and a row created once was not created again.
   */
  async upsert(entity: T, conflictColumns: string[]): Promise<T> {
    const row = toRow(this.mapper, entity);
    const columns = Object.keys(row);
    const keys = new Set([...conflictColumns, "id", "created_at"]);
    const assignments = columns
      .filter((column) => !keys.has(column))
      .map((column) => `${column} = excluded.${column}`);
    // A row that is nothing but its key still has to be returned, and
    // `DO NOTHING` would return nothing at all.
    const updates =
      assignments.length > 0
        ? assignments.join(", ")
        : `${conflictColumns[0]} = excluded.${conflictColumns[0]}`;
    const sql =
      `INSERT INTO ${this.table} (${columns.join(", ")}) ` +
      `VALUES (${columns.map(() => "?").join(", ")}) ` +
      `ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${updates} ` +
      `RETURNING *`;
    const rows = await this.db.all(
      sql,
      columns.map((column) => row[column] ?? null),
    );
    const stored = rows[0];
    if (!stored) {
      throw new GatewayError("INTERNAL", `Upsert into ${this.table} returned no row`);
    }
    return fromRow(this.mapper, normalizeRow(stored));
  }

  async findOne(where: Where): Promise<T | null> {
    const rows = await this.findMany(where, undefined, 1);
    return rows[0] ?? null;
  }

  async findMany(where: Where = {}, orderBy?: string, limit?: number): Promise<T[]> {
    const { clause, values } = buildWhere(where);
    const sql =
      `SELECT * FROM ${this.table}${clause}` +
      (orderBy ? ` ORDER BY ${orderBy}` : "") +
      (limit === undefined ? "" : ` LIMIT ${limit}`);
    const rows = await this.db.all(sql, values);
    return rows.map((row) => fromRow(this.mapper, normalizeRow(row)));
  }

  async update(where: Where, patch: Partial<T>): Promise<number> {
    const row = patchToRow(this.mapper, patch);
    return this.updateRaw(where, row);
  }

  async updateRaw(where: Where, row: Record<string, SqlValue>): Promise<number> {
    const columns = Object.keys(row);
    if (columns.length === 0) return 0;
    const { clause, values } = buildWhere(where);
    const sql = `UPDATE ${this.table} SET ${columns
      .map((column) => `${column} = ?`)
      .join(", ")}${clause}`;
    return this.db.run(sql, [...columns.map((column) => row[column] ?? null), ...values]);
  }

  async delete(where: Where): Promise<number> {
    const { clause, values } = buildWhere(where);
    return this.db.run(`DELETE FROM ${this.table}${clause}`, values);
  }

  column(field: keyof T): string {
    const column = (this.mapper as Record<string, Column>)[field as string];
    if (!column) {
      throw new GatewayError("INTERNAL", `Unknown field ${String(field)}`);
    }
    return column.name;
  }

  encode(field: keyof T, value: unknown): SqlValue {
    const column = (this.mapper as Record<string, Column>)[field as string];
    if (!column) {
      throw new GatewayError("INTERNAL", `Unknown field ${String(field)}`);
    }
    return column.to(value);
  }
}

function buildWhere(where: Where): { clause: string; values: SqlValue[] } {
  const entries = Object.entries(where);
  if (entries.length === 0) return { clause: "", values: [] };
  const clause = entries
    .map(([column, value]) => (value === null ? `${column} IS NULL` : `${column} = ?`))
    .join(" AND ");
  const values = entries
    .filter(([, value]) => value !== null)
    .map(([, value]) => value);
  return { clause: ` WHERE ${clause}`, values };
}
