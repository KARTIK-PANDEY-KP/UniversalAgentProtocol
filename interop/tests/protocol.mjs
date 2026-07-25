// Drives the gateway with the official MCP SDK client. Anything this script
// trips over is a real interop bug, because the client is the reference one
// that Claude Desktop, Cursor and the Inspector are built on.
import { check, connect, report } from "../lib/harness.mjs";

const notifications = [];
let client;

await check("connect and initialize", async () => {
  client = await connect({
    name: "official-sdk-client",
    capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
    onNotification: (notification) => notifications.push(notification),
  });
  const info = client.getServerVersion();
  const caps = client.getServerCapabilities();
  return `server=${info?.name}@${info?.version} caps=${Object.keys(caps ?? {}).join(",")}`;
});

await check("ping", async () => {
  await client.ping();
  return "pong";
});

let toolNames = [];
await check("tools/list", async () => {
  const { tools } = await client.listTools();
  toolNames = tools.map((t) => t.name);
  return `${tools.length} tools: ${toolNames.join(", ")}`;
});

await check("tools/list pagination cursor is honoured", async () => {
  const first = await client.listTools({});
  if (!first.nextCursor) return "single page (no cursor)";
  const second = await client.listTools({ cursor: first.nextCursor });
  return `page1=${first.tools.length} page2=${second.tools.length}`;
});

await check("tools/call echo", async () => {
  const out = await client.callTool({
    name: "ref.echo",
    arguments: { message: "hello from the reference client" },
  });
  const text = out.content?.[0]?.text ?? "";
  if (!text.includes("hello from the reference client")) throw new Error(`unexpected: ${text}`);
  return text;
});

await check("tools/call add returns a computed value", async () => {
  const out = await client.callTool({ name: "ref.add", arguments: { a: 2, b: 40 } });
  const text = out.content?.[0]?.text ?? "";
  if (text.trim() !== "42") throw new Error(`expected 42, got ${text}`);
  return text;
});

// The spec files schema violations under protocol errors, so a JSON-RPC error
// with InvalidParams is the conformant answer, not an isError result.
await check("tools/call rejects arguments that violate the schema", async () => {
  try {
    const out = await client.callTool({ name: "ref.add", arguments: { a: "not a number", b: 1 } });
    if (!out.isError) throw new Error("gateway accepted a bad argument type");
    return "refused as isError";
  } catch (error) {
    if (error.code !== -32602) throw new Error(`expected -32602, got ${error.code}`);
    return `refused with InvalidParams: ${error.message.slice(0, 60)}`;
  }
});

await check("tools/call surfaces an upstream failure as isError", async () => {
  const out = await client.callTool({ name: "ref.boom", arguments: {} });
  if (!out.isError) throw new Error("upstream failure was not reported as an error");
  return (out.content?.[0]?.text ?? "").slice(0, 80);
});

await check("tools/call unknown tool is refused", async () => {
  try {
    const out = await client.callTool({ name: "ref.does_not_exist", arguments: {} });
    if (!out.isError) throw new Error("unknown tool was not refused");
    return "refused as isError";
  } catch (error) {
    return `refused as protocol error: ${error.message.slice(0, 60)}`;
  }
});

await check("progress notifications reach the client", async () => {
  const seen = [];
  const out = await client.callTool(
    { name: "ref.slow", arguments: { steps: 3 } },
    undefined,
    { onprogress: (p) => seen.push(p.progress) },
  );
  if (seen.length === 0) throw new Error("no progress notifications arrived");
  return `progress=${seen.join(",")} result=${out.content?.[0]?.text}`;
});

await check("resources/list", async () => {
  const { resources } = await client.listResources();
  return `${resources.length}: ${resources.map((r) => r.uri).join(", ")}`;
});

await check("resources/read", async () => {
  const { resources } = await client.listResources();
  if (resources.length === 0) throw new Error("nothing to read");
  const out = await client.readResource({ uri: resources[0].uri });
  return (out.contents?.[0]?.text ?? "").slice(0, 60);
});

await check("prompts/list", async () => {
  const { prompts } = await client.listPrompts();
  return `${prompts.length}: ${prompts.map((p) => p.name).join(", ")}`;
});

await check("prompts/get", async () => {
  const { prompts } = await client.listPrompts();
  const named = prompts.find((p) => p.name.endsWith("greet"));
  if (!named) throw new Error("greet prompt was not federated");
  const out = await client.getPrompt({ name: named.name, arguments: { name: "Ada" } });
  return out.messages?.[0]?.content?.text ?? "";
});

await check("logging/setLevel", async () => {
  await client.setLoggingLevel("debug");
  return "accepted";
});

await check("a live public upstream answers through the gateway", async () => {
  if (!toolNames.some((n) => n.startsWith("deepwiki."))) return "deepwiki not attached, skipped";
  const out = await client.callTool({
    name: "deepwiki.read_wiki_structure",
    arguments: { repoName: "modelcontextprotocol/typescript-sdk" },
  });
  const text = out.content?.[0]?.text ?? "";
  if (text.length < 50) throw new Error(`suspiciously short: ${text}`);
  return `${text.length} chars from the live server`;
});

await check("clean shutdown terminates the session", async () => {
  await client.close();
  return "closed";
});

if (notifications.length > 0) {
  process.stdout.write(`notifications seen: ${notifications.map((n) => n.method).join(", ")}\n`);
}
report();
