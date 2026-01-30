# ZIP normalization

Normalization produces a deterministic ZIP with a single interpretation, which is ideal for untrusted uploads and agent pipelines.
The pipeline validates names, removes ambiguity, and rewrites headers so local and central directory metadata agree.

## Modes

- `mode: "safe"` (default): decrypt + decompress supported entries, verify CRC, then recompress using a chosen method (default deflate).
- `mode: "lossless"`: preserve compressed bytes when possible and rebuild headers without changing entry payloads.

## Determinism

Set `deterministic: true` to produce stable output:

- entries sorted by normalized name
- fixed timestamps (DOS epoch)
- stable header fields and attributes

## Conflict handling

By default, duplicates and case collisions are errors. You can override:

```js
await reader.normalizeToFile('out.zip', {
  onDuplicate: 'rename',
  onCaseCollision: 'rename'
});
```

## Usage

```js
import { ZipReader } from 'zip-next';

const reader = await ZipReader.fromFile('input.zip');
const report = await reader.normalizeToFile('normalized.zip', {
  mode: 'safe',
  deterministic: true
});

console.log(JSON.stringify(report)); // JSON-safe
```

To stream to any writable:

```js
const chunks = [];
const writable = new WritableStream({
  write(chunk) {
    chunks.push(new Uint8Array(chunk));
  }
});

const report = await reader.normalizeToWritable(writable, { mode: 'lossless' });
```
