---
role: reference
audience: maintainers, agents, users
source_of_truth: ARCHITECTURE.md
update_triggers:
  - new module boundaries
  - new formats or codecs
  - changes to data flow or extension points
---

# ARCHITECTURE

## Module map
- `src/index.ts`: top-level archive detection and orchestration.
- `src/archive/**`: archive APIs, detection, audit, normalize, and extract workflows.
- `src/zip/**`, `src/tar/**`: format-specific parsing and writing.
- `src/compress/**`, `src/compression/**`: compression APIs and pure-js codecs (xz, bzip2, deflate64).
- `src/streams/**`: stream utilities, adapters, and emission invariants.
- `src/node/**`, `src/deno/**`, `src/bun/**`: runtime-specific adapters (opt-in entrypoints).

## Data flow (read path)
1. Input bytes/stream → `openArchive` detection.
2. Format reader parses headers and yields entries.
3. Entry `open()` returns a `ReadableStream` that composes: decompressor → limits → CRC → progress.
4. Callers consume bytes or `extractAll` writes outputs.

## Data flow (write path)
1. Writer constructs headers and entry metadata.
2. Payloads stream through compressors and into the sink.

## Extension points
- Add a compression algorithm: implement codec in `src/compression/**`, register in `src/compression/streams.ts`, extend `src/compress/types.ts`, and add tests.
- Add an archive format: implement parser/writer in `src/{format}/**`, hook detection in `src/archive/**`, and add tests.
- Add XZ filters/checks: extend `src/compression/xz.ts` and fixture-backed tests.

## Forbidden couplings
- Default entrypoints must not import `node:*` at module evaluation.
- Pure-js codecs must not depend on `src/node/**`.
- Format-specific modules must not import test or script code.
- Compression core must not depend on archive orchestration.
