// The hard half of MCP: requests that travel from the upstream server back to
// the client through the gateway. Sampling, elicitation, roots, progress,
// logging and resource subscriptions all cross the gateway in the awkward
// direction, and the official everything server can trigger each of them.
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { check, connect, report } from "../lib/harness.mjs";

const seen = { sampling: 0, elicitation: 0, roots: 0, logs: [], resourceUpdates: 0 };

const client = await connect({
  name: "bidirectional-probe",
  capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
  configure: (peer) => {
    peer.setRequestHandler(CreateMessageRequestSchema, async () => {
      seen.sampling += 1;
      return {
        model: "probe-model",
        role: "assistant",
        content: { type: "text", text: "sampled answer from the client" },
      };
    });

    peer.setRequestHandler(ElicitRequestSchema, async () => {
      seen.elicitation += 1;
      return { action: "accept", content: { answer: "yes" } };
    });

    peer.setRequestHandler(ListRootsRequestSchema, async () => {
      seen.roots += 1;
      return { roots: [{ uri: "file:///workspace", name: "workspace" }] };
    });

    peer.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      seen.logs.push(notification.params?.level);
    });

    peer.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
      seen.resourceUpdates += 1;
    });
  },
});

await check("server-initiated sampling reaches the client and the answer returns", async () => {
  const out = await client.callTool({
    name: "everything.trigger-sampling-request",
    arguments: { prompt: "what is 2+2?" },
  });
  if (seen.sampling === 0) throw new Error("the sampling request never arrived");
  return `${seen.sampling} request(s); upstream saw: ${(out.content?.[0]?.text ?? "").slice(0, 70)}`;
});

await check("server-initiated elicitation reaches the client", async () => {
  const out = await client.callTool({
    name: "everything.trigger-elicitation-request",
    arguments: {},
  });
  if (seen.elicitation === 0) throw new Error("the elicitation request never arrived");
  return `${seen.elicitation} request(s); upstream saw: ${(out.content?.[0]?.text ?? "").slice(0, 70)}`;
});

await check("the upstream can read the client's roots", async () => {
  const out = await client.callTool({ name: "everything.get-roots-list", arguments: {} });
  const text = out.content?.[0]?.text ?? "";
  if (seen.roots === 0) throw new Error("roots/list never reached the client");
  return `${seen.roots} request(s); upstream saw: ${text.slice(0, 80)}`;
});

await check("progress on a long running operation is relayed", async () => {
  const ticks = [];
  const out = await client.callTool(
    { name: "everything.trigger-long-running-operation", arguments: { duration: 1, steps: 4 } },
    undefined,
    { onprogress: (p) => ticks.push(p.progress) },
  );
  if (ticks.length === 0) throw new Error("no progress arrived");
  return `${ticks.length} updates, finished: ${(out.content?.[0]?.text ?? "").slice(0, 40)}`;
});

await check("structured tool output survives the crossing", async () => {
  const out = await client.callTool({
    name: "everything.get-structured-content",
    arguments: { location: "New York" },
  });
  if (!out.structuredContent) throw new Error(`no structuredContent: ${JSON.stringify(out).slice(0, 120)}`);
  return JSON.stringify(out.structuredContent).slice(0, 80);
});

await check("resource links in a tool result survive the crossing", async () => {
  const out = await client.callTool({ name: "everything.get-resource-links", arguments: { count: 2 } });
  const links = (out.content ?? []).filter((c) => c.type === "resource_link");
  if (links.length === 0) throw new Error(`no resource_link content: ${JSON.stringify(out).slice(0, 150)}`);
  return `${links.length} links, first uri ${links[0].uri}`;
});

await check("an embedded image survives the crossing", async () => {
  const out = await client.callTool({ name: "everything.get-tiny-image", arguments: {} });
  const image = (out.content ?? []).find((c) => c.type === "image");
  if (!image?.data) throw new Error("no image content came back");
  return `${image.mimeType}, ${image.data.length} base64 chars`;
});

await check("annotations on content are preserved", async () => {
  const out = await client.callTool({
    name: "everything.get-annotated-message",
    arguments: { messageType: "success" },
  });
  const annotated = (out.content ?? []).find((c) => c.annotations);
  if (!annotated) throw new Error(`no annotations: ${JSON.stringify(out).slice(0, 150)}`);
  return JSON.stringify(annotated.annotations);
});

await check("completions are routed to the upstream that owns the prompt", async () => {
  const out = await client.complete({
    ref: { type: "ref/prompt", name: "everything/completable-prompt" },
    argument: { name: "department", value: "" },
  });
  const values = out.completion?.values ?? [];
  if (values.length === 0) throw new Error("no completions returned");
  return `${values.length}: ${values.slice(0, 3).join(", ")}`;
});

await check("logging notifications flow once a level is set", async () => {
  await client.setLoggingLevel("debug");
  await client.callTool({ name: "everything.toggle-simulated-logging", arguments: { enabled: true } });
  await new Promise((r) => setTimeout(r, 1500));
  await client.callTool({ name: "everything.toggle-simulated-logging", arguments: { enabled: false } })
    .catch(() => undefined);
  if (seen.logs.length === 0) throw new Error("no log notifications arrived");
  return `${seen.logs.length} messages, levels: ${[...new Set(seen.logs)].join(", ")}`;
});

await check("resource subscription updates reach the client", async () => {
  const { resources } = await client.listResources();
  const target = resources.find((r) => r.uri.startsWith("everything+"));
  if (!target) throw new Error("no everything resource to subscribe to");
  await client.subscribeResource({ uri: target.uri });
  await client.callTool({ name: "everything.toggle-subscriber-updates", arguments: { enabled: true } });
  await new Promise((r) => setTimeout(r, 3000));
  await client.callTool({ name: "everything.toggle-subscriber-updates", arguments: { enabled: false } })
    .catch(() => undefined);
  await client.unsubscribeResource({ uri: target.uri });
  if (seen.resourceUpdates === 0) throw new Error("subscribed but never notified");
  return `${seen.resourceUpdates} updates for ${target.uri}`;
});

await client.close();
report();
