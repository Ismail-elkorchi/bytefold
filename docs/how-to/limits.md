# How-to: configure resource limits

## Goal
Set explicit size/count limits so archive handling remains bounded for untrusted
inputs.

## Prereqs
- `@ismail-elkorchi/bytefold` installed
- Input archive bytes or stream

## Copy/paste
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
console.log(report.ok);
```

## What you should see
- `report.ok` is `true` for healthy archives under limits.
- Limit violations raise typed errors with stable codes.

## Safety notes
> [!WARNING]
> `profile` sets defaults, but explicit `limits` should still be set for
> internet-facing or user-uploaded archives.
