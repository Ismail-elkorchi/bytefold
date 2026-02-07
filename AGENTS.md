---
role: policy
audience: agent
source_of_truth: AGENTS.md
update_triggers:
  - scripts or verification command changes
  - new archive formats or compression codecs
  - dependency policy changes
---

# AGENTS

## Obey
1. Run `npm run check` before declaring work done and report pass/fail.
2. Keep runtime dependencies at 0; do not add WASM, native addons, or external tools.
3. Default entrypoints MUST NOT import `node:*` at module-evaluation time.
4. Maintain cross-runtime behavior (Node >= 24, Deno, Bun) and deterministic, offline tests.
5. Every behavior guarantee must be captured as a SPEC.md invariant with test references.
6. Preserve strict TypeScript settings; do not weaken them.

## Do-not-obey
1. Do not add runtime deps or networked tests.
2. Do not weaken error codes, schema versions, or report shapes without migration guidance.
3. Do not mutate any `Uint8Array` after it has been enqueued to a `ReadableStream`.
4. Do not introduce format-specific logic outside the designated modules.

## Definition of Done
1. `npm run check`
2. SPEC.md updated for new guarantees and linked to tests.

## Change grammar
1. New compression algorithm: update `src/compress/types.ts`, `src/compression/streams.ts`, codec registry, tests under `test/`, SPEC.md, and `repo.manifest.yaml`.
2. New archive format: update `src/archive/**`, `src/archive/types.ts`, tests under `test/`, SPEC.md, and README.md.
3. New XZ filter/check support: update `src/compression/xz.ts` and `test/xz-utils-conformance.test.ts`.
4. New docs: add frontmatter and link to tests; avoid duplicate docs.

## Forbidden patterns
1. Importing `node:*` in default entrypoints at module evaluation.
2. Runtime dependencies, wasm, native addons, or shelling out to external tools.
3. Buffer aliasing: enqueued chunks later mutated by reused buffers.
4. Tests that access the network or rely on non-deterministic data.

## Dependency policy
1. Runtime deps are forbidden.
2. Dev deps require a written justification in CONTRIBUTING.md and a CHANGELOG entry.

## Migration policy
1. For V1+, breaking changes require a codemod or migration script and an entry in MIGRATIONS.md.
