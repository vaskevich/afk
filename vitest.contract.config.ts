import { defineConfig } from "vitest/config";

/**
 * The tests that spawn real processes against a real socket: the client/server contract
 * test and the installer test. `pnpm test:contract`; kept out of `pnpm test` for speed.
 */
export default defineConfig({
  test: {
    include: ["cli/contract.test.ts", "cli/install.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
