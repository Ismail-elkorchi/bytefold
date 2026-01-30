# Security considerations

## Path traversal protection (ZIP + TAR)

All audit paths flag entries that could escape the destination directory:

- Absolute paths (`/etc/passwd`)
- Drive-letter paths (`C:\\Windows\\...`)
- `..` traversal segments
- NUL bytes in filenames

These are reported as `*_PATH_TRAVERSAL` issues and treated as errors in `agent` profile.

## Symlinks

Symlink entries are reported by audits and treated as errors in `agent` profile. Normalization can drop or reject symlinks.

## Size limits and bomb mitigation

Configurable limits apply across formats:

- `maxEntries` (default 10,000)
- `maxUncompressedEntryBytes` (default 512 MiB)
- `maxTotalUncompressedBytes` (default 2 GiB)
- `maxCompressionRatio` (ZIP/GZIP only, default 1000)

## Audit-first workflows

Use `reader.audit()` to get a machine-readable report before extraction, and `reader.assertSafe()` to enforce
an agent policy. Audit checks include:

- trailing bytes after EOCD (ZIP)
- duplicate and case-colliding names
- path traversal and NUL bytes
- symlink entries
- unsupported methods/encryption
- out-of-range offsets (ZIP)
- size and ratio limits

## Profiles

- `compat`: lenient parsing (`strict: false`), warnings surfaced instead of hard failures.
- `strict`: strict parsing (`strict: true`), default limits.
- `agent`: strict parsing + conservative defaults; symlinks treated as errors, trailing bytes rejected in ZIP audits.

`assertSafe({ profile: 'agent' })` treats any audit warning as an error.

## CRC validation (ZIP)

In strict mode (default), CRC32 mismatches cause extraction to fail with `ZIP_BAD_CRC`. In non-strict mode, mismatches are recorded as warnings.

## Canonicalization / normalization

Use `normalizeToWritable()` to produce deterministic ZIP or TAR outputs with a single interpretation. Normalization
enforces safe paths, resolves duplicates/case collisions, and rebuilds metadata consistently.
