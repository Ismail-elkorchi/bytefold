# zip-next

Spec-first ZIP reader/writer for Node.js (>=24) using Web Streams. ESM-only, TypeScript-first, and no runtime dependencies.

## Install

```sh
npm install zip-next
```

## Usage

### Create ZIP to a file

```js
import { ZipWriter } from 'zip-next';

const writer = await ZipWriter.toFile(new URL('./out.zip', import.meta.url));
await writer.add('hello.txt', new TextEncoder().encode('hello world'));
await writer.add('data.bin', new Uint8Array([0, 1, 2, 3]));
await writer.close('created by zip-next');
```

### Create ZIP to a Web WritableStream

```js
import { ZipWriter } from 'zip-next';

const { writable, readable } = new TransformStream();
const writer = ZipWriter.toWritable(writable);
await writer.add('stream.txt', new TextEncoder().encode('streaming'));
await writer.close();

// readable is a ReadableStream<Uint8Array>
```

### Read ZIP from a file

```js
import { ZipReader } from 'zip-next';

const reader = await ZipReader.fromFile(new URL('./out.zip', import.meta.url));
for (const entry of reader.entries()) {
  console.log(entry.name, entry.uncompressedSize);
}

const entry = reader.entries().find((e) => e.name === 'hello.txt');
if (entry) {
  const stream = await reader.open(entry);
  const bytes = await new Response(stream).arrayBuffer();
  console.log(new TextDecoder().decode(bytes));
}
```

### Read remote ZIP over HTTP Range

```js
import { ZipReader } from 'zip-next';

const reader = await ZipReader.fromUrl('https://example.com/archive.zip', {
  http: {
    headers: { Authorization: `Bearer ${process.env.TOKEN}` },
    cache: { blockSize: 64 * 1024, maxBlocks: 64 }
  }
});

for (const entry of reader.entries()) {
  console.log(entry.name);
}
```

### Extract one entry

```js
import { ZipReader } from 'zip-next';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

const reader = await ZipReader.fromFile('./out.zip');
const entry = reader.entries().find((e) => e.name === 'hello.txt');
if (entry) {
  const stream = await reader.open(entry);
  await pipeline(Readable.fromWeb(stream), createWriteStream('./hello.txt'));
}
```

## Supported compression methods

- Store (method 0)
- Deflate (method 8, raw DEFLATE)
- Zstandard (method 93, Node `zlib` Zstd)

Unknown methods are parsed but extraction fails with `ZIP_UNSUPPORTED_METHOD`.
If the Node runtime lacks Zstd support, method 93 fails with `ZIP_ZSTD_UNAVAILABLE`.

## Strict vs non-strict

`ZipReader` defaults to strict parsing. Non-strict mode (`{ strict: false }`) attempts to continue when:

- multiple EOCD signatures are found (uses the last one)
- UTF-8 filename decoding fails (uses replacement)
- CRC mismatch is detected (records a warning)

Warnings are exposed via `reader.warnings()`.

## Compatibility

See `docs/compliance.md` for a full feature matrix and `docs/security.md` for extraction safety defaults.

## Seekable patch mode

When writing to a file, `ZipWriter` can patch local headers in-place instead of emitting data descriptors.
This improves compatibility with readers that expect sizes in the local header.

```js
const writer = await ZipWriter.toFile('./out.zip', { seekable: 'auto' });
```

- `seekable: "auto"` (default): patch headers when the sink is seekable (files), otherwise use data descriptors.
- `seekable: "on"`: require patch mode (throws `ZIP_SINK_NOT_SEEKABLE` for non-seekable sinks).
- `seekable: "off"`: always use data descriptors.

## Unicode extra field interop

If the UTF-8 flag is not set, `ZipReader` can still recover Unicode names/comments from the Info-ZIP
Unicode Path (0x7075) and Unicode Comment (0x6375) extra fields when the CRC32 matches the raw bytes.

## API summary

- `ZipReader.fromFile(path, opts)`
- `ZipReader.fromUint8Array(data, opts)`
- `ZipReader.fromUrl(url, opts)`
- `reader.entries()`
- `reader.open(entry)`
- `reader.openRaw(entry)`
- `reader.extractAll(destDir, opts)`
- `reader.close()`

- `ZipWriter.toWritable(writable, opts)`
- `ZipWriter.toFile(path, opts)`
- `writer.add(name, source, opts)`
- `writer.close(comment?)`

Adapters:

- `toWebReadable`, `toWebWritable`, `toNodeReadable`, `toNodeWritable`

## Security notes

Extraction protects against zip slip (absolute paths, drive letters, `..` traversal, NUL bytes) by default, and enforces configurable limits on entry count, total uncompressed bytes, and compression ratio. Symlinks are rejected by default.

## Error codes

Common `ZipError` codes include:

- `ZIP_HTTP_RANGE_UNSUPPORTED`, `ZIP_HTTP_BAD_RESPONSE`, `ZIP_HTTP_SIZE_UNKNOWN`
- `ZIP_SINK_NOT_SEEKABLE`, `ZIP_ZIP64_REQUIRED`
- `ZIP_BAD_CRC`, `ZIP_LIMIT_EXCEEDED`, `ZIP_UNSUPPORTED_METHOD`, `ZIP_UNSUPPORTED_FEATURE`
