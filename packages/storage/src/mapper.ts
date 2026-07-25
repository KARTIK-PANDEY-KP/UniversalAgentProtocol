export type SqlValue = string | number | null;

export interface Column {
  name: string;
  to(value: unknown): SqlValue;
  from(value: SqlValue): unknown;
}

export type Mapper<T> = { [K in keyof Required<T>]: Column };

export const text = (name: string): Column => ({
  name,
  to: (value) => (value === undefined ? null : (value as string)),
  from: (value) => value,
});

export const textNull = (name: string): Column => ({
  name,
  to: (value) => (value === undefined || value === null ? null : (value as string)),
  from: (value) => (value === undefined ? null : value),
});

export const num = (name: string): Column => ({
  name,
  to: (value) => (value === undefined || value === null ? null : Number(value)),
  from: (value) => (value === null ? null : Number(value)),
});

export const bool = (name: string): Column => ({
  name,
  to: (value) => (value ? 1 : 0),
  from: (value) => value === 1 || value === "1",
});

export const json = (name: string): Column => ({
  name,
  to: (value) =>
    value === undefined || value === null ? null : JSON.stringify(value),
  from: (value) => (value === null ? null : (JSON.parse(String(value)) as unknown)),
});

export const jsonArray = (name: string): Column => ({
  name,
  to: (value) => JSON.stringify(value ?? []),
  from: (value) => (value === null ? [] : (JSON.parse(String(value)) as unknown)),
});

export function toRow<T>(mapper: Mapper<T>, entity: T): Record<string, SqlValue> {
  const row: Record<string, SqlValue> = {};
  for (const [field, column] of Object.entries(mapper) as [string, Column][]) {
    row[column.name] = column.to((entity as Record<string, unknown>)[field]);
  }
  return row;
}

export function fromRow<T>(
  mapper: Mapper<T>,
  row: Record<string, SqlValue>,
): T {
  const entity: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(mapper) as [string, Column][]) {
    entity[field] = column.from(row[column.name] ?? null);
  }
  return entity as T;
}

export function patchToRow<T>(
  mapper: Mapper<T>,
  patch: Partial<T>,
): Record<string, SqlValue> {
  const row: Record<string, SqlValue> = {};
  for (const [field, value] of Object.entries(patch)) {
    const column = (mapper as Record<string, Column | undefined>)[field];
    if (!column || value === undefined) continue;
    row[column.name] = column.to(value);
  }
  return row;
}
