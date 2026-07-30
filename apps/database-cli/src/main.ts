import { runCheck, runProvision, type CommandResult } from "./commands.js";
import { TargetError } from "./target.js";

const USAGE = `uap-db — prepare and inspect the gateway's database

Usage:
  uap-db provision [options]   Create the schema. Safe to rerun.
  uap-db check     [options]   Report what is there. Changes nothing.

Options:
  --url <string>    Postgres connection string  (env GATEWAY_DATABASE_URL)
  --file <path>     SQLite file instead         (env GATEWAY_DATABASE_FILE)
  --schema <name>   Postgres schema to own the tables
                                                (env GATEWAY_DATABASE_SCHEMA)
  --json            Machine-readable output
  --help

The same variables the gateway reads, so a database prepared here is the one
it will use.
`;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || argv.includes("--help") || command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  const options = {
    url: flag(argv, "url"),
    file: flag(argv, "file"),
    schema: flag(argv, "schema"),
    json: argv.includes("--json"),
  };

  let result: CommandResult;
  switch (command) {
    case "provision":
      result = await runProvision(options, process.env);
      break;
    case "check":
      result = await runCheck(options, process.env);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exit(2);
  }

  process.stdout.write(
    options.json ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.text}\n`,
  );
  process.exit(result.exitCode);
}

void main().catch((error: unknown) => {
  // A missing database or a refused connection is an operator's mistake to
  // correct, not a defect to read a stack trace about.
  if (error instanceof TargetError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`Could not reach the database: ${(error as Error).message}\n`);
  process.exit(1);
});
