# Bytefold state report (baseline)

Date: 2026-01-31
Repo: @ismail-elkorchi/bytefold

## Public API exports

Top-level (`@ismail-elkorchi/bytefold`)
- Archive: `openArchive`, `createArchiveWriter`, `ArchiveReader`, `ArchiveWriter`
- Errors/types: `ArchiveError`, `ArchiveAuditReport`, `ArchiveEntry`, `ArchiveFormat`, `ArchiveIssue`, `ArchiveIssueSeverity`, `ArchiveLimits`, `ArchiveNormalizeReport`, `ArchiveOpenOptions`, `ArchiveProfile`
- ZIP + TAR re-exports: everything from `/zip` and `/tar`

ZIP subpath (`@ismail-elkorchi/bytefold/zip`)
- `ZipReader`, `ZipWriter`, `ZipError`, `ZipErrorCode`
- Types: compression/limits/audit/normalize/progress/read/write option types
- Compression registry: `registerCompressionCodec`, `listCompressionCodecs`

TAR subpath (`@ismail-elkorchi/bytefold/tar`)
- `TarReader`, `TarWriter`
- Types: entries, audit/normalize options + reports, writer options

Node subpath (`@ismail-elkorchi/bytefold/node`)
- `openArchive` (Node inputs: path/URL/Node stream)
- `createArchiveWriter`, `ArchiveError`, archive types
- ZIP/TAR re-exports (including Node ZIP features under `/node/zip`)
- Node stream adapters: `toWebReadable`, `toWebWritable`, `toNodeReadable`, `toNodeWritable`

Deno subpath (`@ismail-elkorchi/bytefold/deno`)
- `openArchive`, `zipFromFile`, `tarFromFile`, `zipToFile`, `tarToFile`
- Archive + ZIP + TAR re-exports

Bun subpath (`@ismail-elkorchi/bytefold/bun`)
- `openArchive`, `zipFromFile`, `tarFromFile`, `zipToFile`, `tarToFile`
- Archive + ZIP + TAR re-exports

## Supported archive formats and wrappers (today)
- Containers: ZIP, TAR
- Wrappers: GZIP (`.gz`), TGZ (`.tar.gz`)
- Auto-open supports: `zip`, `tar`, `gz`, `tgz`

## Compression algorithms per runtime (today)
- Universal Web Compression Streams (if available): `gzip`, `deflate`, `deflate-raw`
- Node zlib backend (preferred on Node): `gzip`, `deflate`, `deflate-raw`, `brotli`, `zstd` (zstd availability depends on Node build)
- ZIP-specific: `deflate64` handled by internal TS decoder (read only)

Detection today:
- `createCompressTransform`/`createDecompressTransform` first checks Node backend (if Node + algorithm supported), then Web Compression Streams; otherwise throws `ZIP_UNSUPPORTED_METHOD` or `ZIP_ZSTD_UNAVAILABLE`.

## Current auto-detect behavior
- `openArchive(input, { format: 'auto' })` buffers input into a `Uint8Array` (streams are fully read).
- Detection order:
  1) GZIP magic `1F 8B` → `gz`
  2) ZIP signatures `PK 03 04`, `PK 05 06`, `PK 07 08`
  3) TAR header checksum + `ustar` magic (or blank) in first 512 bytes
- If detected as `gz`, the data is gunzipped; if the payload parses as TAR, format is reported as `tgz`, otherwise `gz`.
- TAR detection uses checksum + `ustar`/blank magic; false positives are unlikely but still possible for non-TAR 512-byte blocks with valid checksum.

## JSON-safety status (BigInt handling)
- JSON-safe:
  - ZIP audit/normalize reports (`ZipReader.audit()` / `normalizeToWritable()`) include `toJSON()` that stringifies bigint fields.
  - TAR audit/normalize reports (`TarReader.audit()` / `normalizeToWritable()`) include `toJSON()` with bigint stringification.
  - Archive-level `audit()`/`normalizeToWritable()` wrapper surfaces `toJSON()` when present.
- Not JSON-safe by default:
  - `ArchiveEntry.size`, `ZipEntry.*` sizes/offsets, and `TarEntry.size` are `bigint` values.
  - `ZipError.offset` and `ArchiveError.offset` are `bigint`.
  - Any raw entry objects (`entry.raw`) may include bigint fields.

## Known error/warning codes (current)

Archive layer (throws `ArchiveError`):
- `ARCHIVE_UNSUPPORTED_FORMAT`, `ARCHIVE_TRUNCATED`, `ARCHIVE_BAD_HEADER`, `ARCHIVE_PATH_TRAVERSAL`,
  `ARCHIVE_LIMIT_EXCEEDED`, `ARCHIVE_UNSUPPORTED_FEATURE`, `ARCHIVE_AUDIT_FAILED`

ZIP layer (throws `ZipError`, see `src/errors.ts`):
- `ZIP_HTTP_RANGE_UNSUPPORTED`, `ZIP_HTTP_BAD_RESPONSE`, `ZIP_HTTP_SIZE_UNKNOWN`
- `ZIP_EOCD_NOT_FOUND`, `ZIP_MULTIPLE_EOCD`, `ZIP_BAD_EOCD`, `ZIP_BAD_ZIP64`, `ZIP_BAD_CENTRAL_DIRECTORY`
- `ZIP_UNSUPPORTED_METHOD`, `ZIP_UNSUPPORTED_FEATURE`, `ZIP_UNSUPPORTED_ENCRYPTION`, `ZIP_ZSTD_UNAVAILABLE`
- `ZIP_DEFLATE64_BAD_DATA`, `ZIP_BAD_CRC`, `ZIP_BAD_PASSWORD`, `ZIP_PASSWORD_REQUIRED`, `ZIP_AUTH_FAILED`
- `ZIP_SINK_NOT_SEEKABLE`, `ZIP_ZIP64_REQUIRED`, `ZIP_PATH_TRAVERSAL`, `ZIP_SYMLINK_DISALLOWED`
- `ZIP_LIMIT_EXCEEDED`, `ZIP_INVALID_ENCODING`, `ZIP_TRUNCATED`, `ZIP_INVALID_SIGNATURE`,
  `ZIP_ENTRIES_NOT_STORED`, `ZIP_AUDIT_FAILED`

ZIP warnings (`ZipWarning`):
- `ZIP_MULTIPLE_EOCD`, `ZIP_BAD_EOCD`, `ZIP_BAD_CENTRAL_DIRECTORY`, `ZIP_BAD_CRC`,
  `ZIP_INVALID_ENCODING`, `ZIP_LIMIT_EXCEEDED`, `ZIP_UNSUPPORTED_FEATURE`

TAR audit/normalize issues (emitted by `TarReader`):
- `TAR_BAD_HEADER`, `TAR_PARSE_FAILED`, `TAR_LIMIT_EXCEEDED`, `TAR_DUPLICATE_ENTRY`,
  `TAR_CASE_COLLISION`, `TAR_SYMLINK_PRESENT`, `TAR_PATH_TRAVERSAL`, `TAR_UNSUPPORTED_ENTRY`

GZIP wrapper audit (archive layer):
- `GZIP_LIMIT_EXCEEDED` and `ARCHIVE_PATH_TRAVERSAL` from archive wrapper validation.
