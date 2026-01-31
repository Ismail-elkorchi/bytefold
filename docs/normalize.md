# Archive normalization

`bytefold` can normalize ZIP and TAR archives into deterministic, single-interpretation outputs. This is ideal for untrusted uploads and agent pipelines.

## ZIP modes

- `mode: "safe"` (default): decrypt + decompress supported entries, verify CRC, then recompress using a chosen method (default deflate).
- `mode: "lossless"`: preserve compressed bytes when possible and rebuild headers without changing entry payloads.

## Determinism

Set `deterministic: true` to produce stable output:

- entries sorted by normalized name
- fixed timestamps
- stable header fields and attributes

## Usage (auto)

```js
import { openArchive } from '@ismail-elkorchi/bytefold';

const reader = await openArchive(fileBytes);
const chunks = [];
const writable = new WritableStream({
  write(chunk) {
    chunks.push(new Uint8Array(chunk));
  }
});

const report = await reader.normalizeToWritable(writable, { deterministic: true });
console.log(JSON.stringify(report));
```

## ZIP-only options

```js
import { ZipReader } from '@ismail-elkorchi/bytefold/zip';

const reader = await ZipReader.fromUint8Array(zipBytes);
const report = await reader.normalizeToWritable(writable, {
  mode: 'lossless',
  onDuplicate: 'rename',
  onCaseCollision: 'rename'
});
```

## Node file helpers

```js
import { ZipReader } from '@ismail-elkorchi/bytefold/node/zip';

const reader = await ZipReader.fromFile('input.zip');
const report = await reader.normalizeToFile('normalized.zip', { deterministic: true });
```
