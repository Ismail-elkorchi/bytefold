# How-to: inspect uploaded archives in browser flows

## Goal
Open a user-provided archive as a `Blob` and inspect entry metadata before any
deeper processing.

## Prerequisites
- Node `>=24` for local verification (browser API-compatible runtime features)
- `npm install`
- `npm run build`

## Copy/paste
Browser-style snippet:

```ts
import { openArchive } from "@ismail-elkorchi/bytefold/web";

const file = input.files?.[0];
if (!file) throw new Error("No file selected");

const reader = await openArchive(file, { profile: "agent" });
const report = await reader.audit({ profile: "agent" });
if (!report.ok) throw new Error("Upload audit failed");

for await (const entry of reader.entries()) {
  console.log(entry.name, entry.size.toString());
}
```

Runnable local example:

```sh
node examples/inspect-upload-in-browser.mjs
```

## Expected output or shape
- JSON output with `format: "zip"` for the fixture input.
- Entry list with names and sizes.

## Common failure modes
- Upload flows trust entry names or paths before an audit step.
- The browser entrypoint is expected to perform filesystem extraction.
- Password-protected or unsupported formats are surfaced as generic UI errors
  instead of typed archive failures.

## Related reference
- [Reader and writer options](../reference/options.md)
- [Runtime compatibility](../reference/compat.md)
- [Error codes](../reference/errors.md)
