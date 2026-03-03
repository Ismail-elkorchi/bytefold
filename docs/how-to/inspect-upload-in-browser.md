# How-to: inspect uploaded archives in browser flows

## Goal
Open a user-provided archive as a `Blob` and inspect entry metadata before any
deeper processing.

## Prereqs
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
for await (const entry of reader.entries()) {
  console.log(entry.name, entry.size.toString());
}
```

Runnable local example:

```sh
node examples/inspect-upload-in-browser.mjs
```

## What you should see
- JSON output with `format: "zip"` for the fixture input.
- Entry list with names and sizes.

## Safety notes
> [!WARNING]
> Do not trust file names from uploads. Always audit with strict/agent profile
> before extraction or downstream processing.
