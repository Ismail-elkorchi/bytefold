# How-to: validate, then read entry content

## Goal
Audit archives before reading payload bytes so unsafe archives fail early.

## Prereqs
- `@ismail-elkorchi/bytefold` installed
- Input archive bytes

## Copy/paste
```ts
import { openArchive } from "@ismail-elkorchi/bytefold";

const reader = await openArchive(input, { profile: "agent" });
const report = await reader.audit({ profile: "agent" });

if (!report.ok) {
  console.error(JSON.stringify(report.issues, null, 2));
  process.exitCode = 1;
  throw new Error("Audit failed");
}

await reader.assertSafe({ profile: "agent" });

const extracted = new Map<string, Uint8Array>();
for await (const entry of reader.entries()) {
  if (entry.isDirectory || entry.isSymlink) continue;
  const bytes = new Uint8Array(await new Response(await entry.open()).arrayBuffer());
  extracted.set(entry.name, bytes);
}
```

## What you should see
- Failed audits stop processing before entry payload reads.
- Successful audits allow controlled iteration over entries.

## Safety notes
> [!CAUTION]
> Do not call `entry.open()` for untrusted archives before `audit()` +
> `assertSafe()` completes.
