# Formats and layering

## Supported formats

| Format | Kind | Read | Write | Notes |
| --- | --- | --- | --- | --- |
| `zip` | archive | ✅ | ✅ | ZIP64 + Deflate64 supported |
| `tar` | archive | ✅ | ✅ | USTAR + PAX |
| `gz` | compression | ✅ | ✅ | Single-file gzip stream |
| `tgz` / `tar.gz` | layered | ✅ | ✅ | gzip + tar |
| `zst` | compression | ✅ | ✅ | Single-file zstd stream |
| `br` | compression | ✅ | ✅ | Single-file brotli stream |
| `tar.zst` | layered | ✅ | ✅ | zstd + tar |
| `tar.br` | layered | ✅ | ✅ | brotli + tar |
| `bz2` | compression | ✅ | ❌ | Single-file bzip2 stream (decompress-only) |
| `tar.bz2` | layered | ✅ | ❌ | bzip2 + tar (decompress-only) |
| `xz` | compression | ❌ | ❌ | Detected, but not supported |
| `tar.xz` | layered | ❌ | ❌ | Detected, but not supported |

## Auto-detection rules

`openArchive()` inspects the input and returns a detection report:

- **ZIP**: PK signatures (`0x50 0x4b` with standard header variants).
- **GZIP**: magic bytes `1f 8b`.
- **BZip2**: magic bytes `42 5a 68` (`BZh`) + valid block size digit.
- **Zstandard**: magic bytes `28 b5 2f fd`.
- **XZ**: magic bytes `fd 37 7a 58 5a 00`.
- **TAR**: 512-byte header checksum + ustar/pax detection.
- **Brotli**: **not reliably detectable** – requires a hint.

Detection prefers:

1. `options.format` (forced).
2. filename extension hint (Node/Deno/Bun `openArchive(path)`).
3. magic bytes.

Confidence is reported as `high | medium | low` along with notes.

Common extension hints:

- `.tar.gz` / `.tgz`
- `.tar.bz2` / `.tbz2` / `.tbz`
- `.tar.zst` / `.tzst`
- `.tar.br` / `.tbr`
- `.tar.xz` / `.txz`
- `.bz2` / `.bz`
- `.xz`

## Layering rules

- If `gzip` or `zstd` payloads contain a TAR stream, `openArchive()` returns `tgz` / `tar.zst`.
- Brotli payloads are only treated as TAR when explicitly hinted (`format: "tar.br"` or `.tar.br` extension).
- If a `bzip2` payload contains a TAR stream, `openArchive()` returns `tar.bz2`.
- For single-file `.bz2` streams, `openArchive()` yields exactly one entry. If a filename hint is provided, the `.bz2`/`.bz` suffix is stripped; otherwise the entry name is `data`.

## Writer behavior

`createArchiveWriter()` supports:

- `zip`, `tar`, `tgz`, `tar.zst`, `tar.br`
- single-file compression writers: `gz`, `zst`, `br` (single `add()` call)

Single-file compression writers ignore entry names and write a single compressed payload.

## Limitations

- Brotli auto-detection requires explicit hints.
- BZip2 is decompression-only (pure JS); writing `.bz2` / `.tar.bz2` is not yet supported.
- XZ payloads are detected and rejected with a typed unsupported error.
- Streaming is prioritized, but some readers buffer to enforce safety limits.
