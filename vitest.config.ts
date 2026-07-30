import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@uap/core": pkg("core"),
      "@uap/observability": pkg("observability"),
      "@uap/security": pkg("security"),
      "@uap/storage": pkg("storage"),
      "@uap/oauth": pkg("oauth"),
      "@uap/mcp-client": pkg("mcp-client"),
      "@uap/mcp-server": pkg("mcp-server"),
      "@uap/federation": pkg("federation"),
      "@uap/gateway": pkg("gateway"),
      "@uap/migration-cli": fileURLToPath(
        new URL("./apps/migration-cli/src/index.ts", import.meta.url),
      ),
      "@uap/conformance": fileURLToPath(
        new URL("./conformance/harness/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "conformance/tests/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    reporters: ["default"],
  },
});
