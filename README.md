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

### Read ZIP from a stream

```js
import { ZipReader } from 'zip-next';
import { createReadStream } from 'node:fs';

const stream = createReadStream('./archive.zip');
const reader = await ZipReader.fromStream(stream, { profile: 'strict' });
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

### Stream entries without storing them

```js
import { ZipReader } from 'zip-next';

const reader = await ZipReader.fromFile('./big.zip', {
  storeEntries: false,
  limits: { maxEntries: 200000 }
});

for await (const entry of reader.iterEntries()) {
  console.log(entry.name, entry.uncompressedSize);
}
```

When `storeEntries` is disabled, `reader.entries()` throws `ZIP_ENTRIES_NOT_STORED`.
When `storeEntries` is enabled (default), entries are cached while iterating; disable it for true streaming without retention.

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

### Audit before extract (agent workflow)

```js
import { ZipReader } from 'zip-next';

const reader = await ZipReader.fromUrl('https://example.com/archive.zip');
const report = await reader.audit({ profile: 'agent' });

// JSON-safe output (bigints converted to strings by toJSON)
console.log(JSON.stringify(report));

await reader.assertSafe({ profile: 'agent' });
// safe to extract selected entries now
```

### Abort + progress

```js
import { ZipReader } from 'zip-next';

const reader = await ZipReader.fromFile('./big.zip');
const controller = new AbortController();

await reader.extractAll('./out', {
  signal: controller.signal,
  onProgress: (evt) => {
    if (evt.kind === 'extract' && evt.bytesOut && evt.bytesOut > 10_000_000n) {
      controller.abort();
    }
  }
});
```

### Async disposal (Node 24+)

```js
await using reader = await ZipReader.fromFile('./archive.zip');
const entries = reader.entries();
```

## Supported compression methods

- Store (method 0)
- Deflate (method 8, raw DEFLATE)
- Zstandard (method 93, Node `zlib` Zstd)

Unknown methods are parsed but extraction fails with `ZIP_UNSUPPORTED_METHOD`.
If the Node runtime lacks Zstd support, method 93 fails with `ZIP_ZSTD_UNAVAILABLE`.

## Encryption (read + write)

`zip-next` supports traditional PKWARE encryption (ZipCrypto) and WinZip AES (AE-1/AE-2).

### Write encrypted ZIPs

```js
import { ZipWriter } from 'zip-next';

const writer = await ZipWriter.toFile('./secret.zip', {
  encryption: { type: 'aes', password: 'pw', strength: 256, vendorVersion: 2 }
});
await writer.add('secret.txt', new TextEncoder().encode('secret'));
await writer.close();
```

### Read encrypted ZIPs

```js
import { ZipReader } from 'zip-next';

const reader = await ZipReader.fromFile('./secret.zip');
const entry = reader.entries()[0]!;
const stream = await reader.open(entry, { password: 'pw' });
```

## Profiles

`ZipReader` supports safety profiles via `ZipReaderOptions.profile`:

- `compat`: accept more with warnings (`strict: false`, default limits).
- `strict`: strict parsing (`strict: true`, default limits). This is the default profile.
- `agent`: strict parsing + conservative limits, reject trailing bytes, and treat symlink entries as errors in audits.

You can override profile defaults via `strict` and `limits` per reader or per audit/extract call.

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
- `ZipReader.fromStream(stream, opts)`
- `ZipReader.fromUrl(url, opts)`
- `reader.entries()`
- `reader.iterEntries(opts?)`
- `reader.forEachEntry(fn, opts?)`
- `reader.open(entry)`
- `reader.openRaw(entry)`
- `reader.extractAll(destDir, opts)`
- `reader.audit(opts?)`
- `reader.assertSafe(opts?)`
- `reader.close()`

- `ZipWriter.toWritable(writable, opts)`
- `ZipWriter.toFile(path, opts)`
- `writer.add(name, source, opts)`
- `writer.close(comment?, opts?)`

Adapters:

- `toWebReadable`, `toWebWritable`, `toNodeReadable`, `toNodeWritable`

## Security notes

Extraction protects against zip slip (absolute paths, drive letters, `..` traversal, NUL bytes) by default, and
enforces configurable limits on entry count, total uncompressed bytes, and compression ratio. Symlinks are
rejected by default.

Use `reader.audit()` to get a machine-readable report before extraction, and `reader.assertSafe()` to fail fast
in agent workflows.

## Error codes

Common `ZipError` codes include:

- `ZIP_HTTP_RANGE_UNSUPPORTED`, `ZIP_HTTP_BAD_RESPONSE`, `ZIP_HTTP_SIZE_UNKNOWN`
- `ZIP_SINK_NOT_SEEKABLE`, `ZIP_ZIP64_REQUIRED`
- `ZIP_ENTRIES_NOT_STORED`, `ZIP_AUDIT_FAILED`, `ZIP_PATH_TRAVERSAL`, `ZIP_SYMLINK_DISALLOWED`
- `ZIP_BAD_CRC`, `ZIP_LIMIT_EXCEEDED`, `ZIP_UNSUPPORTED_METHOD`, `ZIP_UNSUPPORTED_FEATURE`
- `ZIP_PASSWORD_REQUIRED`, `ZIP_BAD_PASSWORD`, `ZIP_AUTH_FAILED`, `ZIP_UNSUPPORTED_ENCRYPTION`
