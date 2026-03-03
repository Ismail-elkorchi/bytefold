# ARCHITECTURE

Explanation of module boundaries, data flow, and tradeoffs.

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

## Tradeoffs (why this shape)
- Pure-JS codec implementations prioritize portability and deterministic behavior
  over native-addon peak throughput.
- Runtime adapters are opt-in entrypoints to keep default imports free from
  `node:*` coupling.
- Safety profiles bias toward explicit typed failures for untrusted input rather
  than permissive best-effort extraction.

## Extension points
- Add a compression algorithm: implement codec in `src/compression/**`, register in `src/compression/streams.ts`, extend `src/compress/types.ts`, and add tests.
- Add an archive format: implement parser/writer in `src/{format}/**`, hook detection in `src/archive/**`, and add tests.
- Add XZ filters/checks: extend `src/compression/xz.ts` and fixture-backed tests.

## Forbidden couplings
- Default entrypoints must not import `node:*` at module evaluation.
- Pure-js codecs must not depend on `src/node/**`.
- Format-specific modules must not import test or script code.
- Compression core must not depend on archive orchestration.
