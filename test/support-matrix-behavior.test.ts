import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArchiveError, createArchiveWriter, openArchive } from '@ismail-elkorchi/bytefold';
import { CompressionError, getCompressionCapabilities } from '@ismail-elkorchi/bytefold/compress';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);
const encoder = new TextEncoder();

test('support matrix: tar.br requires explicit hint', async (t) => {
  const caps = getCompressionCapabilities();
  if (!caps.algorithms.brotli.compress || !caps.algorithms.brotli.decompress) {
    t.skip('brotli not supported');
    return;
  }
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('tar.br', writable);
  await writer.add('hello.txt', encoder.encode('brotli tar'));
  await writer.close();
  const data = concatChunks(chunks);

  await assert.rejects(
    async () => {
      await openArchive(data);
    },
    (err: unknown) => err instanceof ArchiveError && err.code === 'ARCHIVE_UNSUPPORTED_FORMAT'
  );

  const reader = await openArchive(data, { format: 'tar.br' });
  assert.equal(reader.format, 'tar.br');
});

test('support matrix: capability-gated formats throw typed errors with hints', async (t) => {
  const caps = getCompressionCapabilities();
  const candidates: Array<{ algorithm: keyof typeof caps.algorithms; format: 'tar.zst' | 'tar.br' | 'tar.gz' }> = [
    { algorithm: 'zstd', format: 'tar.zst' },
    { algorithm: 'brotli', format: 'tar.br' },
    { algorithm: 'gzip', format: 'tar.gz' }
  ];
  const target = candidates.find((entry) => !caps.algorithms[entry.algorithm].decompress);
  if (!target) {
    t.skip('all compression algorithms available');
    return;
  }
  const schema = (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;

  await assert.rejects(
    async () => {
      await openArchive(new Uint8Array([0x00]), { format: target.format });
    },
    (err: unknown) => {
      if (!(err instanceof CompressionError)) return false;
      if (err.code !== 'COMPRESSION_UNSUPPORTED_ALGORITHM') return false;
      const json = err.toJSON();
      const result = validateSchema(schema, json);
      if (!result.ok) return false;
      if (!json.hint || typeof json.hint !== 'string') return false;
      if (!json.context || typeof json.context !== 'object') return false;
      return true;
    }
  );
});

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
