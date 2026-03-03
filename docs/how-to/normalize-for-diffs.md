# How-to: normalize archives for stable diffs

## Goal
Produce deterministic archive bytes so diff/review tooling compares meaningful
changes instead of metadata noise.

## Prereqs
- Node `>=24`
- `npm install`
- `npm run build`

## Copy/paste
```sh
node examples/normalize-for-diffs.mjs
```

Equivalent API pattern:

```ts
import { openArchive } from "@ismail-elkorchi/bytefold";

const reader = await openArchive(bytes, { profile: "strict" });
const writable = new WritableStream<Uint8Array>({
  write(chunk) {
    // store normalized bytes
  },
});
const report = await reader.normalizeToWritable?.(writable, {
  isDeterministic: true,
});
```

## What you should see
- JSON output contains `reportOk: true`.
- `outputBytes` indicates normalized archive size.

## Safety notes
> [!NOTE]
> Normalization reports explicit `warnings`/`errors`; gate CI on those fields
> instead of assuming success from file creation alone.
