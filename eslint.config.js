// ESLint flat config (ESLint 10 + "type": "module").
//
// Severity philosophy: this is a large (~73 KLOC) pre-existing codebase that has
// never been linted. To avoid CI exploding with thousands of errors on untouched
// legacy code, rules that flag widespread legacy patterns are set to "warn" (or
// "off"), not "error". `eslint .` therefore exits 0 (warnings do not fail the
// process) while still surfacing real issues (empty catch blocks, unused vars).
//
// Maintainer note: run `npm run lint` once after install to confirm severities,
// then tighten to "error" incrementally as the codebase is cleaned up. Type-aware
// rules (e.g. @typescript-eslint/no-floating-promises) are intentionally NOT
// enabled because that requires the slower type-checked config + projectService.
//
// The react-hooks / react-refresh v7 `configs.recommended` objects declare their
// `plugins` key in the legacy (array/string) shape that ESLint 10 flat config
// rejects, so we register the plugin objects ourselves and apply only their
// `rules` — the migration-guide-recommended approach.

import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  // Ignore build output, generated artifacts, data dirs, and tests.
  // Note: ESLint 9+ ignores .eslintignore — ignores MUST live here.
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "web/dist/**",
      "data/**", // runtime data, incl. generated-apps/published-apps copies
      ".claude/**", // agent worktrees: full repo copies (~17k generated TS files)
      ".design-bundle/**",
      "exports/**",
      "coverage/**",
      "tmp/**",
      "public/**",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
  },

  // Base recommended rule set (non type-checked: fast, no project resolution).
  ...tseslint.configs.recommended,

  // Shared rule tuning for all linted TS/TSX/MJS source.
  {
    files: ["src/**/*.ts", "web/src/**/*.{ts,tsx}", "scripts/**/*.mjs"],
    rules: {
      // Legacy-pattern relaxations (would otherwise produce thousands of errors):
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "no-empty-function": "off",
      "@typescript-eslint/no-empty-function": "off",

      // Real-bug catchers kept on, as warnings to keep CI green initially:
      "no-empty": ["warn", { allowEmptyCatch: false }], // catches empty catch blocks
      "no-unused-vars": "off", // disabled in favor of the TS-aware version below
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Node source: server, jobs, CLIs, and .mjs scripts.
  {
    files: ["src/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:vm",
              message:
                "PacketAgent forbids node:vm as an untrusted-code boundary; use the isolated sandbox service.",
            },
            {
              name: "vm",
              message:
                "PacketAgent forbids node:vm as an untrusted-code boundary; use the isolated sandbox service.",
            },
          ],
        },
      ],
      "no-restricted-modules": [
        "error",
        {
          name: "node:vm",
          message:
            "PacketAgent forbids node:vm as an untrusted-code boundary; use the isolated sandbox service.",
        },
        {
          name: "vm",
          message:
            "PacketAgent forbids node:vm as an untrusted-code boundary; use the isolated sandbox service.",
        },
      ],
    },
  },

  // React frontend: browser globals + react-hooks/react-refresh rules.
  // Plugins are registered explicitly (flat-config object form) and we apply the
  // upstream recommended rule set, then relax react-refresh to a warning.
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...reactRefresh.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // react-hooks v7 ships several new strict rules that default to "error" and
      // flag real-but-legacy patterns across this existing UI. Keep them visible
      // as warnings so CI stays green until they can be addressed incrementally.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
