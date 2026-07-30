import { inspect, provision, type DatabaseReport } from "./inspect.js";
import { resolveTarget, type TargetOptions } from "./target.js";

export interface CommandResult {
  /** What a human reads. */
  text: string;
  /** What a script reads, under --json. */
  data: Record<string, unknown>;
  exitCode: number;
}

export interface CommandOptions extends TargetOptions {
  json?: boolean | undefined;
}

/** Creates the schema if it is absent, then reports what is there. */
export async function runProvision(
  options: CommandOptions,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const target = resolveTarget(options, env);
  const driver = target.open();
  try {
    const before = await inspect(driver);
    await provision(driver);
    const after = await inspect(driver);
    const created = before.missing.filter((name) => !after.missing.includes(name));

    const lines = [
      header(target.kind, target.description, target.schema),
      "",
      created.length === 0
        ? `Schema already present. ${after.tables.length} tables, nothing to do.`
        : `Created ${created.length} table(s): ${created.join(", ")}`,
    ];
    if (!after.complete) {
      lines.push("", `Still missing after provisioning: ${after.missing.join(", ")}`);
    }
    return {
      text: lines.join("\n"),
      data: {
        backend: target.kind,
        schema: target.schema,
        created,
        complete: after.complete,
        missing: after.missing,
      },
      exitCode: after.complete ? 0 : 1,
    };
  } finally {
    await driver.close();
  }
}

/** Reports what is there, and changes nothing. */
export async function runCheck(
  options: CommandOptions,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const target = resolveTarget(options, env);
  const driver = target.open();
  try {
    const report = await inspect(driver);
    return {
      text: [
        header(target.kind, target.description, target.schema),
        "",
        ...tableLines(report),
        "",
        report.complete
          ? `${report.tables.length} tables, all present.`
          : `Missing ${report.missing.length} of ${report.tables.length} tables. ` +
            `Run \`uap-db provision\`.`,
      ].join("\n"),
      data: {
        backend: target.kind,
        schema: target.schema,
        complete: report.complete,
        missing: report.missing,
        tables: Object.fromEntries(report.tables.map((t) => [t.name, t.rows])),
      },
      exitCode: report.complete ? 0 : 1,
    };
  } finally {
    await driver.close();
  }
}

function header(kind: string, description: string, schema: string | null): string {
  const lines = [`${kind === "postgres" ? "Postgres" : "SQLite"}  ${description}`];
  if (schema) lines.push(`Schema    ${schema}`);
  return lines.join("\n");
}

function tableLines(report: DatabaseReport): string[] {
  const width = Math.max(...report.tables.map((table) => table.name.length));
  return report.tables.map(
    (table) =>
      `  ${table.name.padEnd(width)}  ${table.rows === null ? "missing" : String(table.rows)}`,
  );
}
