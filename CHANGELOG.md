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
