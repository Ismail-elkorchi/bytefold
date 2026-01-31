import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCompressor,
  createDecompressor,
  getCompressionCapabilities,
  type CompressionAlgorithm,
  type CompressionProgressEvent
} from '@ismail-elkorchi/bytefold/compress';

const encoder = new TextEncoder();
const algorithms: CompressionAlgorithm[] = ['gzip', 'deflate-raw', 'deflate', 'brotli', 'zstd'];
const input = encoder.encode('bytefold-compress-test-'.repeat(1024));
const caps = getCompressionCapabilities();

for (const algorithm of algorithms) {
  test(`compress roundtrip (${algorithm})`, async (t) => {
    const support = caps.algorithms[algorithm];
    if (!support.compress || !support.decompress) {
      t.skip(`unsupported: ${algorithm} (${support.backend})`);
      return;
    }

    const compressEvents: CompressionProgressEvent[] = [];
    const decompressEvents: CompressionProgressEvent[] = [];

    const compressor = await createCompressor({
      algorithm,
      onProgress: (ev) => compressEvents.push(ev)
    });
    const decompressor = await createDecompressor({
      algorithm,
      onProgress: (ev) => decompressEvents.push(ev)
    });

    const output = await collect(streamFromBytes(input).pipeThrough(compressor).pipeThrough(decompressor));
    assert.deepEqual(output, input);
    assertMonotonic(compressEvents, algorithm, 'compress');
    assertMonotonic(decompressEvents, algorithm, 'decompress');
  });
}

test('compress aborts with signal', async (t) => {
  const candidates = algorithms.filter(
    (algorithm) => caps.algorithms[algorithm].compress && caps.algorithms[algorithm].decompress
  );
  if (candidates.length === 0) {
    t.skip('no supported algorithms');
    return;
  }
  const algorithm = candidates[0]!;
  const controller = new AbortController();
  let aborted = false;

  const compressor = await createCompressor({
    algorithm,
    signal: controller.signal,
    onProgress: () => {
      if (!aborted) {
        aborted = true;
        controller.abort(new Error('aborted'));
      }
    }
  });

  await assert.rejects(async () => {
    await collect(
      new ReadableStream<Uint8Array>({
        pull(ctrl) {
          ctrl.enqueue(new Uint8Array(64 * 1024));
        }
      }).pipeThrough(compressor)
    );
  });
});

function streamFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function assertMonotonic(
  events: CompressionProgressEvent[],
  algorithm: CompressionAlgorithm,
  kind: CompressionProgressEvent['kind']
): void {
  let lastIn = 0n;
  let lastOut = 0n;
  for (const ev of events) {
    assert.equal(ev.algorithm, algorithm);
    assert.equal(ev.kind, kind);
    assert.ok(ev.bytesIn >= lastIn);
    assert.ok(ev.bytesOut >= lastOut);
    lastIn = ev.bytesIn;
    lastOut = ev.bytesOut;
  }
}
