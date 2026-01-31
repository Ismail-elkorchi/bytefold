import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

let compress;
let ZipWriter;
let ZipReader;
let TarWriter;
let TarReader;

try {
  compress = await import('../dist/compress/index.js');
  ({ ZipWriter, ZipReader } = await import('../dist/zip/index.js'));
  ({ TarWriter, TarReader } = await import('../dist/tar/index.js'));
} catch {
  console.error('[bytefold][bench] Missing dist build. Run `npm run build` first.');
  process.exit(2);
}

const { createCompressor, createDecompressor, getCompressionCapabilities } = compress;

const encoder = new TextEncoder();
const input = encoder.encode('bytefold-bench-'.repeat(1024 * 32)); // ~512 KiB
const caps = getCompressionCapabilities();

const results = {
  timestamp: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch
  },
  compression: {},
  archives: {}
};

const algorithms = ['gzip', 'deflate-raw', 'deflate', 'brotli', 'zstd'];
for (const algorithm of algorithms) {
  const support = caps.algorithms[algorithm];
  if (!support.compress || !support.decompress) {
    results.compression[algorithm] = { supported: false };
    continue;
  }

  const compressStart = performance.now();
  const compressed = await collect(streamFromBytes(input).pipeThrough(await createCompressor({ algorithm })));
  const compressMs = performance.now() - compressStart;

  const decompressStart = performance.now();
  const roundtrip = await collect(streamFromBytes(compressed).pipeThrough(await createDecompressor({ algorithm })));
  const decompressMs = performance.now() - decompressStart;

  if (!bytesEqual(input, roundtrip)) {
    console.error(`[bytefold][bench] roundtrip mismatch for ${algorithm}`);
  }

  results.compression[algorithm] = {
    supported: true,
    inputBytes: input.length,
    outputBytes: compressed.length,
    compressMs,
    decompressMs,
    compressMBps: toMBps(input.length, compressMs),
    decompressMBps: toMBps(input.length, decompressMs)
  };
}

const fileCount = 200;
const fileSize = 1024;
const files = Array.from({ length: fileCount }, (_, i) => ({
  name: `file-${i}.txt`,
  data: encoder.encode(`file-${i}-`.repeat(Math.max(1, Math.floor(fileSize / 8))))
}));

results.archives.zip = await benchArchive('zip', files, ZipWriter, ZipReader);
results.archives.tar = await benchArchive('tar', files, TarWriter, TarReader);

const outDir = path.join(process.cwd(), 'bench', 'results');
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'latest.json'), JSON.stringify(results, null, 2));

console.log('[bytefold][bench] results written to bench/results/latest.json');

async function benchArchive(kind, files, Writer, Reader) {
  const chunks = [];
  const writable = new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    }
  });

  const packStart = performance.now();
  const writer = Writer.toWritable(writable);
  for (const file of files) {
    await writer.add(file.name, file.data);
  }
  await writer.close();
  const packMs = performance.now() - packStart;

  const archiveBytes = concat(chunks);
  const unpackStart = performance.now();
  const reader = await Reader.fromUint8Array(archiveBytes);
  let entryCount = 0;
  for await (const entry of reader.iterEntries()) {
    entryCount += 1;
    if (!entry.isDirectory) {
      const stream = await reader.open(entry);
      await collect(stream);
    }
  }
  const unpackMs = performance.now() - unpackStart;

  return {
    entries: entryCount,
    totalBytes: archiveBytes.length,
    packMs,
    unpackMs
  };
}

function streamFromBytes(data) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });
}

async function collect(stream) {
  const reader = stream.getReader();
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concat(chunks);
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function toMBps(bytes, ms) {
  if (ms === 0) return 0;
  return (bytes / 1024 / 1024) / (ms / 1000);
}
