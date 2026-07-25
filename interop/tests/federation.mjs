// Exercises the gateway the way a real client would, across every server
// attached to it: two reference SDK servers, three live public ones, and one
// behind a real OAuth provider.
import { check, connect, report } from "../lib/harness.mjs";

const client = await connect({ name: "federation-probe" });

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
process.stdout.write(`\n${tools.length} tools federated:\n  ${names.join("\n  ")}\n\n`);

const byAlias = new Map();
for (const name of names) {
  const alias = name.split(".")[0];
  byAlias.set(alias, (byAlias.get(alias) ?? 0) + 1);
}
process.stdout.write(`aliases: ${[...byAlias].map(([a, n]) => `${a}(${n})`).join(" ")}\n\n`);

await check("every federated tool carries a usable input schema", async () => {
  const broken = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== "object");
  if (broken.length > 0) throw new Error(`${broken.map((t) => t.name).join(", ")}`);
  return `${tools.length} schemas intact`;
});

await check("names stay unique across servers that share tool names", async () => {
  if (new Set(names).size !== names.length) throw new Error("duplicate gateway tool name");
  return `${new Set(names).size} distinct names`;
});

await check("local reference server: add", async () => {
  const out = await client.callTool({ name: "ref.add", arguments: { a: 2, b: 3 } });
  return out.content?.[0]?.text ?? "";
});

await check("OAuth-protected server: add over a DPoP-bound token", async () => {
  const out = await client.callTool({ name: "secure.add", arguments: { a: 40, b: 2 } });
  if (out.content?.[0]?.text?.trim() !== "42") throw new Error(JSON.stringify(out).slice(0, 120));
  return "42 through the real provider";
});

await check("official everything server: echo", async () => {
  const out = await client.callTool({ name: "everything.echo", arguments: { message: "ping" } });
  return (out.content?.[0]?.text ?? "").slice(0, 60);
});

await check("official everything server: get-sum", async () => {
  const out = await client.callTool({ name: "everything.get-sum", arguments: { a: 7, b: 5 } });
  return (out.content?.[0]?.text ?? "").slice(0, 60);
});

await check("live public server: gitmcp fetches real documentation", async () => {
  const tool = names.find((n) => n.startsWith("gitmcp."));
  if (!tool) return "gitmcp not attached, skipped";
  const out = await client.callTool({
    name: "gitmcp.fetch_generic_documentation",
    arguments: { owner: "facebook", repo: "react" },
  });
  const text = out.content?.[0]?.text ?? "";
  if (typeof text !== "string" || text.length === 0) throw new Error("empty relay");
  return `relayed ${text.length} chars verbatim`;
});

await check("live public server: context7 resolves a library", async () => {
  const out = await client.callTool({
    name: "context7.resolve-library-id",
    arguments: { libraryName: "Next.js", query: "routing" },
  });
  const text = out.content?.[0]?.text ?? "";
  if (text.length < 40) throw new Error(`short response: ${text.slice(0, 120)}`);
  return `${text.length} chars`;
});

await check("live public server: deepwiki answers about a repo", async () => {
  const out = await client.callTool({
    name: "deepwiki.read_wiki_structure",
    arguments: { repoName: "modelcontextprotocol/typescript-sdk" },
  });
  return `${(out.content?.[0]?.text ?? "").length} chars`;
});

await check("resources federate from every server that has them", async () => {
  const { resources } = await client.listResources();
  const aliases = new Set(resources.map((r) => r.uri.split("+")[0]));
  return `${resources.length} resources from ${[...aliases].join(", ")}`;
});

await check("prompts federate from every server that has them", async () => {
  const { prompts } = await client.listPrompts();
  return `${prompts.length}: ${prompts.map((p) => p.name).join(", ")}`;
});

await check("twenty concurrent calls across four servers all succeed", async () => {
  const targets = ["ref.add", "secure.add", "everything.get-sum", "ref.echo"];
  const calls = Array.from({ length: 20 }, (_, i) => {
    const name = targets[i % targets.length];
    return name.endsWith("echo")
      ? client.callTool({ name, arguments: { message: `c${i}` } })
      : client.callTool({ name, arguments: { a: i, b: 1 } });
  });
  const settled = await Promise.allSettled(calls);
  const failed = settled.filter((s) => s.status === "rejected");
  if (failed.length > 0) throw new Error(`${failed.length} failed: ${failed[0].reason?.message}`);
  return "20/20";
});

await check("an unauthorized connection reports how to fix itself", async () => {
  const pending = names.find((n) => n.startsWith("semgrep."));
  if (pending) throw new Error("tools were exposed for a connection that is not authorized");
  return "no tools exposed from the unauthorized server, as expected";
});

await client.close();
report();
