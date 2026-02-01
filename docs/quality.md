# Quality practices

## Lint philosophy

- Correctness-first, low-noise: focus on bugs, not style churn.
- Type-aware rules are enabled for TypeScript sources.
- Lint suppressions are allowed only with explicit justification; unused disables are errors.

## Commands

- `npm run lint` – run ESLint (zero warnings).
- `npm run lint:fix` – auto-fix safe lint issues.
- `npm run typecheck` – TypeScript typecheck for library + tests (no emit).
- `npm run check:node` – lint + typecheck + Node tests.
- `npm run check:all` – lint + typecheck + Node/Deno/Bun tests.

## Rule groups (what they protect)

- **Async safety**: `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`, `promise/no-multiple-resolved`.
- **Control flow**: `@typescript-eslint/switch-exhaustiveness-check`, `no-fallthrough`, `no-constant-condition`, `no-useless-catch`, `no-unsafe-finally`.
- **Type safety**: `@typescript-eslint/no-explicit-any`, `@typescript-eslint/await-thenable`, `@typescript-eslint/no-shadow`, `@typescript-eslint/no-unused-vars`.
- **Regex correctness**: `regexp/no-dupe-characters-class`, `regexp/no-empty-character-class`, `regexp/no-invalid-regexp`.
- **Lint hygiene**: `eslint-comments/*` (no blanket disables, require descriptions).
