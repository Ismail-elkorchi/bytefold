# How-to: normalize archives for stable diffs

## Goal
Produce deterministic archive bytes so diff/review tooling compares meaningful
changes instead of metadata noise.

## Prerequisites
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
if (!reader.normalizeToWritable) {
  throw new Error("normalizeToWritable is unavailable for this format");
}

const report = await reader.normalizeToWritable(writable, {
  isDeterministic: true,
});

console.log(JSON.stringify({
  ok: report.ok,
  warnings: report.summary.warnings,
  errors: report.summary.errors,
}, null, 2));
```

## Expected output or shape
- JSON output contains `reportOk: true`.
- `outputBytes` indicates normalized archive size.

## Common failure modes
- CI compares raw archive bytes instead of normalized output.
- Normalize reports are ignored and file creation is treated as success.
- The chosen format cannot be deterministically rewritten the way the workflow
  expects.

## Related reference
- [Reader and writer options](../reference/options.md)
- [Error codes](../reference/errors.md)
- [SPEC.md](../../SPEC.md)
