# Migration guide (zip-next → @ismail-elkorchi/bytefold)

This release is **pre-stable** and introduces breaking changes to simplify the architecture and add multi-format support.

## Package rename

- Old: `zip-next`
- New: `@ismail-elkorchi/bytefold`

```diff
- import { ZipReader } from 'zip-next';
+ import { ZipReader } from '@ismail-elkorchi/bytefold/zip';
```

## New default entrypoint

The default entrypoint is now **format-agnostic**:

```js
import { openArchive } from '@ismail-elkorchi/bytefold';
const reader = await openArchive(bytesOrStream);
```

## ZIP API moved to subpath

ZIP APIs now live under `@ismail-elkorchi/bytefold/zip`:

```js
import { ZipReader, ZipWriter } from '@ismail-elkorchi/bytefold/zip';
```

## Node-only ZIP features

Node-specific file helpers and encryption now live under `@ismail-elkorchi/bytefold/node/zip`:

```js
import { ZipReader, ZipWriter } from '@ismail-elkorchi/bytefold/node/zip';
```

## Deno/Bun adapters

File helpers for Deno and Bun are under `@ismail-elkorchi/bytefold/deno` and `@ismail-elkorchi/bytefold/bun`.

## ZIP reader changes (core)

- `ZipReader.fromFile()` and Node stream support moved to `@ismail-elkorchi/bytefold/node/zip`.
- Core ZIP APIs accept Web streams + Uint8Array and run on Node, Deno, and Bun.
- Encryption is Node-only; core builds report `ZIP_UNSUPPORTED_ENCRYPTION` when used.

## New TAR + GZIP support

- `TarReader` / `TarWriter` available under `@ismail-elkorchi/bytefold/tar`.
- `openArchive()` auto-detects `zip`, `tar`, `gz`, and `tgz`.

## Normalization

- `normalizeToWritable()` works for ZIP and TAR through the auto reader.
- ZIP `normalizeToFile()` remains available under `@ismail-elkorchi/bytefold/node/zip`.
