---
role: history
audience: maintainers, users
source_of_truth: CHANGELOG.md
update_triggers:
  - release cut
  - notable user-visible changes
---

# CHANGELOG

## Unreleased

### Added

- Web runtime entrypoint `@ismail-elkorchi/bytefold/web` / `./web` with explicit URL full-fetch semantics (no HTTP range sessions in web adapter).
- Blob/File archive input support (`inputKind: "blob"`) across core and runtime adapters, including seekable ZIP reads via `BlobRandomAccess`.
- Regression tests for Blob ZIP bounded-read behavior and web adapter URL behavior (`test/web-adapter.test.ts`).
- Browser bundle contract check `npm run web:check` and deterministic proof test (`test/web-check.test.ts`).

### Changed

- Compression capabilities schema/runtime model now includes `runtime: "web"` when browser-like globals are detected.
- Support matrix contracts now include Web runtime invariants and snapshot enforcement.
- Web compression capability reporting now probes constructor acceptance per algorithm/mode (`CompressionStream` vs `DecompressionStream`) instead of roundtrip probing, so reports track the actual runtime-exposed algorithm strings.
- Scorecards workflow permissions were moved from workflow-level write scopes to job-level write scopes so `publish_results: true` satisfies `ossf/scorecard-action` workflow restrictions.
- TAR octal parsing paths now decode null-terminated fields with linear byte scanning instead of regex truncation, preserving behavior while removing ReDoS-prone matching.
- XZ BCJ expected-output checks now use pinned digest/size assertions instead of committed ELF binary fixtures.

### Tooling

- Added `esbuild` as a dev-only dependency for browser bundle verification; this is verification-only and does not affect runtime dependencies.
- Added GitHub-recognized `.github/SECURITY.md` with explicit supported-version and disclosure-policy links for Scorecards/security-overview trust signals.

## 0.4.0

### Breaking changes

Error JSON `context` no longer duplicates top-level keys. The serializer now blocks these keys in `context`:

- `schemaVersion`
- `name`
- `code`
- `message`
- `hint`
- `context`
- optional top-level keys when present (`entryName`, `method`, `offset`, `algorithm`)

### Added

- `sanitizeErrorContext` utility for consistent error JSON context sanitization across subsystems.
- Regression coverage for no-shadow contracts in `test/error-json-ambiguity.test.ts`.
- Precedence proof tests in `test/option-precedence.test.ts` and mirrored smoke checks in `test/deno.smoke.ts` and `test/bun.smoke.ts`.

### Clarified

- `SPEC.md` now states deterministic precedence rules for `profile` vs `limits` and links directly to the precedence tests.

## 0.3.0

### Breaking changes

Public option fields were renamed to truth-conditional forms to reduce agent/tooling errors.

| Old field | New field |
| --- | --- |
| `strict` | `isStrict` |
| `storeEntries` | `shouldStoreEntries` |
| `deterministic` | `isDeterministic` |
| `forceZip64` | `shouldForceZip64` |
| `allowSymlinks` | `shouldAllowSymlinks` |
| `preserveComments` | `shouldPreserveComments` |
| `preserveTrailingBytes` | `shouldPreserveTrailingBytes` |
| `http.snapshot` | `http.snapshotPolicy` |
| `seekable` | `sinkSeekabilityPolicy` |

No runtime behavior changed beyond interpreting the renamed option fields.
