# How-to: audit before reading entry content

## Goal
Gate archive reads behind `audit()` + `assertSafe()` so unsafe inputs fail
before content handling.

## Prerequisites
- Node `>=24`
- `npm install`
- `npm run build`

## Copy/paste
```sh
node examples/audit-before-extract.mjs
```

Equivalent API pattern:

```ts
import { openArchive } from "@ismail-elkorchi/bytefold";

const reader = await openArchive(bytes, { profile: "agent" });
const report = await reader.audit({ profile: "agent" });
if (!report.ok) throw new Error("Audit failed");
await reader.assertSafe({ profile: "agent" });
```

## Expected output or shape
- Example output reports `"auditOk": true`.
- Entry metadata/content is processed only after safety checks pass.

## Common failure modes
- `entries()` or extraction starts before `audit()` and `assertSafe()`.
- The reader uses `profile: "compat"` for hostile input where `strict` or
  `agent` should be the baseline.
- Callers check only `report.ok` and ignore the issue details needed for policy
  decisions.

## Related reference
- [Reader and writer options](../reference/options.md)
- [Error codes](../reference/errors.md)
- [SPEC.md](../../SPEC.md)
