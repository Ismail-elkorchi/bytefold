# Competitive complaint matrix

## User pain → Bytefold response

| Pain class | Examples | Bytefold response | Proof |
| --- | --- | --- | --- |
| ZIP64 unsupported or limited | yauzl zip64 docs; adm-zip #201 | ZIP64 read/write + strict bounds checks | `docs/compliance.md`, `test/zip.test.ts` |
| ZIP64 extraction issues | archiverjs #1169 | End-to-end ZIP64 audits + validation | `test/zip.test.ts`, `test/audit.test.ts` |
| Central directory too large / memory blowups | archiverjs #1243 | `iterEntries()` streams CD without storing | `test/iterEntries.test.ts` |
| Remote range fetch failures | unzipper #358 | HTTP range checks + abortable reads | `test/http.test.ts`, `test/abort-progress.test.ts` |
| Deflate64 (method 9) unsupported | common zip libs | Native Deflate64 decoder | `test/deflate64.test.ts` |
| Encryption handling | node-stream-zip limitations | AES/ZipCrypto (Node) + audit | `test/encryption.test.ts`, `scripts/interop.mjs` |
| Zip-slip / path traversal | CVE-2018-1002203 | Path traversal detection + normalize | `test/zip.test.ts`, `test/audit.test.ts` |
| TAR slip / path traversal | CVE-2001-1267 | TAR path traversal audit + normalize | `test/archive.test.ts` |
| Trailing bytes / polyglots | JSZip limitations | ZIP audit flags trailing bytes | `test/audit.test.ts` |
| Huge compressed bombs | OWASP Zip Bomb | Limits + audit controls | `docs/security.md`, `test/audit.test.ts` |
| Layered archives brittle | tgz / tar.zst | Auto-detect + layering support | `test/archive.test.ts`, `docs/formats.md` |
| Common distro artifacts | tar.bz2 | Pure JS bzip2 decompression + layered TAR support | `test/bzip2.test.ts`, `docs/formats.md` |

## What Bytefold still does NOT do

- Split or multi-volume ZIP archives.
- RAR, CAB, or ISO images.
- Solid archive creation or advanced archive recovery.
- Brotli auto-detection without an explicit hint or file extension.
- XZ / tar.xz decompression (detected but unsupported).
