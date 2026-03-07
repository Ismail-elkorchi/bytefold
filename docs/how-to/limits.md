# How-to: choose a profile and configure resource limits

## Goal
Choose the right profile first, then add explicit size/count limits so archive
handling stays bounded for untrusted inputs.

## Prerequisites
- Node `>=24`
- `npm install`
- `npm run build`

## Copy/paste
```sh
node examples/choose-profile-and-limits.mjs
```

Equivalent API pattern:

```ts
import { openArchive } from "@ismail-elkorchi/bytefold";

const reader = await openArchive(input, {
  profile: "strict",
  limits: {
    maxUncompressedEntryBytes: 64 * 1024 * 1024,
    maxTotalUncompressedBytes: 512 * 1024 * 1024,
  },
});

const report = await reader.audit({ profile: "strict" });
console.log(JSON.stringify({
  ok: report.ok,
  issues: report.issues.map(({ code, severity }) => ({ code, severity })),
}, null, 2));
```

## Expected output or shape
- Example output contains a passing configuration plus either a failing audit
  report or a typed open/read error with a stable code.
- Tight limits can fail early during `openArchive()` when the parser can prove
  the archive already exceeds the configured ceiling.

## Common failure modes
- `profile` is treated as a full substitute for explicit limits.
- `compat` is used for untrusted internet-facing input where `strict` or
  `agent` should be the baseline.
- Per-entry limits are set but total decompressed/input ceilings are forgotten.
- Limit failures are expected only from `audit()` even though some readers can
  reject the archive earlier during open/init.

## Related reference
- [Reader and writer options](../reference/options.md)
- [Runtime compatibility](../reference/compat.md)
- [Error codes](../reference/errors.md)
