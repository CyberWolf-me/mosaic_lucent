// @ts-check
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Repo-wide lint policy (ESLint 9 flat config).
 *
 * Two tiers on purpose:
 *
 *  - Every TS/JS file gets the syntactic tier (`recommended`), which needs no
 *    type information and therefore no tsconfig membership. Tests and scripts
 *    live here because `packages/*\/tsconfig.json` only includes `src/**`.
 *  - `packages/*\/src/**` additionally gets the small set of type-aware rules
 *    that catch the bug class this codebase has actually shipped: a promise
 *    left unawaited on a `void`-called path, an async function passed where a
 *    sync callback is expected. Those require the type checker, which
 *    `projectService` supplies from each package's own tsconfig.
 *
 * The rest of `strictTypeChecked` is deliberately not enabled: it would drown
 * a working codebase in `no-unsafe-*` findings around JSON boundaries without
 * changing runtime behaviour. Rules get ratcheted up, not declared aspirationally.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "packages/server/migrations/meta/**",
      "reference/**",
      // Agent scratch (ad-hoc scripts, browser test profiles): never
      // product code, never reviewed — linting it drowned the gate in
      // thousands of findings from a vendored browser extension dump.
      ".zcode/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Shared language options. Node globals everywhere; browser globals are
    // added for the web package below.
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off",
      "no-implicit-coercion": "error",
      "no-param-reassign": "error",
      "no-var": "error",
      "object-shorthand": ["error", "properties"],
      "prefer-const": "error",
      // `prefer: "type-imports"` is load-bearing: tsconfig.base.json:19 sets
      // `verbatimModuleSyntax`, so a plain `import { T }` used only as a type is
      // emitted into the JS and fails at runtime against a type-only export.
      //
      // `disallowTypeAnnotations` (on by default) is the unrelated half: it also
      // forbids `import("x").T` written inline in a type position. That is pure
      // style, and the codebase disagrees with it in 30 places across five
      // packages - `z.ZodType<import("./model.js").WireframeElement>` at
      // packages/core/src/operations.ts:54 is representative: a type named once,
      // which the rule would have us hoist into a top-level import purely to
      // name it. An inline `import()` type is inherently type-only and always
      // erased, so it cannot cause the failure the other half prevents. Off.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
          disallowTypeAnnotations: false,
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // The codebase uses `!` deliberately with noUncheckedIndexedAccess.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Type-aware tier: source only, so every file here is in a tsconfig project.
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      // `require-await` is deliberately absent. It fires 107 times, and every one
      // of them is the two-implementation store pattern that ADR 0006 ("Postgres
      // is optional") requires: each store interface returns Promises so the
      // Postgres implementation can await its queries, and the in-memory sibling
      // then satisfies the same signature without an await in its body.
      // packages/server/src/sessions.ts is the plain case - `revoke` at :99
      // (in-memory, a Map write) and at :190 (Postgres, an UPDATE) are the same
      // declaration twice, and only the second one awaits. Obeying the rule would
      // mean either dropping `async` and hand-wrapping every return in
      // `Promise.resolve` - noisier code, identical semantics - or making the
      // interface synchronous, which the Postgres half cannot implement.
      //
      // The rules that catch real async defects are on above and stay on:
      // `no-floating-promises` (a promise dropped on a void-called path),
      // `await-thenable` (awaiting a non-promise, i.e. a missing `async`) and
      // `no-misused-promises`. `require-await` only ever reports the shape of a
      // declaration, never a behaviour, which is why it is the one that goes.
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
    },
  },
  {
    files: ["packages/web/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["packages/*/test/**/*.ts", "packages/*/test/**/*.tsx", "**/*.config.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.js", "*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
