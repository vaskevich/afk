import { defineConfig } from "vitest/config";

/**
 * One config for the whole workspace. Tests live next to the code they cover as
 * `*.test.ts` / `*.test.tsx`. The default environment is node; a test that needs a DOM
 * opts in with a `// @vitest-environment jsdom` comment at the top of the file.
 * See docs/TESTING.md.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}", "cli/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
