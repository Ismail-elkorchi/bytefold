# Benchmarks

Bytefold ships a lightweight Node-only benchmark script for compression throughput and archive pack/unpack.

## Run

```sh
npm run bench
```

This builds the project and writes JSON results to:

```
bench/results/latest.json
```

Results are not committed.

## What is measured

- Compression throughput (gzip / deflate / deflate-raw / brotli / zstd when supported)
- Zip vs tar pack/unpack for many small files

## Interpreting results

- `compressMBps` and `decompressMBps` are throughput on the local machine.
- `packMs` and `unpackMs` measure end-to-end writer/reader behavior.
- `supported: false` means the runtime did not expose a backend for that algorithm.
