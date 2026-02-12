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

- Chromium browser smoke suite for `@ismail-elkorchi/bytefold/web` (`test/browser/web-entrypoint.pw.ts`) proving Blob ZIP roundtrip, web writer roundtrip (ZIP store-only + TAR), and adversarial URL `maxInputBytes` cancellation behavior.
- Deterministic security simulation corpus (`test/security-audit-simulation.test.ts`) covering traversal adversaries (zip/tar) and web URL scheme abuse at the adapter boundary.
- Synthetic Zip64 boundary falsifier suite (`test/zip64-boundary.test.ts`) covering EOCD sentinel/locator/record combinations and >4GiB central-directory offset mutations.
- Zip64 writer structural proof suite (`test/zip64-writer-structural.test.ts`) validating forced-ZIP64 EOCD/locator/extra-field emission and typed error handling for malformed ZIP64 locator paths.
- Deterministic property-based parser boundary suite (`test/fuzz-property-boundaries.test.ts`) for TAR octal/NUL/space numeric fields, ZIP EOCD comment mutations, gzip optional header sections, and web URL `maxInputBytes` abort behavior.
- Unicode Trojan Source safety scanner (`scripts/unicode-safety-check.mjs`) plus deterministic test coverage (`test/unicode-safety-check.test.ts`) to fail on bidi override/isolation control code points in tracked text files.

### Changed

- Web adapter URL behavior is now explicitly hardened: non-HTTPS URL inputs are rejected before fetch, and `maxInputBytes` overflow paths fail fast with bounded cancellation during full-fetch.

### Tooling / CI

- Added dev-only `@playwright/test` to run real-browser web entrypoint falsification tests via `npm run test:browser`.
- Added dev-only `fast-check` for deterministic, seed-pinned property tests integrated into `npm run test`.
- Added `npm run unicode:check` into `npm run check` to enforce Unicode directionality control hygiene with file/line/codepoint diagnostics.
- Added `.github/workflows/browser-smoke.yml` (scheduled + manual) to run Chromium, Firefox, and WebKit browser smoke without making it a required merge check yet.
- Added fixture integrity manifest enforcement (`test/fixtures/security-fixture-hashes.json`) plus `npm run fixtures:hashes:check` to fail on missing/unexpected/changed hashes for third-party and security-sensitive fixtures.
- `npm run format:check` now excludes Playwright artifact directories (`test-results/`, `playwright-report/`) so browser smoke runs do not cause false formatting failures.
- Stabilized the web URL budget property proof (`test/fuzz-property-boundaries.test.ts`) by replacing a fixed sleep with bounded close-state waiting, removing scheduler-induced flake in deterministic check runs.

## 0.5.0

### Added

- Web runtime entrypoint `@ismail-elkorchi/bytefold/web` / `./web` with explicit URL full-fetch semantics (no HTTP range sessions in web adapter).
- Blob/File archive input support (`inputKind: "blob"`) across core and runtime adapters, including seekable ZIP reads via `BlobRandomAccess`.
- Regression tests for Blob ZIP bounded-read behavior and web adapter URL behavior (`test/web-adapter.test.ts`).
- Browser bundle contract check `npm run web:check` and deterministic proof test (`test/web-check.test.ts`).
- Monthly low-noise Dependabot policy (`.github/dependabot.yml`) with grouped updates and one open PR per ecosystem.

### Changed

- Compression capabilities schema/runtime model now includes `runtime: "web"` when browser-like globals are detected.
- Support matrix contracts now include Web runtime invariants and snapshot enforcement.
- Web compression capability reporting now probes constructor acceptance per algorithm/mode (`CompressionStream` vs `DecompressionStream`) instead of roundtrip probing, so reports track the actual runtime-exposed algorithm strings.
- Windows fixture handling is byte-stable via repository-level line-ending policy (`.gitattributes`) to prevent CRLF/LF expectation drift.
- TAR octal parsing now removes regex-based truncation in security-sensitive paths while preserving legacy parse semantics through deterministic parity tests (`test/null-terminated-utf8.test.ts`).
- XZ BCJ expected-output checks now use pinned digest/size assertions instead of committed prepared ELF outputs.

### Tooling / CI

- GitHub Actions pipelines were hardened for PR-first development: SHA-pinned actions were refreshed to current majors (including CodeQL v4), least-privilege permissions were tightened, and deterministic tracked-file churn checks were enforced in CI/release workflows.
- Scorecards workflow permissions were moved from workflow-level write scopes to job-level write scopes so `publish_results: true` satisfies `ossf/scorecard-action` restrictions.
- Added GitHub-recognized `.github/SECURITY.md` with explicit supported-version and disclosure-policy links for Security Overview/Scorecards trust signals.

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
