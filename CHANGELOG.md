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
