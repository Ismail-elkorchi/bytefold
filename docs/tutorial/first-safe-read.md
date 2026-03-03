# Tutorial: first safe archive read

## Goal
Open one archive, audit it, and consume file entry streams only after safety
checks pass.

## Prereqs
- Node `>=24`
- `@ismail-elkorchi/bytefold` installed
- Archive bytes available (`Uint8Array`)

## Copy/paste
```ts
import { readFile } from "node:fs/promises";
import { openArchive } from "@ismail-elkorchi/bytefold";

const bytes = await readFile("./archive.zip");
const reader = await openArchive(bytes, { profile: "agent" });
const report = await reader.audit({ profile: "agent" });
if (!report.ok) throw new Error("audit failed");

await reader.assertSafe({ profile: "agent" });
for await (const entry of reader.entries()) {
  if (entry.isDirectory || entry.isSymlink) continue;
  const payload = new Uint8Array(await new Response(await entry.open()).arrayBuffer());
  console.log(entry.name, payload.byteLength);
}
```

## What you should see
- Audit succeeds (`report.ok === true`) for safe archives.
- File entries stream with stable `entry.name` and byte lengths.

## Safety notes
> [!CAUTION]
> Do not call `entry.open()` before audit/safety checks complete when the
> archive source is untrusted.
