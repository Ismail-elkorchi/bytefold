# Compression API

`@ismail-elkorchi/bytefold/compress` provides a stream-first, cross-runtime compression surface.

## Capabilities

```js
import { getCompressionCapabilities } from '@ismail-elkorchi/bytefold/compress';

const caps = getCompressionCapabilities();
console.log(JSON.stringify(caps, null, 2));
```

The report is JSON-safe and includes:

- `schemaVersion`: stable contract version for agents
- `runtime`: `node | deno | bun | unknown`
- `algorithms`: per-algorithm support for compress/decompress and the active backend
- `notes`: detection notes (for example, missing CompressionStream support)

## Create a compressor / decompressor

```js
import { createCompressor, createDecompressor } from '@ismail-elkorchi/bytefold/compress';

const compressor = createCompressor({ algorithm: 'gzip' });
const decompressor = createDecompressor({ algorithm: 'gzip' });

const output = inputStream.pipeThrough(compressor).pipeThrough(decompressor);
```

## Supported algorithms

`CompressionAlgorithm = "gzip" | "deflate" | "deflate-raw" | "brotli" | "zstd" | "bzip2" | "xz"`

- **Node**: prefers `node:zlib` for gzip/deflate/brotli/zstd when available.
- **Deno/Bun**: uses `CompressionStream` / `DecompressionStream` where available.
- **BZip2**: pure JS decompression only (no compression yet).
- **XZ**: detected in archive layer but unsupported in compression streams.

## Options

```ts
type CompressionOptions = {
  algorithm: CompressionAlgorithm;
  signal?: AbortSignal;
  onProgress?: (ev: CompressionProgressEvent) => void;
  level?: number;   // gzip/deflate/deflate-raw/zstd
  quality?: number; // brotli
  maxOutputBytes?: bigint | number;
  maxCompressionRatio?: number;
};
```

Progress events are monotonic and include `bytesIn`/`bytesOut` and the algorithm.

## Errors

`CompressionError` codes:

- `COMPRESSION_UNSUPPORTED_ALGORITHM` – algorithm not supported in this runtime.
- `COMPRESSION_BACKEND_UNAVAILABLE` – backend failed to initialize or crashed.
- `COMPRESSION_BZIP2_BAD_DATA` – malformed or truncated bzip2 payload.
- `COMPRESSION_BZIP2_CRC_MISMATCH` – bzip2 CRC mismatch.

## Backend selection

Selection order is deterministic:

1. If running on Node and `node:zlib` supports the algorithm, use it.
2. Otherwise, use `CompressionStream` / `DecompressionStream` (gzip/deflate/deflate-raw).
3. For `bzip2`, use the pure JS decompressor (decompress only).
4. If neither backend supports the algorithm, throw `COMPRESSION_UNSUPPORTED_ALGORITHM`.

## Runtime examples

### Node

```js
import { createCompressor } from '@ismail-elkorchi/bytefold/compress';

const gzip = createCompressor({ algorithm: 'gzip', level: 6 });
readable.pipeThrough(gzip).pipeTo(writable);
```

### Deno

```js
import { createDecompressor } from 'npm:@ismail-elkorchi/bytefold/compress';

const inflator = createDecompressor({ algorithm: 'deflate-raw' });
readable.pipeThrough(inflator).pipeTo(writable);
```

### Bun

```js
import { getCompressionCapabilities } from '@ismail-elkorchi/bytefold/compress';

const caps = getCompressionCapabilities();
if (caps.algorithms.gzip.compress) {
  // ...
}
```
