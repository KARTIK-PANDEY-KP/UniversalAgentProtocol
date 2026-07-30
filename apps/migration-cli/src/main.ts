import { defaultStateDir } from "./backup.js";
import { pathContext } from "./clients.js";
import {
  EXIT_FAILED,
  EXIT_OK,
  backupsCommand,
  discoverCommand,
  importCommand,
  installCommand,
  pruneCommand,
  rollbackCommand,
  statusCommand,
  type CliContext,
  type Output,
} from "./commands.js";
import { GatewayControlPlane } from "./gateway-client.js";

const DEFAULT_ENTRY_NAME = "universal-gateway";
const DEFAULT_KEY_VARIABLE = "UAP_GATEWAY_API_KEY";

const USAGE = `uap-migrate - move existing remote MCP servers behind the Universal Agent Protocol Gateway

Usage: uap-migrate <command> [options]

Commands:
  discover    List the MCP servers configured in your applications
  import      Create one gateway connection per remote MCP server, deduplicated
  status      Show the state of every gateway connection
  install     Add the gateway to your applications' MCP configuration
  prune       Remove the direct entries the gateway now serves
  rollback    Undo the last install or prune
  backups     List the backups taken by install and prune

Options:
  --gateway <url>       Gateway base URL           (env GATEWAY_URL)
  --api-key <key>       Gateway API key            (env GATEWAY_API_KEY)
  --client <id>         Limit to one client; may be repeated
                        (cursor, claude-code, claude-desktop, codex, vscode)
  --cwd <path>          Project directory to scan  (default: current directory)
  --name <name>         Name of the gateway entry  (default: ${DEFAULT_ENTRY_NAME})
  --api-key-env <var>   Variable the clients read  (default: ${DEFAULT_KEY_VARIABLE})
  --inline-key          Write the key into the configuration instead of a reference
  --allow-http          Accept http:// MCP URLs, for local development
  --dry-run             Show what would change without writing anything
  --yes                 Apply a destructive change without confirming
  --fail-on-pending     Exit non-zero when a connection still needs authorization
  --backup-id <id>      Which backup rollback should restore
  --json                Machine readable output
  --help                Show this message

A typical migration:
  uap-migrate discover
  uap-migrate import         # then open each authorization link once
  uap-migrate status
  uap-migrate install
  uap-migrate prune --yes    # optional, after everything works
`;

interface ParsedArgs {
  command: string;
  flags: Map<string, string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  const valueless = new Set([
    "inline-key",
    "allow-http",
    "dry-run",
    "yes",
    "json",
    "help",
    "fail-on-pending",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const [rawName, inlineValue] = splitFlag(argument.slice(2));
    const value =
      inlineValue ?? (valueless.has(rawName) ? "true" : (argv[(index += 1)] ?? ""));
    flags.set(rawName, [...(flags.get(rawName) ?? []), value]);
  }
  return { command: positional[0] ?? "help", flags };
}

function splitFlag(text: string): [string, string | undefined] {
  const separator = text.indexOf("=");
  return separator === -1
    ? [text, undefined]
    : [text.slice(0, separator), text.slice(separator + 1)];
}

const stdout: Output = {
  line: (text) => process.stdout.write(`${text}\n`),
  json: (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
};

export async function run(argv: string[], env: NodeJS.ProcessEnv, out: Output): Promise<number> {
  const { command, flags } = parseArgs(argv);
  const flag = (name: string): string | undefined => flags.get(name)?.at(-1);
  const enabled = (name: string): boolean => flag(name) === "true";

  if (command === "help" || enabled("help")) {
    out.line(USAGE);
    return EXIT_OK;
  }

  const paths = pathContext({
    env,
    ...(flag("cwd") ? { cwd: flag("cwd") as string } : {}),
  });
  const context: CliContext = {
    paths,
    out,
    stateDir: defaultStateDir(env, paths.home),
    json: enabled("json"),
    allowHttp: enabled("allow-http"),
    clientIds: flags.get("client") ?? [],
    entryName: flag("name") ?? DEFAULT_ENTRY_NAME,
  };

  const gatewayUrl = flag("gateway") ?? env["GATEWAY_URL"] ?? "";
  const apiKey = flag("api-key") ?? env["GATEWAY_API_KEY"] ?? "";
  const requireGateway = (): GatewayControlPlane => {
    if (!gatewayUrl) {
      throw new Error("Set --gateway https://gateway.example.com or GATEWAY_URL");
    }
    if (!apiKey) {
      throw new Error("Set --api-key or GATEWAY_API_KEY");
    }
    return new GatewayControlPlane(gatewayUrl, apiKey);
  };

  switch (command) {
    case "discover":
      return discoverCommand(context, gatewayUrl ? `${gatewayUrl.replace(/\/+$/u, "")}/mcp` : null);
    case "import":
      return importCommand(context, requireGateway());
    case "status":
      return statusCommand(context, requireGateway(), {
        failOnPending: enabled("fail-on-pending"),
      });
    case "install": {
      const gateway = requireGateway();
      return installCommand(context, {
        gatewayMcpUrl: gateway.mcpUrl,
        entryName: context.entryName,
        apiKey,
        apiKeyEnvVar: flag("api-key-env") ?? DEFAULT_KEY_VARIABLE,
        inlineKey: enabled("inline-key"),
        dryRun: enabled("dry-run"),
        ...(context.clientIds.length > 0 ? { clientIds: context.clientIds } : {}),
      });
    }
    case "prune":
      return pruneCommand(context, requireGateway(), {
        dryRun: enabled("dry-run"),
        yes: enabled("yes"),
      });
    case "rollback":
      return rollbackCommand(context, {
        ...(flag("backup-id") ? { id: flag("backup-id") as string } : {}),
      });
    case "backups":
      return backupsCommand(context);
    default:
      out.line(`Unknown command: ${command}\n`);
      out.line(USAGE);
      return EXIT_FAILED;
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2), process.env, stdout);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = EXIT_FAILED;
  }
}

const invokedDirectly = process.argv[1]?.endsWith("main.js") ?? false;
if (invokedDirectly) void main();
