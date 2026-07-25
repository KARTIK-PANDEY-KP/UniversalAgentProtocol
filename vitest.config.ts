import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@umg/core": pkg("core"),
      "@umg/observability": pkg("observability"),
      "@umg/security": pkg("security"),
      "@umg/storage": pkg("storage"),
      "@umg/oauth": pkg("oauth"),
      "@umg/mcp-client": pkg("mcp-client"),
      "@umg/mcp-server": pkg("mcp-server"),
      "@umg/federation": pkg("federation"),
      "@umg/gateway": pkg("gateway"),
      "@umg/migration-cli": fileURLToPath(
        new URL("./apps/migration-cli/src/index.ts", import.meta.url),
      ),
      "@umg/conformance": fileURLToPath(
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
