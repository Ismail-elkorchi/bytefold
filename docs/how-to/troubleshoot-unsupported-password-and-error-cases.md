# How-to: troubleshoot unsupported, password, and error cases

## Goal
Recognize the common typed failure classes when an archive cannot be opened,
audited, or normalized successfully.

## Prerequisites
- Node `>=24`
- `npm install`
- `npm run build`

## Copy/paste
```sh
node examples/troubleshoot-errors.mjs
```

Equivalent API pattern:

```ts
import { ArchiveError, ZipError, openArchive } from "@ismail-elkorchi/bytefold";

try {
  await openArchive(new TextEncoder().encode("not-an-archive"), { profile: "strict" });
} catch (error) {
  if (error instanceof ArchiveError || error instanceof ZipError) {
    console.log(JSON.stringify({
      name: error.name,
      code: error.code,
      message: error.message,
    }, null, 2));
  } else {
    throw error;
  }
}
```

## Expected output or shape
- JSON output with `name`, `code`, and `message`.
- Unsupported or malformed inputs surface stable codes such as
  `ARCHIVE_UNSUPPORTED_FORMAT`, while encrypted ZIP flows can surface
  `ZIP_PASSWORD_REQUIRED`, `ZIP_BAD_PASSWORD`, or `ZIP_AUTH_FAILED`.

## Common failure modes
- Unsupported formats are retried with random option changes instead of reading
  the reported error code.
- Password-protected archives are treated as generic corruption.
- Browser upload flows collapse typed archive failures into one generic UI
  message.

## Related reference
- [Error codes](../reference/errors.md)
- [Reader and writer options](../reference/options.md)
- [Runtime compatibility](../reference/compat.md)
