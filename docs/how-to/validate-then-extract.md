# How-to: validate, then read entry content

## Goal
Audit archives before reading payload bytes so unsafe archives fail early.

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

## Expected output or shape
- Failed audits stop processing before entry payload reads.
- Successful audits allow controlled iteration over entries.

## Common failure modes
- The caller treats `audit()` as optional because `entries()` is available.
- Audit failures are logged and ignored instead of blocking the read path.
- Directory or symlink entries are opened as if they were regular files.

## Related reference
- [Reader and writer options](../reference/options.md)
- [Error codes](../reference/errors.md)
- [SPEC.md](../../SPEC.md)
