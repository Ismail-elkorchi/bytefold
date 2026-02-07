import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const FIXTURE = new URL('../test/fixtures/gzip-header-options.gz', import.meta.url);
const EXPECTED = new URL('../test/fixtures/expected/hello.txt', import.meta.url);
const AUDIT_SCHEMA = new URL('../schemas/audit-report.schema.json', import.meta.url);

test('gzip header options preserve FNAME with extra fields present', async () => {
  const bytes = new Uint8Array(await readFile(FIXTURE));
  const expected = new Uint8Array(await readFile(EXPECTED));
  const reader = await openArchive(bytes, { format: 'gz' });
  assert.equal(reader.format, 'gz');

  let sawEntry = false;
  for await (const entry of reader.entries()) {
    sawEntry = true;
    assert.equal(entry.name, 'hello.txt');
    const data = await collect(await entry.open());
    assert.deepEqual(data, expected);
  }
  assert.ok(sawEntry, 'gzip fixture missing entry');

  const auditSchema = await loadSchema(AUDIT_SCHEMA);
  const report = await reader.audit();
  const result = validateSchema(auditSchema, toJson(report));
  assert.ok(result.ok, result.errors.join('\n'));
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

async function loadSchema(url: URL): Promise<JsonSchema> {
  return (JSON.parse(await readFile(url, 'utf8')) as unknown) as JsonSchema;
}

function toJson(value: unknown): unknown {
  if (value && typeof value === 'object' && 'toJSON' in value) {
    const record = value as { toJSON?: () => unknown };
    if (record.toJSON) return record.toJSON();
  }
  return JSON.parse(JSON.stringify(value));
}
