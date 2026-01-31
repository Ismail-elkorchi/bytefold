# bytefold

Multi-format archive reader/writer for the 2026+ agent stack. ZIP + TAR + GZIP + Zstandard + Brotli, with audit-first safety, deterministic normalization, and first-class support for Node 24+, Deno, and Bun. ESM-only, TypeScript-first, no runtime deps.

## Install

```sh
npm install @ismail-elkorchi/bytefold
```

## Quickstart (auto-detect)

```js
import { openArchive } from '@ismail-elkorchi/bytefold';

const reader = await openArchive(bytesOrStream, { profile: 'agent' });
const report = await reader.audit({ profile: 'agent' });
console.log(JSON.stringify(report));

await reader.assertSafe({ profile: 'agent' });
for await (const entry of reader.entries()) {
  if (entry.isDirectory) continue;
  const data = await new Response(await entry.open()).arrayBuffer();
  console.log(entry.name, data.byteLength);
}
```

Supported auto formats: ZIP, TAR, GZ, TGZ, ZST, BR, TAR.ZST, TAR.BR.

## ZIP API (core)

```js
import { ZipWriter, ZipReader } from '@ismail-elkorchi/bytefold/zip';

const writer = ZipWriter.toWritable(writableStream);
await writer.add('hello.txt', new TextEncoder().encode('hello'));
await writer.close();

const reader = await ZipReader.fromUint8Array(zipBytes);
const entry = reader.entries()[0]!;
const stream = await reader.open(entry);
```

## TAR API (core)

```js
import { TarWriter, TarReader } from '@ismail-elkorchi/bytefold/tar';

const writer = TarWriter.toWritable(writableStream);
await writer.add('greet.txt', new TextEncoder().encode('hello tar'));
await writer.close();

const reader = await TarReader.fromUint8Array(tarBytes);
for (const entry of reader.entries()) {
  console.log(entry.name, entry.size);
}
```

## Node-only ZIP features (encryption, file helpers)

```js
import { ZipWriter, ZipReader } from '@ismail-elkorchi/bytefold/node/zip';

const writer = await ZipWriter.toFile('./secret.zip', {
  encryption: { type: 'aes', password: 'pw', strength: 256, vendorVersion: 2 }
});
await writer.add('secret.txt', new TextEncoder().encode('secret'));
await writer.close();

const reader = await ZipReader.fromFile('./secret.zip');
const entry = reader.entries()[0]!;
const stream = await reader.open(entry, { password: 'pw' });
```

## Deno + Bun file adapters

```js
// Deno
import { openArchive, zipToFile } from '@ismail-elkorchi/bytefold/deno';

const writer = await zipToFile('./out.zip');
await writer.add('hello.txt', new TextEncoder().encode('deno'));
await writer.close();

const reader = await openArchive('./out.zip');
```

```js
// Bun
import { openArchive, zipToFile } from '@ismail-elkorchi/bytefold/bun';

const writer = await zipToFile('./out.zip');
await writer.add('hello.txt', new TextEncoder().encode('bun'));
await writer.close();
```

## Safety features

- Audit + assertSafe for untrusted archives
- Path traversal protections (ZIP + TAR)
- Limits: max entries, max entry bytes, max total bytes
- Deterministic normalization for ZIP + TAR

## Compression backend

- Web Compression Streams (gzip, deflate-raw)
- Node zlib preferred when available (zstd/brotli supported in Node builds that include them)

## Compression API (cross-runtime)

```js
import { createCompressor, createDecompressor } from '@ismail-elkorchi/bytefold/compress';

const gzip = createCompressor({ algorithm: 'gzip' });
const gunzip = createDecompressor({ algorithm: 'gzip' });
input.pipeThrough(gzip).pipeThrough(gunzip);
```

## Supported ZIP methods

- Store (method 0)
- Deflate (method 8, raw DEFLATE)
- Deflate64 (method 9, built-in TS decoder)
- Zstandard (method 93, Node zlib when available)

## Runtime notes

- Default entrypoint is universal (no Node builtins on import).
- Node-only adapters are under `@ismail-elkorchi/bytefold/node`.
- Optional external `7z` bridge is under `@ismail-elkorchi/bytefold/node/external`.
- Deno/Bun file adapters are under `@ismail-elkorchi/bytefold/deno` and `@ismail-elkorchi/bytefold/bun`.
