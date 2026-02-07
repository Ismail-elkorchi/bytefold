---
role: policy
audience: maintainers, contributors
source_of_truth: CONTRIBUTING.md
update_triggers:
  - script changes
  - new formats or codecs
  - dependency policy changes
---

# CONTRIBUTING

## Requirements
- Node >= 24, ESM-only.
- No runtime dependencies, no wasm, no native addons, no external tools.
- Deterministic, offline tests only.

## Verification
- `npm run check` (canonical one-command truth)

## Change expectations
- Add tests for every bug fix and new guarantee.
- Update SPEC.md invariants and link tests for each guarantee.
- Update repo.manifest.yaml when commands or invariants change.
