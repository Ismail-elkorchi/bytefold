# Security considerations

## Zip slip protection

By default, `extractAll()` rejects entries that could escape the destination directory:

- Absolute paths (`/etc/passwd`)
- Drive-letter paths (`C:\Windows\...`)
- `..` traversal segments
- NUL bytes in filenames

These checks are enforced before writing any file to disk, and errors are raised with `ZIP_PATH_TRAVERSAL`.

## Symlinks

Symlink entries are rejected by default (`ZIP_SYMLINK_DISALLOWED`). If enabled, the entry payload is treated as a UTF-8 symlink target.

## Size limits and bomb mitigation

`ZipReader` applies configurable limits:

- `maxEntries` (default 10,000)
- `maxUncompressedEntryBytes` (default 512 MiB)
- `maxTotalUncompressedBytes` (default 2 GiB)
- `maxCompressionRatio` (default 1000)

These limits can be overridden via `ZipReaderOptions.limits` or `extractAll(..., { limits })`.

## Remote range reading

When using `ZipReader.fromUrl()`, the same limits apply to remote ZIPs. Range requests only fetch the
bytes needed to locate the central directory and read entries, but large or highly-compressed content
is still subject to the configured size and ratio limits.

## CRC validation

In strict mode (default), CRC32 mismatches cause extraction to fail with `ZIP_BAD_CRC`. In non-strict mode, mismatches are recorded as warnings.
