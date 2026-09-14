// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
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
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
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
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
  eslintConfigPrettier,
);
