import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createCompressor,
  createDecompressor,
  getCompressionCapabilities,
  CompressionError
} from '@ismail-elkorchi/bytefold/compress';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);
const LIMIT_BYTES = 4096;

const PAYLOAD = (() => {
  const bytes = new Uint8Array(256 * 1024);
  bytes.fill(0x61);
  return bytes;
})();

const CASES: Array<{ algorithm: 'gzip' | 'deflate' | 'brotli' | 'zstd' }> = [
  { algorithm: 'gzip' },
  { algorithm: 'deflate' },
  { algorithm: 'brotli' },
  { algorithm: 'zstd' }
];

test('maxTotalDecompressedBytes enforces resource ceilings for native codecs', async () => {
  const errorSchema = await loadSchema(ERROR_SCHEMA);
  const caps = getCompressionCapabilities();

  for (const { algorithm } of CASES) {
    const support = caps.algorithms[algorithm];
    if (!support.compress || !support.decompress) continue;

    const compressed = await collect(
      readableFromBytes(PAYLOAD).pipeThrough(createCompressor({ algorithm }))
    );

    const stream = readableFromBytes(compressed).pipeThrough(
      createDecompressor({ algorithm, limits: { maxTotalDecompressedBytes: LIMIT_BYTES } })
    );
    const result = await collectUntilError(stream);

    assert.ok(result.error, `expected limit error for ${algorithm}`);
    assert.ok(result.bytes <= LIMIT_BYTES, `${algorithm} exceeded output ceiling`);
    assert.ok(result.error instanceof CompressionError, `unexpected error type for ${algorithm}`);
    assert.equal(result.error.code, 'COMPRESSION_RESOURCE_LIMIT');
    const validation = validateSchema(errorSchema, result.error.toJSON());
    assert.ok(validation.ok, validation.errors.join('\n'));
  }
});

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
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function collectUntilError(
  stream: ReadableStream<Uint8Array>
): Promise<{ bytes: number; error: unknown | null }> {
  const reader = stream.getReader();
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return { bytes: total, error: null };
      if (value) total += value.length;
    }
  } catch (err) {
    return { bytes: total, error: err };
  } finally {
    reader.releaseLock();
  }
}

function readableFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

async function loadSchema(url: URL): Promise<JsonSchema> {
  return (JSON.parse(await readFile(url, 'utf8')) as unknown) as JsonSchema;
}
