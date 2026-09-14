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
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      // Use async/await instead of promise chaining. `strict: true` also flags
      // `.then()`/`.catch()`/`.finally()` calls that are themselves awaited
      // (e.g. `await x.catch(() => null)`), which should be a try/catch instead.
      "promise/prefer-await-to-then": ["error", { strict: true }],
    },
  },
  eslintConfigPrettier,
);
