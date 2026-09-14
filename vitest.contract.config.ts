import { defineConfig } from "vitest/config";

/** The end-to-end contract test only: `pnpm test:contract`. Kept out of `pnpm test` for speed. */
export default defineConfig({
  test: {
    include: ["cli/contract.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
