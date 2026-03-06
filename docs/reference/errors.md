# Error codes

Errors are stable and documented in `SPEC.md` under the error contract section.

## Error classes

- `ArchiveError`: format detection, archive-level open/write failures, or
  profile-wide safety failures such as `ARCHIVE_UNSUPPORTED_FORMAT` and
  `ARCHIVE_AUDIT_FAILED`.
- `ZipError`: ZIP-specific parsing, password, and stream-open failures such as
  `ZIP_PASSWORD_REQUIRED`, `ZIP_BAD_PASSWORD`, `ZIP_AUTH_FAILED`, and
  `ZIP_LIMIT_EXCEEDED`.

Each error includes:

- `code` for automation
- `message` for humans
- `context` for structured debugging

## Reports vs throws

- `audit()` and `normalizeToWritable()` return structured issue lists in reports.
- `assertSafe()` throws when the selected profile treats those issues as
  blocking.
- `openArchive()`, `reader.open()`, and writer operations can throw immediately
  when the format is unsupported, the password is missing/wrong, or a bounded
  pipeline fails.

## Common first-use codes

- `ARCHIVE_UNSUPPORTED_FORMAT`: byte/input detection could not identify a
  supported format.
- `ARCHIVE_AUDIT_FAILED`: `assertSafe()` rejected the archive under the chosen
  profile.
- `ARCHIVE_LIMIT_EXCEEDED` / `ZIP_LIMIT_EXCEEDED`: explicit resource ceilings
  were hit.
- `ZIP_PASSWORD_REQUIRED`: encrypted entry or archive requires a password.
- `ZIP_BAD_PASSWORD`: provided password was incorrect.
- `ZIP_AUTH_FAILED`: authenticated ZIP decryption failed integrity checks.

For a full list, see `SPEC.md` and the JSON schema in `schemas/`.
