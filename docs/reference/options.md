# Reader and writer options

This reference summarizes common option groups. For exhaustive detail, use
`SPEC.md`.

## Reader options

- `profile`: `compat | strict | agent`
- `limits`: `maxEntries`, `maxUncompressedEntryBytes`, `maxTotalUncompressedBytes`, `maxTotalDecompressedBytes`, `maxInputBytes`, `maxCompressionRatio`, `maxDictionaryBytes`, `maxXzDictionaryBytes`, `maxXzBufferedBytes`, `maxXzIndexRecords`, `maxXzIndexBytes`, `maxXzPreflightBlockHeaders`, `maxZipCentralDirectoryBytes`, `maxZipCommentBytes`, `maxZipEocdSearchBytes`, `maxBzip2BlockSize`
- `isStrict`: explicit strict-mode override (applies after profile defaults)
- `format`: explicit format hint for `openArchive(input, { format })`
- `filename`: filename hint used by `format: "auto"` detection
- `inputKind`: optional hint for source kind (`bytes | stream | file | url | blob`) in adapters that support it
- `signal`: `AbortSignal` for cancellation
- `password`: password for encrypted ZIP where supported
- `zip`: ZIP-reader tuning options for advanced read/audit flows
- `tar`: TAR-reader tuning options for advanced read/audit flows
- Brotli ambiguity: when no filename hint is available, set `format: "br"` for single-file Brotli input or `format: "tar.br"` for TAR+Brotli input

## Writer options (`createArchiveWriter(format, writable, options?)`)

- `format`: output archive format (`zip`, `tar`, `tgz`, `tar.gz`, `tar.zst`, `tar.br`, `gz`, `zst`, `br`)
- Unsupported write formats throw `ARCHIVE_UNSUPPORTED_FORMAT` (`bz2`, `tar.bz2`, `xz`, `tar.xz`).
- `options.zip`: ZIP writer options (`shouldForceZip64`, `defaultMethod`, `sinkSeekabilityPolicy`, progress callbacks, `signal`).
- Universal `createArchiveWriter` rejects ZIP encryption/password. ZIP encryption is only available in Node-specific ZIP writer APIs.
- `options.tar`: TAR writer options (`isDeterministic`, `signal`)
- `options.compression`: compression tuning for layered/single-file compressed outputs (`level`, `quality`)
