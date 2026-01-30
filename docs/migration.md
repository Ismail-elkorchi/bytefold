# Migration guide (zip-next → archive-shield)

This release is **pre-stable** and introduces breaking changes to simplify the architecture and add multi-format support.

## Package rename

- Old: `zip-next`
- New: `archive-shield`

```diff
- import { ZipReader } from 'zip-next';
+ import { ZipReader } from 'archive-shield/zip';
```

## New default entrypoint

The default entrypoint is now **format-agnostic**:

```js
import { openArchive } from 'archive-shield';
const reader = await openArchive(bytesOrStream);
```

## ZIP API moved to subpath

ZIP APIs now live under `archive-shield/zip`:

```js
import { ZipReader, ZipWriter } from 'archive-shield/zip';
```

## Node-only ZIP features

Node-specific file helpers and encryption now live under `archive-shield/node/zip`:

```js
import { ZipReader, ZipWriter } from 'archive-shield/node/zip';
```

## Deno/Bun adapters

File helpers for Deno and Bun are under `archive-shield/deno` and `archive-shield/bun`.

## ZIP reader changes (core)

- `ZipReader.fromFile()` and Node stream support moved to `archive-shield/node/zip`.
- Core ZIP APIs accept Web streams + Uint8Array and run on Node, Deno, and Bun.
- Encryption is Node-only; core builds report `ZIP_UNSUPPORTED_ENCRYPTION` when used.

## New TAR + GZIP support

- `TarReader` / `TarWriter` available under `archive-shield/tar`.
- `openArchive()` auto-detects `zip`, `tar`, `gz`, and `tgz`.

## Normalization

- `normalizeToWritable()` works for ZIP and TAR through the auto reader.
- ZIP `normalizeToFile()` remains available under `archive-shield/node/zip`.
