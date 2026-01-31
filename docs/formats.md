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

## Auto-detection rules

`openArchive()` inspects the input and returns a detection report:

- **ZIP**: PK signatures (`0x50 0x4b` with standard header variants).
- **GZIP**: magic bytes `1f 8b`.
- **Zstandard**: magic bytes `28 b5 2f fd`.
- **TAR**: 512-byte header checksum + ustar/pax detection.
- **Brotli**: **not reliably detectable** – requires a hint.

Detection prefers:

1. `options.format` (forced).
2. filename extension hint (Node/Deno/Bun `openArchive(path)`).
3. magic bytes.

Confidence is reported as `high | medium | low` along with notes.

Common extension hints:

- `.tar.gz` / `.tgz`
- `.tar.zst` / `.tzst`
- `.tar.br` / `.tbr`

## Layering rules

- If `gzip` or `zstd` payloads contain a TAR stream, `openArchive()` returns `tgz` / `tar.zst`.
- Brotli payloads are only treated as TAR when explicitly hinted (`format: "tar.br"` or `.tar.br` extension).

## Writer behavior

`createArchiveWriter()` supports:

- `zip`, `tar`, `tgz`, `tar.zst`, `tar.br`
- single-file compression writers: `gz`, `zst`, `br` (single `add()` call)

Single-file compression writers ignore entry names and write a single compressed payload.

## Limitations

- Brotli auto-detection requires explicit hints.
- Native 7z is not supported (see `docs/7z.md`).
- Streaming is prioritized, but some readers buffer to enforce safety limits.
