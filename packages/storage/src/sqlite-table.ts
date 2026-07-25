import type { DatabaseSync } from "node:sqlite";

import { GatewayError } from "@uap/core";

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
 * Thin typed access layer over `node:sqlite`. All repositories share it so
 * that tenant scoping and JSON encoding are expressed once.
 */
export class Table<T> {
  constructor(
    private readonly db: DatabaseSync,
    private readonly table: string,
    private readonly mapper: Mapper<T>,
  ) {}

  insert(entity: T): T {
    const row = toRow(this.mapper, entity);
    const columns = Object.keys(row);
    const sql = `INSERT INTO ${this.table} (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")})`;
    this.db.prepare(sql).run(...columns.map((column) => row[column] ?? null));
    return entity;
  }

  /**
   * Inserts, or updates the row that already holds this natural key. The
   * stored row is what comes back, and neither the surrogate `id` nor
   * `created_at` is rewritten: other tables hold the existing id as a foreign
   * key, so an upsert carrying a freshly minted id would orphan every one of
   * them, and a row created once was not created again.
   */
  upsert(entity: T, conflictColumns: string[]): T {
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
    const stored = this.db
      .prepare(sql)
      .get(...columns.map((column) => row[column] ?? null)) as Record<string, unknown>;
    return fromRow(this.mapper, normalizeRow(stored));
  }

  findOne(where: Where): T | null {
    const rows = this.findMany(where, undefined, 1);
    return rows[0] ?? null;
  }

  findMany(where: Where = {}, orderBy?: string, limit?: number): T[] {
    const { clause, values } = buildWhere(where);
    const sql =
      `SELECT * FROM ${this.table}${clause}` +
      (orderBy ? ` ORDER BY ${orderBy}` : "") +
      (limit === undefined ? "" : ` LIMIT ${limit}`);
    const rows = this.db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map((row) => fromRow(this.mapper, normalizeRow(row)));
  }

  update(where: Where, patch: Partial<T>): number {
    const row = patchToRow(this.mapper, patch);
    const columns = Object.keys(row);
    if (columns.length === 0) return 0;
    const { clause, values } = buildWhere(where);
    const sql = `UPDATE ${this.table} SET ${columns
      .map((column) => `${column} = ?`)
      .join(", ")}${clause}`;
    const result = this.db
      .prepare(sql)
      .run(...columns.map((column) => row[column] ?? null), ...values);
    return Number(result.changes);
  }

  updateRaw(where: Where, row: Record<string, SqlValue>): number {
    const columns = Object.keys(row);
    if (columns.length === 0) return 0;
    const { clause, values } = buildWhere(where);
    const sql = `UPDATE ${this.table} SET ${columns
      .map((column) => `${column} = ?`)
      .join(", ")}${clause}`;
    const result = this.db
      .prepare(sql)
      .run(...columns.map((column) => row[column] ?? null), ...values);
    return Number(result.changes);
  }

  delete(where: Where): number {
    const { clause, values } = buildWhere(where);
    const result = this.db.prepare(`DELETE FROM ${this.table}${clause}`).run(...values);
    return Number(result.changes);
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
