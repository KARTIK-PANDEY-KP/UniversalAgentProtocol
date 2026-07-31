import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  runCheck,
  runProvision,
  redactConnectionString,
  resolveTarget,
  TargetError,
} from "@uap/database-cli";
import { PostgresDriver, TABLE_NAMES } from "@uap/storage";

const POSTGRES_URL = process.env["TEST_POSTGRES_URL"];

const directories: string[] = [];
const schemas: string[] = [];

function tempFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "uap-db-"));
  directories.push(directory);
  return join(directory, "gateway.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("choosing a database", () => {
  it("prefers a connection string over a file, as the gateway does", () => {
    const target = resolveTarget(
      { url: "postgres://u:p@h:5432/d", file: "/tmp/x.sqlite" },
      {},
    );
    expect(target.kind).toBe("postgres");
  });

  it("reads the same variables the gateway reads", () => {
    const target = resolveTarget(
      {},
      { GATEWAY_DATABASE_URL: "postgres://u:p@h:5432/d", GATEWAY_DATABASE_SCHEMA: "uap" },
    );
    expect(target.kind).toBe("postgres");
    expect(target.schema).toBe("uap");
  });

  it("never prints the password", () => {
    const target = resolveTarget({ url: "postgres://u:hunter2@h:5432/d" }, {});
    expect(target.description).not.toContain("hunter2");
    expect(redactConnectionString("postgres://u:hunter2@h:5432/d")).toContain("***");
  });

  it("refuses an in-memory database rather than preparing one that vanishes", () => {
    expect(() => resolveTarget({ file: ":memory:" }, {})).toThrow(TargetError);
  });

  it("says what to pass when given nothing", () => {
    expect(() => resolveTarget({}, {})).toThrow(/GATEWAY_DATABASE_URL/u);
  });

  it("reports an unreachable database as unreachable, not as an empty one", async () => {
    // Counting rows has to swallow errors, because a missing table is what it
    // is looking for. Without a reachability probe first, a refused connection
    // reads as seventeen missing tables and sends the operator to `provision`.
    await expect(
      runCheck({ url: "postgres://u:p@127.0.0.1:1/none?sslmode=disable" }, {}),
    ).rejects.toThrow(/ECONNREFUSED|connect/u);
  });
});

describe.each(
  [
    { name: "sqlite", options: () => ({ file: tempFile() }) },
    ...(POSTGRES_URL
      ? [
          {
            name: "postgres",
            options: (): { url: string; schema: string } => {
              const schema = `c_${Math.random().toString(36).slice(2, 10)}`;
              schemas.push(schema);
              return { url: POSTGRES_URL, schema };
            },
          },
        ]
      : []),
  ].map((entry) => entry),
)("provisioning $name", ({ options }) => {
  it("reports an empty database as incomplete before it is prepared", async () => {
    const result = await runCheck(options(), {});
    expect(result.exitCode).toBe(1);
    expect(result.data["complete"]).toBe(false);
    expect(result.text).toMatch(/Run `uap-db provision`/u);
  });

  it("creates every table the schema defines", async () => {
    const target = options();
    const provisioned = await runProvision(target, {});
    expect(provisioned.exitCode).toBe(0);
    expect(provisioned.data["created"]).toEqual([...TABLE_NAMES]);

    const checked = await runCheck(target, {});
    expect(checked.exitCode).toBe(0);
    expect(checked.data["complete"]).toBe(true);
    expect(Object.keys(checked.data["tables"] as object)).toHaveLength(TABLE_NAMES.length);
  });

  it("does nothing the second time, so a deploy can rerun it", async () => {
    const target = options();
    await runProvision(target, {});
    const again = await runProvision(target, {});
    expect(again.data["created"]).toEqual([]);
    expect(again.text).toMatch(/already present/u);
    expect(again.exitCode).toBe(0);
  });

  it("counts rows, so an empty database is distinguishable from a full one", async () => {
    const target = options();
    await runProvision(target, {});
    const report = await runCheck(target, {});
    expect((report.data["tables"] as Record<string, number>)["tenants"]).toBe(0);
  });
});

afterAll(async () => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  // A temporary directory is cleaned up above; a schema on someone's Postgres
  // deserves the same courtesy, and there are seventeen tables in each.
  if (!POSTGRES_URL || schemas.length === 0) return;
  const driver = new PostgresDriver({ connectionString: POSTGRES_URL });
  for (const schema of schemas.splice(0)) {
    await driver.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []).catch(() => undefined);
  }
  await driver.close();
});
