# How-to: audit before reading entry content

## Goal
Gate archive reads behind `audit()` + `assertSafe()` so unsafe inputs fail
before content handling.

## Prereqs
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

## What you should see
- Example output reports `"auditOk": true`.
- Entry metadata/content is processed only after safety checks pass.

## Safety notes
> [!CAUTION]
> Skipping `audit()` can allow unsafe archives to reach parsing/extraction
> paths with a larger blast radius.
