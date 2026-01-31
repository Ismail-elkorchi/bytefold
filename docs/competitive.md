# Competitive complaint matrix

| Complaint | Source | bytefold response | Proof |
| --- | --- | --- | --- |
| ZIP64 unsupported or limited | https://github.com/thejoshwolfe/yauzl#zip64-support | ZIP64 read/write supported; strict bounds checks | `docs/compliance.md`, `test/zip.test.ts` |
| ZIP64 extraction issues | https://github.com/archiverjs/node-archiver/issues/1169 | ZIP64 end-to-end tests + audit bounds | `test/zip.test.ts`, `test/audit.test.ts` |
| Memory blowups when enumerating entries | https://github.com/archiverjs/node-archiver/issues/1243 | `iterEntries()` streams central directory without storing | `test/iterEntries.test.ts` |
| ZIP64 hang on extract | https://github.com/ZJONSSON/node-unzipper/issues/358 | AbortSignal support + streaming read | `test/abort-progress.test.ts` |
| Zip-slip vulnerability | https://nvd.nist.gov/vuln/detail/CVE-2018-1002203 | Path traversal blocked + audit detection | `test/zip.test.ts`, `test/audit.test.ts` |
| TAR slip vulnerability | https://nvd.nist.gov/vuln/detail/CVE-2001-1267 | TAR path traversal audit + normalization | `test/archive.test.ts` |
| Gzip bombs / expansion abuse | https://owasp.org/www-community/attacks/Zip_Bomb | Size limits + audit controls | `docs/security.md` |
| ZIP64 write issues | https://github.com/cthackers/adm-zip/issues/201 | Zip64 write support + strict metadata | `docs/compliance.md`, `test/zip.test.ts` |
| Corrupt ZIP outputs | https://github.com/cthackers/adm-zip/issues/282 | Spec-first writer + CRC validation | `test/zip.test.ts` |
| JSZip limitations | https://stuk.github.io/jszip/documentation/limitations.html | Streaming reader + audit + strict limits | `docs/security.md`, `test/iterEntries.test.ts` |
| JSZip ZIP64 bug | https://github.com/Stuk/jszip/issues/604 | ZIP64 read/write coverage | `test/zip.test.ts` |
| AES out of scope | https://github.com/antelle/node-stream-zip#limitations | AES read/write supported (Node) | `test/encryption.test.ts`, `scripts/interop.mjs` |
