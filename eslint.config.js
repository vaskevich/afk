// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import promise from "eslint-plugin-promise";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "pnpm-lock.yaml"],
  },
  // Applied before the per-file blocks below (rather than after, its more common spot)
  // because it turns `curly` off defensively, and each block turns it back on: bracing
  // has no bearing on Prettier's own formatting decisions, so we want our "on" to win.
  eslintConfigPrettier,
  {
    // TypeScript sources: packages/*/src. Type-aware rules use each package's own
    // tsconfig via projectService.
    files: ["packages/*/src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { promise },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      // Use async/await instead of promise chaining. `strict: true` also flags
      // `.then()`/`.catch()`/`.finally()` calls that are themselves awaited
      // (e.g. `await x.catch(() => null)`), which should be a try/catch instead.
      "promise/prefer-await-to-then": ["error", { strict: true }],
      // Always brace control statement bodies, even single-line ones.
      curly: ["error", "all"],
    },
  },
  {
    // Dashboard: browser globals and the React hooks rules on top of the TS rules.
    files: ["packages/web/src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
    ],
    plugins: { promise },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.browser,
    },
    rules: {
      // Use async/await instead of promise chaining. `strict: true` also flags
      // `.then()`/`.catch()`/`.finally()` calls that are themselves awaited
      // (e.g. `await x.catch(() => null)`), which should be a try/catch instead.
      "promise/prefer-await-to-then": ["error", { strict: true }],
      // Always brace control statement bodies, even single-line ones.
      curly: ["error", "all"],
    },
  },
  {
    // Scenario scripts have no file extension (see scenarios/README.md), so a glob
    // ending in "/**" or "/*" won't do: eslint treats those as "universal" patterns
    // that only take effect together with another, extension-based match. This
    // character-class form matches any non-dotfile directly under scenarios/ and
    // stays a "non-universal" pattern.
    files: ["scenarios/[!.]*"],
    ignores: ["scenarios/**/*.md"],
    extends: [js.configs.recommended],
    plugins: { promise },
    languageOptions: {
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      // Use async/await instead of promise chaining. `strict: true` also flags
      // `.then()`/`.catch()`/`.finally()` calls that are themselves awaited
      // (e.g. `await x.catch(() => null)`), which should be a try/catch instead.
      "promise/prefer-await-to-then": ["error", { strict: true }],
      // Always brace control statement bodies, even single-line ones.
      curly: ["error", "all"],
    },
  },
);
