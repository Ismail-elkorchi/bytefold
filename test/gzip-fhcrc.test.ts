import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold';
import { CompressionError } from '@ismail-elkorchi/bytefold/compress';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const FIXTURE_OK = new URL('../test/fixtures/gzip-fhcrc-ok.gz', import.meta.url);
const FIXTURE_BAD = new URL('../test/fixtures/gzip-fhcrc-bad.gz', import.meta.url);
const EXPECTED = new URL('../test/fixtures/expected/hello.txt', import.meta.url);
const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);

test('gzip FHCRC passes for valid header', async () => {
  const bytes = new Uint8Array(await readFile(FIXTURE_OK));
  const expected = new Uint8Array(await readFile(EXPECTED));
  const reader = await openArchive(bytes, { format: 'gz' });
  let sawEntry = false;
  for await (const entry of reader.entries()) {
    sawEntry = true;
    const data = await collect(await entry.open());
    assert.deepEqual(data, expected);
    assert.equal(entry.name, 'hello.txt');
  }
  assert.ok(sawEntry, 'gzip fhcrc fixture missing entry');
});

test('gzip FHCRC mismatch throws typed error', async () => {
  const bytes = new Uint8Array(await readFile(FIXTURE_BAD));
  const schema = (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;
  await assert.rejects(
    () => openArchive(bytes, { format: 'gz' }),
    (err: unknown) => {
      if (!(err instanceof CompressionError)) return false;
      assert.equal(err.code, 'COMPRESSION_GZIP_BAD_HEADER');
      const json = err.toJSON();
      const result = validateSchema(schema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      return true;
    }
  );
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
