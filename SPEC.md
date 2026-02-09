---
role: spec
audience: maintainers, agents, users
source_of_truth: SPEC.md
update_triggers:
  - public API changes
  - new invariants or error codes
  - new formats, codecs, or filters
---

# SPEC

## Domain model (conceptual)
- Archive: a container of entries (files, directories, links) that can be opened, audited, normalized, and extracted.
- Compression: byte-level transforms for entry payloads or whole archives (e.g., deflate, zstd, xz).
- Audit: validation pass that reports issues without mutating data.
- Normalize: deterministic rewrite that fixes or flags issues according to a profile.

## Public API entrypoints
Snapshot enforced by `test/export-surface.test.ts` and `test/support-matrix.test.ts`.
### npm (package.json exports)
- `@ismail-elkorchi/bytefold`
- `@ismail-elkorchi/bytefold/archive`
- `@ismail-elkorchi/bytefold/compress`
- `@ismail-elkorchi/bytefold/zip`
- `@ismail-elkorchi/bytefold/tar`
- `@ismail-elkorchi/bytefold/node`
- `@ismail-elkorchi/bytefold/node/zip`
- `@ismail-elkorchi/bytefold/deno`
- `@ismail-elkorchi/bytefold/bun`
- `@ismail-elkorchi/bytefold/web`

### jsr (jsr.json exports)
- `@ismail-elkorchi/bytefold`
- `@ismail-elkorchi/bytefold/archive`
- `@ismail-elkorchi/bytefold/compress`
- `@ismail-elkorchi/bytefold/zip`
- `@ismail-elkorchi/bytefold/tar`
- `@ismail-elkorchi/bytefold/deno`
- `@ismail-elkorchi/bytefold/bun`
- `@ismail-elkorchi/bytefold/web`

## Invariants (test-linked)
1. Runtime dependencies count is zero; package is ESM-only and requires Node >= 24. (tests: `test/repo-invariants.test.ts`)
2. TypeScript strict mode remains enabled. (tests: `test/repo-invariants.test.ts`)
3. Default entrypoints do not import `node:*` at module evaluation. (tests: `test/repo-invariants.test.ts`)
4. Emitted `Uint8Array` chunks are immutable after enqueue, including under chunking adversary inputs. (tests: `test/xz-aliasing.test.ts`, `test/deflate64-aliasing.test.ts`, `test/streaming-invariance.test.ts`)
5. Streaming decompression is invariant to input chunking for gzip, bzip2, and xz (including BCJ). (tests: `test/streaming-invariance.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
6. Mutation harness applies deterministic byte-level mutations across bytes/stream/file/url boundaries for zip/tar/gz/bz2/xz inputs; failures surface typed errors with schema-valid `toJSON()`, successes return schema-valid audits. (tests: `test/mutation-harness.test.ts`)
7. Third-party ZIP and TAR fixtures open, list, and audit cleanly with provenance + size bounds. (tests: `test/zip-tar-thirdparty.test.ts`, `test/third-party-provenance.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
8. Seekable ZIP preflight enforces EOCD/central-directory ceilings before full buffering, rejects multi-disk archives, and stays bounded in HTTP range requests/bytes. (tests: `test/zip-seekable-preflight.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
9. Seekable ZIP over HTTP Range is used for list + single-entry extract and stays bounded without full downloads when Range is supported (tests assert total bytes ≤ ceil(size/16) and request count ≤ 1 + ceil((size/16)/64KiB) + 2). (tests: `test/zip-url-seekable-budget.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
10. HTTP Range sessions pin validators; If-Range is sent only with strong ETags (never weak ETag/Last-Modified), 200 responses to ranged requests with If-Range are treated as resource changed, and Content-Encoding responses are rejected. Snapshot policy require-strong-etag fails without a strong validator, while best-effort proceeds without If-Range. (specs: `specs/http/rfc9110-if-range.md`, `specs/http/rfc9110-accept-encoding.md`; tests: `test/zip-url-seekable-budget.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
11. HTTP header-only range failures fail fast by aborting request bodies before payload consumption; slow-body adversarial servers remain bounded (`<= 4096` bytes served) for range-unsupported and content-encoding rejection paths. (tests: `test/zip-url-seekable-budget.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
12. HTTP 206 bodies must match the requested range length exactly; truncated or overrun bodies fail with typed bad-response errors. (tests: `test/zip-url-seekable-budget.test.ts`, `test/bun.smoke.ts`, `test/deno.smoke.ts`)
13. Gzip header options (FEXTRA/FNAME/FCOMMENT) are parsed; FNAME yields the entry name even when extra fields are present, consistently across runtimes. (tests: `test/gzip-header-options.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
14. Gzip FHCRC headers are validated when present; mismatches throw typed errors. (tests: `test/gzip-fhcrc.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
15. Decompression output ceilings enforce `maxTotalDecompressedBytes` for gzip/deflate/brotli/zstd and fail with `COMPRESSION_RESOURCE_LIMIT` without emitting beyond the limit. (tests: `test/compression-resource-limits.test.ts`)
16. XZ Index VLI parsing is chunk-boundary safe, including multi-byte uncompressed sizes. (tests: `test/xz-vli-boundaries.test.ts`, `test/streaming-invariance.test.ts`)
17. XZ streaming decode supports padding + concatenation and validates checks (none/CRC32/CRC64/SHA-256). (tests: `test/xz-utils-conformance.test.ts`, `test/xz-bcj-filters.test.ts`)
18. XZ supports filters LZMA2, Delta, BCJ x86/PowerPC/IA64/ARM/ARM-Thumb/SPARC/ARM64/RISC-V; unsupported filters/checks throw typed errors. (tests: `test/xz-utils-conformance.test.ts`, `test/xz-bcj-filters.test.ts`, `test/xz-thirdparty.test.ts`)
19. Mixed XZ filter chains (Delta -> BCJ -> LZMA2) decode correctly with filters applied in reverse order. (tests: `test/xz-mixed-filters.test.ts`, `test/xz-seekable-preflight.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
20. XZ BCJ filters enforce property sizing/alignment and cannot be the last filter. Size-changing filters cannot be non-last. (tests: `test/xz-bcj-filters.test.ts`)
21. XZ BCJ start offset properties are stream-relative and reset at each concatenated stream. Properties are honored per block. (tests: `test/xz-bcj-filters.test.ts`, `test/xz-concat-bcj.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
22. XZ corruption yields typed errors and extraction is atomic for corrupted streams. (tests: `test/xz.test.ts`, `test/xz-utils-conformance.test.ts`)
23. XZ resource ceilings are enforced (buffer + dictionary + Index limits). (tests: `test/xz-utils-conformance.test.ts`, `test/xz-index-limits.test.ts`)
24. XZ preflight scanning bounds Index parsing without per-record allocations. (tests: `test/xz-index-limits.test.ts`)
25. Seekable XZ preflight enforces Index limits before full buffering. (tests: `test/xz-seekable-preflight.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
26. Seekable XZ preflight enforces dictionary limits before full buffering (bounded block-header scan). (tests: `test/xz-seekable-preflight.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
27. Seekable XZ preflight HTTP failures map to specific `ARCHIVE_HTTP_*` codes with `context.httpCode` preserving the originating HTTP failure class. (tests: `test/xz-http-error-mapping.test.ts`, `test/xz-seekable-preflight.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
28. Seekable XZ preflight success path is bounded in HTTP range requests/bytes and reports incomplete scans when block header limits are exceeded without blocking decode. (tests: `test/xz-seekable-preflight.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
29. Report + error JSON schemas are versioned and validated. (tests: `test/schema-contracts.test.ts`, `test/json-safety.test.ts`)
30. Public export surface matches the manifest snapshot. (tests: `test/export-surface.test.ts`)
31. TypeScript declaration surface for every npm/jsr public entrypoint matches the committed snapshot manifest; intentional surface breaks in ALPHA require snapshot updates and explicit CHANGELOG entries, and V1+ will introduce stricter migration discipline. (tests: `test/type-surface.test.ts`)
32. npm pack payload obeys allowlist/denylist policy: runtime artifacts plus contract metadata (`SPEC.md`) and JSON schemas (`schemas/*.json`) only; repo-internal indexes (`docs/REPO_INDEX.*`) and internal sources are excluded. (tests: `test/packaging-contract.test.ts`, `scripts/verify-pack.mjs`)
33. Normalize safe mode is deterministic and lossless mode preserves bytes where documented. (zip/tar idempotent.) (tests: `test/normalize.test.ts`, `test/audit-normalize-proof.test.ts`)
34. `extractAll` blocks path traversal. (tests: `test/zip.test.ts`)
35. `openArchive` auto-detects documented formats; tar.br requires an explicit hint. (tests: `test/archive.test.ts`, `test/bzip2.test.ts`, `test/xz.test.ts`, `test/tar-xz.test.ts`)
36. Context index artifacts are deterministic and bounded: `npm run context:index` produces `docs/REPO_INDEX.md` (<= 250 KiB) plus `docs/REPO_INDEX.md.sha256` with stable sorting and no timestamps. (tests: `test/context-tools.test.ts`)
37. Error JSON `context` never shadows top-level keys (`schemaVersion`, `name`, `code`, `message`, `hint`, `context`, plus top-level optionals such as `entryName`, `method`, `offset`, `algorithm`). (tests: `test/error-contracts.test.ts`, `test/error-json-ambiguity.test.ts`, `test/schema-contracts.test.ts`)
38. Profile/limits precedence is deterministic across readers and decompressor setup: profile selects defaults, explicit `limits` override only provided fields, and explicit decompressor scalar limits override `limits` for matching knobs. (tests: `test/option-precedence.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
39. openArchive(...) accepts Blob/File inputs (inputKind: "blob"); ZIP on Blob is seekable via random access (slice reads) while non-ZIP Blob inputs are bounded by input limits. (tests: `test/archive.test.ts`, `test/web-adapter.test.ts`, `test/schema-contracts.test.ts`)
40. Web adapter URL inputs (@ismail-elkorchi/bytefold/web) always full-fetch bytes (no HTTP range sessions); the fetch path enforces input-size limits and preserves inputKind: "url". (tests: `test/web-adapter.test.ts`)
41. Browser-facing entrypoint stays web-bundle safe: `npm run web:check` bundles `web/mod.ts` for `platform=browser`, rejects `node:*` imports, and is deterministic across runs. (tests: `test/web-check.test.ts`, `test/repo-invariants.test.ts`)
42. Web entrypoint writer roundtrips are contract-backed: ZIP (store-only) and TAR archives written to Web `WritableStream` sinks can be reopened from Blob via `openArchive(...)`, preserve entry names/bytes, and remain safe under `audit` + deterministic `normalizeToWritable`. (tests: `test/web-writer-roundtrip.test.ts`)
43. TAR octal parsing uses null-terminated UTF-8 decoding without regex backtracking and preserves legacy truncation semantics on representative + adversarial long inputs. (tests: `test/null-terminated-utf8.test.ts`, `test/archive.test.ts`, `test/tar-xz.test.ts`)
44. XZ fixture expectations avoid committed ELF binary outputs by pinning deterministic digest/size assertions for BCJ payload verification. (tests: `test/xz-utils-conformance.test.ts`, `test/xz-thirdparty.test.ts`)
45. Web adapter URL full-fetch overflow paths are fail-fast and bounded: `maxInputBytes` over-limit responses reject with `RangeError`, cancel slow response streams before full transfer, and never use HTTP Range requests. (tests: `test/web-adapter.test.ts`)

## Gzip support details
- Header CRC (FHCRC) is validated per RFC 1952 (`https://www.rfc-editor.org/rfc/rfc1952`). (tests: `test/gzip-fhcrc.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)

## XZ support details
- Checks supported: none (0x00), CRC32 (0x01), CRC64 (0x04), SHA-256 (0x0A). (tests: `test/xz-utils-conformance.test.ts`, `test/xz-bcj-filters.test.ts`, `test/xz-thirdparty.test.ts`)
- Filters supported: LZMA2 (0x21), Delta (0x03), BCJ x86 (0x04), PowerPC (0x05), IA64 (0x06), ARM (0x07), ARM-Thumb (0x08), SPARC (0x09), ARM64 (0x0A), RISC-V (0x0B). (tests: `test/xz-utils-conformance.test.ts`, `test/xz-bcj-filters.test.ts`, `test/xz-thirdparty.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- BCJ filter properties are size 0 or 4 bytes with alignment enforced; BCJ filters cannot be last. (tests: `test/xz-bcj-filters.test.ts`)
- Mixed chains (Delta -> BCJ -> LZMA2) are supported; non-LZMA2 filters apply in reverse order during decode. (tests: `test/xz-mixed-filters.test.ts`)
- BCJ start offsets are interpreted per stream (reset at concatenation) and applied as provided in filter properties. (tests: `test/xz-bcj-filters.test.ts`, `test/xz-concat-bcj.test.ts`)

## XZ Filter IDs — Sources of Truth
- Filter IDs 0x04..0x09 are grounded in `specs/xz-file-format.txt` (Filter IDs table).
- Filter IDs 0x0A (ARM64) and 0x0B (RISC-V) are grounded in `specs/xz-filter-ids.md`.

## Support matrix (format × operation × runtime)
Legend: ✅ supported · ❌ unsupported (error code in cell) · ⚠️ explicit hint required · 🟦 capability-gated (throws `COMPRESSION_UNSUPPORTED_ALGORITHM` when missing).

### Node (>=24)
| Format | Detect | List | Audit | Extract | Normalize | Write |
| --- | --- | --- | --- | --- | --- | --- |
| zip | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| tar | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| tgz / tar.gz | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| gz | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ✅ |
| tar.bz2 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| bz2 | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| tar.xz | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| xz | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| tar.zst | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| zst | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ✅ |
| tar.br | ⚠️ (format: `tar.br` or filename) | ✅ | ✅ | ✅ | ✅ | ✅ |
| br | ⚠️ (format: `br` or filename) | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ✅ |

### Deno
| Format | Detect | List | Audit | Extract | Normalize | Write |
| --- | --- | --- | --- | --- | --- | --- |
| zip | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| tar | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| tgz / tar.gz | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| gz | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ✅ |
| tar.bz2 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| bz2 | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| tar.xz | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| xz | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| tar.zst | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) |
| zst | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) |
| tar.br | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) |
| br | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) | ❌ (`COMPRESSION_UNSUPPORTED_ALGORITHM`) |

### Bun
| Format | Detect | List | Audit | Extract | Normalize | Write |
| --- | --- | --- | --- | --- | --- | --- |
| zip | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| tar | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| tgz / tar.gz | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| gz | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ✅ |
| tar.bz2 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| bz2 | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| tar.xz | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| xz | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| tar.zst | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| zst | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ✅ |
| tar.br | ⚠️ (format: `tar.br` or filename) | ✅ | ✅ | ✅ | ✅ | ✅ |
| br | ⚠️ (format: `br` or filename) | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ✅ |

### Web (Browser)
| Format | Detect | List | Audit | Extract | Normalize | Write |
| --- | --- | --- | --- | --- | --- | --- |
| zip | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| tar | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| tgz / tar.gz | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| gz | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ✅ |
| tar.bz2 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| bz2 | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| tar.xz | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| xz | ✅ | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | ❌ (`ARCHIVE_UNSUPPORTED_FORMAT`) |
| tar.zst | 🟦 | 🟦 | 🟦 | 🟦 | 🟦 | 🟦 |
| zst | 🟦 | 🟦 | 🟦 | 🟦 | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | 🟦 |
| tar.br | ⚠️ (format: `tar.br` or filename; 🟦 on runtimes without brotli streams) | ✅ | ✅ | ✅ | ✅ | 🟦 |
| br | ⚠️ (format: `br` or filename; 🟦 on runtimes without brotli streams) | ✅ | ✅ | ✅ | ❌ (`ARCHIVE_UNSUPPORTED_FEATURE`) | 🟦 |

Matrix proofs: `test/archive.test.ts`, `test/bun.smoke.ts`, `test/deno.smoke.ts`, `test/xz.test.ts`, `test/bzip2.test.ts`, `test/tar-xz.test.ts`, `test/single-file-formats.test.ts`, `test/archive-writer-proof.test.ts`, `test/audit-normalize-proof.test.ts`, `test/support-matrix-behavior.test.ts`, `test/support-matrix.test.ts`, `test/web-adapter.test.ts`, `test/web-writer-roundtrip.test.ts`.
Write proofs: `test/archive-writer-proof.test.ts`, `test/archive.test.ts`, `test/bun.smoke.ts`, `test/deno.smoke.ts`, `test/web-writer-roundtrip.test.ts`.
Write-negative proofs: `test/archive-writer-proof.test.ts`, `test/deno.smoke.ts`.

```json support-matrix
{
  "formats": [
    "zip",
    "tar",
    "tgz",
    "tar.gz",
    "gz",
    "bz2",
    "tar.bz2",
    "zst",
    "tar.zst",
    "br",
    "tar.br",
    "xz",
    "tar.xz"
  ],
  "operations": ["detect", "list", "audit", "extract", "normalize", "write"],
  "runtimes": ["node", "deno", "bun", "web"]
}
```

## Web runtime notes
- Entry point: `@ismail-elkorchi/bytefold/web` / `./web`.
- Supported input kinds in the web adapter: `Uint8Array`, `ArrayBuffer`, `ReadableStream<Uint8Array>`, `Blob`/`File`, and `http(s)` URL.
- URL behavior in web adapter: always full-fetch response bytes before archive detection/opening; no seekable HTTP range session is attempted in web adapter by design. `maxInputBytes` is enforced both from `Content-Length` and during streaming reads, with over-limit slow-body responses canceled before full transfer. (tests: `test/web-adapter.test.ts`)
- ZIP on Blob uses seekable random access (`blob.slice(start, end).arrayBuffer()`), so listing/extracting ZIP from Blob stays bounded by seek budget and avoids full Blob buffering. (tests: `test/web-adapter.test.ts`)
- Web write roundtrip contract: ZIP (store-only mode) and TAR can be created through the web entrypoint into pure Web `WritableStream` sinks, wrapped in Blob, and reopened with matching entry names/bytes plus safe audit/normalize behavior. (tests: `test/web-writer-roundtrip.test.ts`)
- XZ seekable preflight over Blob is not implemented in this iteration; Blob XZ paths use bounded full-buffer input handling and existing decode-time resource ceilings. (tests: `test/web-adapter.test.ts`, `test/resource-ceilings.test.ts`)
- Compression capability reporting for web runtime:
  - `getCompressionCapabilities()` probes `CompressionStream` and `DecompressionStream` constructor acceptance independently for algorithm strings `gzip`, `deflate`, `deflate-raw`, `brotli`, and `zstd`;
  - each algorithm reports `compress` and `decompress` truthfully per constructor acceptance; unsupported modes surface `COMPRESSION_UNSUPPORTED_ALGORITHM` when requested;
  - pure-JS decode support remains for `bzip2` and `xz`;
  - when either web compression constructor is missing, `notes` includes an explicit missing-constructor message. (tests: `test/compress-runtime-web.test.ts`, `test/support-matrix-behavior.test.ts`, `test/schema-contracts.test.ts`)
- Runtime detection for capabilities uses `runtime: "web"` when Bun/Deno/Node markers are absent and either web compression global exists (`CompressionStream` or `DecompressionStream`). (tests: `test/compress-runtime-web.test.ts`, `test/schema-contracts.test.ts`)

## Single-file compressed formats: entry naming
Naming is deterministic and sanitized to a single path segment. (tests: `test/single-file-formats.test.ts`)
- Inputs with a filename hint (file path or URL): use the final path segment, strip the compression extension, and return `name` or `name.tar` for `.tar.*` variants.
- Inputs without a filename hint (bytes/streams): default to `data`, except gzip may use a header FNAME if present.
- Gzip header options: FEXTRA and FCOMMENT fields are skipped per RFC1952 and do not block FNAME parsing. (tests: `test/gzip-header-options.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- Gzip FNAME: used only after sanitization (basename only; NUL, empty, `.`/`..` rejected). If rejected or missing, fall back to filename or `data`.

## Normalization determinism
- Deterministic normalization (`isDeterministic: true`) emits stable bytes for zip and tar; normalizing an already normalized archive yields byte-identical output. (tests: `test/audit-normalize-proof.test.ts`)
- For tar-wrapped compressed formats, normalization produces a deterministic tar stream and preserves entry names + contents. (tests: `test/audit-normalize-proof.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)

## Ambiguity policy (normalize safe mode)
- Collision key pipeline: path normalization (slashes + dot segments) → `normalize('NFC')` → full Unicode case folding (from `specs/unicode/CaseFolding-17.0.0.txt`, statuses C+F, T excluded) → `normalize('NFC')`. (tests: `test/unicode-collision.test.ts`, `test/casefold-collision.test.ts`)
- Duplicate paths: error (tar → `ARCHIVE_NAME_COLLISION` + `TAR_DUPLICATE_ENTRY`, zip → `ZIP_NAME_COLLISION` + `ZIP_DUPLICATE_ENTRY`). (tests: `test/ambiguous-fixtures.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- Case-fold collisions: error (tar → `ARCHIVE_NAME_COLLISION` + `TAR_CASE_COLLISION`, zip → `ZIP_NAME_COLLISION` + `ZIP_CASE_COLLISION`). (tests: `test/ambiguous-fixtures.test.ts`, `test/casefold-collision.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- Unicode normalization collisions (NFC): error (tar → `ARCHIVE_NAME_COLLISION` + `TAR_UNICODE_COLLISION`, zip → `ZIP_NAME_COLLISION` + `ZIP_UNICODE_COLLISION`). (tests: `test/unicode-collision.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- Directory/file kind conflict (`dir` vs `dir/`): allowed; entries remain distinct after normalization. (tests: `test/ambiguous-fixtures.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- Symlinks: rejected in normalize safe mode (tar → `ARCHIVE_UNSUPPORTED_FEATURE` + `TAR_SYMLINK_PRESENT`, zip → `ZIP_SYMLINK_DISALLOWED`). (tests: `test/ambiguous-fixtures.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`, `test/error-contracts.test.ts`)
- Hardlinks (tar `link` entries): rejected in normalize safe mode (`ARCHIVE_UNSUPPORTED_FEATURE` + `TAR_UNSUPPORTED_ENTRY`). (tests: `test/ambiguous-fixtures.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- Path normalization: backslashes are normalized to `/`, `.` segments and repeated slashes are removed; absolute paths, drive-letter prefixes, and `..` segments are rejected with path traversal errors. (tests: `test/ambiguous-fixtures.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)

## Security model (name collisions)
- Unicode normalization collisions are rejected in audit/normalize/extract because filesystem normalization differs across platforms, and accepting them can cause nondeterministic overwrites. (tests: `test/unicode-collision.test.ts`)

## Concatenation semantics (gzip, bzip2)
- Gzip concatenated members decode sequentially across Node, Deno, and Bun. (tests: `test/single-file-formats.test.ts`, `test/bun.smoke.ts`, `test/deno.smoke.ts`)
- Bzip2 concatenated streams decode sequentially across runtimes. (tests: `test/single-file-formats.test.ts`, `test/bun.smoke.ts`, `test/deno.smoke.ts`)

## Resource ceilings
- Defaults (single source: `src/limits.ts`): `maxXzDictionaryBytes = 64 MiB` (agent profile: 32 MiB), `maxXzBufferedBytes = 1 MiB`, `maxXzIndexRecords = 1,000,000` (agent profile: 200,000), `maxXzIndexBytes = 64 MiB` (agent profile: 16 MiB), `maxXzPreflightBlockHeaders = 1024` (agent profile: 256), `maxZipCentralDirectoryBytes = 64 MiB` (agent profile: 16 MiB), `maxZipCommentBytes = 65,535` (agent profile: 16,384), `maxZipEocdSearchBytes = 65,558`, `maxBzip2BlockSize = 9`. (tests: `test/resource-ceilings.test.ts`, `test/resource-defaults.test.ts`, `test/xz-index-limits.test.ts`, `test/xz-seekable-preflight.test.ts`, `test/zip-seekable-preflight.test.ts`)
- `maxXzPreflightBlockHeaders` bounds seekable dictionary preflight; `0` disables block-header scanning and yields `COMPRESSION_RESOURCE_PREFLIGHT_INCOMPLETE` (info). (tests: `test/xz-seekable-preflight.test.ts`)
- Rationale: XZ Index fields are encoded as VLIs up to 63 bits (`specs/xz-file-format.txt`), so record counts and index sizes can be arbitrarily large; the defaults cap scan time/space while allowing typical archives. (tests: `test/xz-index-limits.test.ts`)
- XZ Index VLI decoding is streaming-safe even when VLI bytes split across chunks. (tests: `test/xz-vli-boundaries.test.ts`)
- Overrides: ceilings are configurable via `limits` in `openArchive(...)`, `ArchiveReader.audit(...)`, and `ArchiveReader.normalizeToWritable(...)`, and via `limits` in `createDecompressor(...)`. (tests: `test/resource-ceilings.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- Precedence rules (profile vs limits):
  - `openArchive(...)`: `profile` chooses reader defaults (`strict` mode + default limits), then `limits` overrides only the specified fields; unspecified fields stay on profile defaults. (tests: `test/option-precedence.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
  - `ZipReader` / `TarReader` construction: same rule as `openArchive` because the constructors resolve `profile` defaults first, then merge explicit `limits` field-by-field, and `isStrict` (if set) overrides profile strictness. (tests: `test/option-precedence.test.ts`)
  - `createDecompressor(...)`: explicit scalar knobs (`maxOutputBytes`, `maxCompressionRatio`, `maxDictionaryBytes`, `maxBufferedInputBytes`) take precedence over their `limits` counterparts; remaining values come from `limits`; `profile` still controls behavior independently (for example, unsupported XZ checks in strict vs compat). (tests: `test/option-precedence.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`, `test/xz-utils-conformance.test.ts`)
  - `createArchiveWriter(...)`: no `profile`/`limits` API exists for writer creation; precedence is not applicable. (tests: `test/archive.test.ts`, `test/archive-writer-proof.test.ts`)
- Audit preflight: bzip2 block size and xz dictionary size are checked from headers and reported as `COMPRESSION_RESOURCE_LIMIT` without full decompression. (tests: `test/resource-ceilings.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`, `test/xz-seekable-preflight.test.ts`)
- `maxTotalDecompressedBytes` enforces output ceilings for gzip/deflate/brotli/zstd with `COMPRESSION_RESOURCE_LIMIT` and no output beyond the limit. (tests: `test/compression-resource-limits.test.ts`)

## Concatenation and resource ceilings
- XZ: preflight scans concatenated streams using stream headers + Index records (no payload decompression), applies Index ceilings across the concatenation, and scans Block Headers to enforce dictionary limits up to `maxXzPreflightBlockHeaders` per stream. If block count exceeds the limit, audit emits `COMPRESSION_RESOURCE_PREFLIGHT_INCOMPLETE` (info) with `requiredBlockHeaders` + `limitBlockHeaders`, and dictionary limits remain enforced during decode. (tests: `test/resource-ceilings.test.ts`, `test/xz-index-limits.test.ts`, `test/xz-seekable-preflight.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- XZ preflight scanning is O(1) memory with respect to Index record count (no per-record arrays). (tests: `test/xz-index-limits.test.ts`)
- Bzip2: preflight only inspects the first member; audit emits `COMPRESSION_RESOURCE_PREFLIGHT_INCOMPLETE` when bzip2 limits are in effect, and concatenated members are enforced during decode. (tests: `test/resource-ceilings.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- Seekable XZ preflight: for file paths or HTTP Range URLs, index + dictionary limits run before full buffering; HTTP failures map to `ARCHIVE_HTTP_*` codes with preserved `context.httpCode`. (tests: `test/xz-http-error-mapping.test.ts`, `test/xz-seekable-preflight.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- Seekable ZIP preflight: for file paths or HTTP Range URLs, EOCD/central-directory limits run before full buffering; Range is required for HTTP preflight; multi-disk archives are rejected. (tests: `test/zip-seekable-preflight.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)
- HTTP Range random access: validators (ETag/Last-Modified) are pinned, `If-Range` is used only with strong ETags, header-only failures abort before body consumption, content codings are rejected, and 206 body length must exactly match the requested range. (specs: `specs/http/rfc9110-if-range.md`, `specs/http/rfc9110-accept-encoding.md`; tests: `test/zip-url-seekable-budget.test.ts`, `test/deno.smoke.ts`, `test/bun.smoke.ts`)

## Error model
- Stable error classes: `ZipError`, `CompressionError`, `ArchiveError`.
- Stable error codes are defined in `src/errors.ts`, `src/compress/errors.ts`, and `src/archive/errors.ts`.
- Error JSON includes `schemaVersion: "1"` plus `hint` and `context`, and serializes as plain objects with string/number fields only.
- Error JSON context policy: `context` MUST NOT duplicate any top-level key name. Keys that are top-level in an error payload (`schemaVersion`, `name`, `code`, `message`, `hint`, `context`, plus optional top-level fields like `entryName`, `method`, `offset`, `algorithm`) are stripped from `context` during serialization so machine consumers have one canonical location per fact. (tests: `test/error-json-ambiguity.test.ts`, `test/error-contracts.test.ts`)
- JSON schema: `schemas/error.schema.json`. (tests: `test/schema-contracts.test.ts`, `test/error-contracts.test.ts`)

## Report model
- Reports are JSON-safe objects with `schemaVersion: "1"` and primitive fields only.
- `ArchiveDetectionReport`, `ArchiveAuditReport`, `ArchiveNormalizeReport`, and `CompressionCapabilities` use numbers/strings/arrays only; no `bigint`.
- Any report `toJSON()` implementation MUST return JSON-safe data.
- JSON schemas: `schemas/detection-report.schema.json`, `schemas/audit-report.schema.json`, `schemas/normalize-report.schema.json`, `schemas/capabilities-report.schema.json`. (tests: `test/schema-contracts.test.ts`)

## Schema validation
Supported JSON Schema subset (enforced by `test/schema-contracts.test.ts` and `test/schema-validator.ts`): `type`, `required`, `properties`, `enum`, `items`, `additionalProperties`.
