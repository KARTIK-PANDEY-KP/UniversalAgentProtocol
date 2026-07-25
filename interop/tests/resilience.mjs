// What happens when things break while in use: an upstream dies mid-session,
// it comes back, the gateway itself restarts, and a hundred calls arrive at
// once. Failures here are the ones an operator meets on an ordinary deploy.
import { check, connect, report, sleep } from "../lib/harness.mjs";
import { GATEWAY, restart, start, stop } from "../rig.mjs";

let client = await connect({ name: "resilience" });

await check("baseline call works", async () => {
  const out = await client.callTool({ name: "ref.echo", arguments: { message: "before" } });
  return out.content?.[0]?.text ?? "";
});

await check("an upstream that dies is reported, not hung", async () => {
  await stop("ref");
  const started = Date.now();
  try {
    await client.callTool({ name: "ref.echo", arguments: { message: "during outage" } });
    throw new Error("the call succeeded against a server that is down");
  } catch (error) {
    const took = Date.now() - started;
    if (took > 20_000) throw new Error(`took ${took}ms to report a dead upstream`);
    return `refused in ${took}ms: ${error.message.slice(0, 70)}`;
  }
});

await check("its neighbours are unaffected by the outage", async () => {
  const out = await client.callTool({ name: "everything.echo", arguments: { message: "ok" } });
  return out.content?.[0]?.text ?? "";
});

await check("the upstream coming back is picked up without operator action", async () => {
  await start("ref");
  // The first call after a restart rebuilds the session. A write is not
  // replayed across that boundary by design, so it may report the expiry once
  // before the connection is healthy again.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const out = await client.callTool({ name: "ref.echo", arguments: { message: "after" } });
      return `recovered after ${attempt + 1} attempt(s): ${out.content?.[0]?.text}`;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("never recovered within 20 attempts");
});

await check("the gateway restarting does not lose the catalogue or the grant", async () => {
  const before = (await client.listTools()).tools.length;
  await client.close();

  await restart("gateway");
  client = await connect({ name: "resilience" });

  const after = (await client.listTools()).tools.length;
  if (after !== before) throw new Error(`${before} tools before, ${after} after`);
  // The OAuth grant has to survive too, or every restart costs the user a trip
  // through their provider.
  const out = await client.callTool({ name: "secure.add", arguments: { a: 20, b: 22 } });
  if (out.content?.[0]?.text?.trim() !== "42") throw new Error("the stored grant did not survive");
  return `${after} tools and a working grant after restart`;
});

await check("a hundred calls in flight at once all get answered", async () => {
  const calls = Array.from({ length: 100 }, (_, index) =>
    client.callTool({ name: "everything.get-sum", arguments: { a: index, b: 1 } }),
  );
  const settled = await Promise.allSettled(calls);
  const failed = settled.filter((outcome) => outcome.status === "rejected");
  if (failed.length > 0) {
    throw new Error(`${failed.length}/100 failed: ${failed[0].reason?.message}`);
  }
  return "100/100";
});

await check("the gateway is still healthy at the end of all that", async () => {
  const health = await fetch(`${GATEWAY}/healthz`).then((response) => response.json());
  if (health.status !== "ok") throw new Error(`health reads ${JSON.stringify(health)}`);
  return "healthz ok";
});

await client.close();
report();
