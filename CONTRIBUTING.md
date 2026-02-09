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

## Branch protection policy (GitHub)
- `main` is PR-only: direct pushes should be disabled after bootstrap.
- Required checks:
  - `CI / Linux check`
  - `CI / macOS smoke`
  - `CI / Windows smoke`
- Dismiss stale approvals when new commits are pushed.
- Block force-push and branch deletion on `main`.
- Prefer linear history (enable "Require linear history" when it does not conflict with release automation).

### Manual setup (if ruleset API is unavailable)
1. Open `Settings` -> `Rules` -> `Rulesets` -> `New ruleset`.
2. Target `Default branch` (`main`) and enforce on `pull request`.
3. Require a pull request before merging.
4. Require status checks and add the three CI checks listed above.
5. Enable "Block force pushes" and "Do not allow bypassing the above settings".
6. Optionally enable "Require linear history".

## Change expectations
- Add tests for every bug fix and new guarantee.
- Update SPEC.md invariants and link tests for each guarantee.
- Update repo.manifest.yaml when commands or invariants change.
- Follow naming rules in `docs/NAMING.md` for new/renamed symbols.

## Dev dependency policy (justification required)
- Dev-only dependencies are allowed only when they improve correctness, determinism, or safety and are wired into verification.
- Current approved dev-only tooling:
  - `esbuild`: browser bundle verification for `npm run web:check` to prove the web entrypoint does not pull `node:*` builtins.
  - `@playwright/test`: real Chromium smoke proofs for the web entrypoint (`npm run test:browser`) covering Blob roundtrips, writer roundtrips, and adversarial URL budget cancellation in a browser runtime.
