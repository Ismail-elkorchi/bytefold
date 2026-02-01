# Quality baseline (pre-sprint)

Date: 2026-02-01
Repo: @ismail-elkorchi/bytefold

## Current TypeScript compilerOptions

**tsconfig.json**
- `target: "ES2022"`, `module: "ES2022"`, `moduleResolution: "Bundler"`, `lib: ["ES2022", "DOM"]`.
- `rootDir: "src"`, `outDir: "dist"`, `declaration: true`, `declarationMap: true`, `sourceMap: true`.
- `strict: true` (enables strict type checking incl. `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, etc.).
- `noUncheckedIndexedAccess: true` (forces indexing to return `T | undefined`).
- `exactOptionalPropertyTypes: true` (distinguishes optional vs `T | undefined`).
- `useUnknownInCatchVariables: true` (catch variables are `unknown`).
- `skipLibCheck: true` (skips checking `node_modules` types).

**What this catches today**
- Most strict typing hazards (implicit any, nullability, unsafe indexing) in `src/`.
- Optional property mistakes and catch-variable widening.

**What this does *not* explicitly enforce today**
- `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `forceConsistentCasingInFileNames`, `verbatimModuleSyntax` are not explicitly set (defaults apply).
- No dedicated project for type-aware linting across `test/`, `scripts/`, runtime adapters.

**tsconfig.test.json**
- Extends `tsconfig.json`.
- Overrides: `outDir: "dist-test"`, `rootDir: "test"`, `declaration: false`, `declarationMap: false`.
- Adds `baseUrl` + `paths` to point test types at `dist/`.
- Includes only `test/`.

**What test config catches today**
- Same strictness as base for tests, but only after building `dist/` (paths point at build output).

## Current npm scripts (package.json)
- `build`: `tsc -p tsconfig.json` (builds library to `dist/`).
- `build:test`: `tsc -p tsconfig.test.json` (builds tests to `dist-test/`).
- `test`: `npm run build && npm run build:test && node --test dist-test` (Node test run on compiled tests).
- `test:node`: alias for `test`.
- `test:deno`: `npm run build && node ./scripts/run-deno.mjs` (Deno smoke tests).
- `test:bun`: `npm run build && node ./scripts/run-bun.mjs` (Bun smoke tests).
- `test:all`: runs `test:node`, `test:deno`, `test:bun`.
- `test:interop`: runs `scripts/interop.mjs`.
- `test:external-7z`: runs `scripts/external-7z.mjs`.
- `bench`: runs `scripts/bench.mjs` after build.
- `clean`: runs `scripts/clean.mjs`.

## Documented claims that are testable

From README + docs:
- **Formats & auto-detection** (`docs/formats.md`, README): `openArchive()` supports auto-detect for ZIP, TAR, GZ, TGZ, ZST, BR, TAR.ZST, TAR.BR. Detection order is format hint → filename extension → magic bytes; confidence reported as `high|medium|low` with notes; brotli requires explicit hint and should not be auto-detected.
- **Layering rules** (`docs/formats.md`): gzip/zstd payloads containing tar are exposed as `tgz` / `tar.zst`; brotli payloads only treated as tar with explicit `tar.br` hint.
- **Detection report** (`docs/agent.md`): `reader.detection` is JSON-safe and includes `inputKind`, detected layers, confidence, notes.
- **Audit + assertSafe** (`README`, `docs/security.md`, `docs/agent.md`): audit is machine-readable; `assertSafe({ profile: 'agent' })` treats any audit warning as error; path traversal and symlinks are errors under agent profile.
- **Normalization** (`docs/normalize.md`): deterministic outputs when `deterministic: true`; entries sorted by normalized name, fixed timestamps, stable headers.
- **Compression API** (`docs/compress.md`): `getCompressionCapabilities()` report is JSON-safe; `createCompressor`/`createDecompressor` support `gzip|deflate|deflate-raw|brotli|zstd`; backend selection order is deterministic; progress events are monotonic; unsupported algorithm throws `COMPRESSION_UNSUPPORTED_ALGORITHM`.
- **Runtime guarantees** (`README`, `docs/state.md`): default entrypoint is universal (no Node builtins at import), Node/Deno/Bun adapters are separate subpaths.

## BigInt usage & JSON-safety status

From `docs/state.md` and code:
- **JSON-safe**: Zip/Tar audit + normalize reports expose `toJSON()` to stringify BigInt fields; archive-level audit/normalize wraps and forwards `toJSON()` when present. Compression capabilities report contains no BigInt.
- **Not JSON-safe by default**: `ArchiveEntry.size`, `ZipEntry`/`TarEntry` size + offsets, `ArchiveError.offset`, `ZipError.offset`, raw entry payloads (`entry.raw`) may include BigInt. These should not be directly JSON-stringified without a safe adapter.
