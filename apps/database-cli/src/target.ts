import {
  PostgresDriver,
  SqliteDriver,
  redactConnectionString,
  type SqlDriver,
} from "@uap/storage";

/**
 * Which database to act on, in the same terms the gateway itself reads. The
 * point of this command is to prepare the database a gateway will later use,
 * so the two must resolve a connection identically or the command prepares
 * somewhere the gateway never looks.
 */
export interface Target {
  kind: "postgres" | "sqlite";
  /** Safe to print: a Postgres URL with the password taken out. */
  description: string;
  schema: string | null;
  open(): SqlDriver;
}

export interface TargetOptions {
  url?: string | undefined;
  file?: string | undefined;
  schema?: string | undefined;
}

export class TargetError extends Error {}

/**
 * A URL wins over a file, which is the precedence the gateway applies, and an
 * in-memory database is refused outright: preparing one would succeed, report
 * seventeen tables, and vanish when the process ended.
 */
export function resolveTarget(
  options: TargetOptions,
  env: NodeJS.ProcessEnv,
): Target {
  const url = options.url ?? env["GATEWAY_DATABASE_URL"];
  const schema = options.schema ?? env["GATEWAY_DATABASE_SCHEMA"] ?? null;

  if (url) {
    return {
      kind: "postgres",
      description: redactConnectionString(url),
      schema,
      open: () =>
        new PostgresDriver({
          connectionString: url,
          ...(schema ? { schema } : {}),
        }),
    };
  }

  const file = options.file ?? env["GATEWAY_DATABASE_FILE"];
  if (!file) {
    throw new TargetError(
      "No database given. Pass --url <postgres-connection-string>, or set " +
        "GATEWAY_DATABASE_URL, or pass --file <path> for SQLite.",
    );
  }
  if (file === ":memory:") {
    throw new TargetError(
      "An in-memory database cannot be prepared: it would exist only for the " +
        "length of this command. Give a file path or a Postgres URL.",
    );
  }
  return {
    kind: "sqlite",
    description: file,
    schema: null,
    open: () => new SqliteDriver({ filename: file }),
  };
}

export { redactConnectionString } from "@uap/storage";
