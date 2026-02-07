import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArchiveError, createArchiveWriter, openArchive, type ArchiveOpenOptions } from '@ismail-elkorchi/bytefold';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const encoder = new TextEncoder();

test('audit + normalize roundtrip for zip', async () => {
  const zipBytes = await buildArchive('zip', [
    { name: 'alpha.txt', data: encoder.encode('alpha') },
    { name: 'bin.dat', data: new Uint8Array([1, 2, 3]) }
  ]);

  const reader = await openArchive(zipBytes);
  const originalEntries = await collectEntries(reader);
  const audit = await reader.audit({ profile: 'agent' });
  assert.equal(audit.ok, true);

  const { bytes: normalizedBytes, report } = await normalizeArchive(reader);
  assert.equal(report.ok, true);
  const normalized = await openArchive(normalizedBytes);
  assert.equal(normalized.format, 'zip');
  const normalizedAudit = await normalized.audit({ profile: 'agent' });
  assert.equal(normalizedAudit.ok, true);
  const normalizedEntries = await collectEntries(normalized);
  assert.deepEqual(normalizedEntries, originalEntries);
});

test('audit + normalize roundtrip for tar', async () => {
  const tarBytes = await buildArchive('tar', [
    { name: 'hello.txt', data: encoder.encode('hello tar') },
    { name: 'beta.bin', data: new Uint8Array([9, 8, 7]) }
  ]);

  const reader = await openArchive(tarBytes);
  const originalEntries = await collectEntries(reader);
  const audit = await reader.audit({ profile: 'agent' });
  assert.equal(audit.ok, true);

  const { bytes: normalizedBytes, report } = await normalizeArchive(reader);
  assert.equal(report.ok, true);
  const normalized = await openArchive(normalizedBytes);
  assert.equal(normalized.format, 'tar');
  const normalizedAudit = await normalized.audit({ profile: 'agent' });
  assert.equal(normalizedAudit.ok, true);
  const normalizedEntries = await collectEntries(normalized);
  assert.deepEqual(normalizedEntries, originalEntries);
});

test('audit + normalize roundtrip for compressed tar formats', async () => {
  const tgzBytes = await buildArchive('tgz', [{ name: 'hello.txt', data: encoder.encode('tgz data') }]);

  const cases: Array<{ name: string; bytes: Uint8Array; options?: ArchiveOpenOptions }> = [
    { name: 'tgz', bytes: tgzBytes },
    { name: 'tar.bz2', bytes: await readFixture('fixture.tar.bz2') },
    { name: 'tar.xz', bytes: await readFixture('fixture.tar.xz') },
    { name: 'tar.zst', bytes: await readFixture('fixture.tar.zst') },
    {
      name: 'tar.br',
      bytes: await readFixture('fixture.tar.br'),
      options: { format: 'tar.br', filename: 'fixture.tar.br' }
    }
  ];

  for (const entry of cases) {
    const reader = await openArchive(entry.bytes, entry.options);
    const originalEntries = await collectEntries(reader);
    const audit = await reader.audit({ profile: 'agent' });
    assert.equal(audit.ok, true, `${entry.name} audit failed`);

    const { bytes: normalizedBytes, report } = await normalizeArchive(reader);
    assert.equal(report.ok, true, `${entry.name} normalize failed`);
    const normalized = await openArchive(normalizedBytes);
    assert.equal(normalized.format, 'tar');
    const normalizedAudit = await normalized.audit({ profile: 'agent' });
    assert.equal(normalizedAudit.ok, true, `${entry.name} normalized audit failed`);
    const normalizedEntries = await collectEntries(normalized);
    assert.deepEqual(normalizedEntries, originalEntries, `${entry.name} normalize roundtrip mismatch`);
  }
});

test('single-file formats audit and normalize unsupported', async () => {
  const errorSchema = (await loadSchema('error.schema.json')) as JsonSchema;
  const expectedHello = new TextDecoder().decode(await readFile(new URL('../test/fixtures/expected/hello.txt', import.meta.url)));
  const cases: Array<{ name: string; bytes: Uint8Array; options?: ArchiveOpenOptions; expected: string }> = [
    { name: 'gz', bytes: await readFixture('hello.txt.gz'), options: { filename: 'hello.txt.gz' }, expected: expectedHello },
    { name: 'bz2', bytes: await readFixture('hello.txt.bz2'), options: { filename: 'hello.txt.bz2' }, expected: 'hello bzip2\n' },
    { name: 'xz', bytes: await readFixture('hello.txt.xz'), options: { filename: 'hello.txt.xz' }, expected: 'hello from bytefold\n' },
    {
      name: 'br',
      bytes: await readFixture('hello.txt.br'),
      options: { format: 'br', filename: 'hello.txt.br' },
      expected: expectedHello
    },
    { name: 'zst', bytes: await readFixture('hello.txt.zst'), options: { filename: 'hello.txt.zst' }, expected: expectedHello }
  ];

  for (const entry of cases) {
    const reader = await openArchive(entry.bytes, entry.options);
    const audit = await reader.audit({ profile: 'agent' });
    assert.equal(audit.ok, true, `${entry.name} audit failed`);
    const entries = await collectEntries(reader);
    const values = Object.values(entries);
    assert.equal(values.length, 1);
    const text = new TextDecoder().decode(values[0]!);
    assert.equal(text, entry.expected);

    await assertNormalizeUnsupported(reader, errorSchema);
  }
});

test('normalize is idempotent for zip and tar', async () => {
  const zipBytes = await buildArchive('zip', [{ name: 'alpha.txt', data: encoder.encode('alpha') }]);
  const tarBytes = await buildArchive('tar', [{ name: 'hello.txt', data: encoder.encode('hello tar') }]);

  const firstZip = await normalizeBytes(zipBytes);
  const secondZip = await normalizeBytes(firstZip);
  assert.deepEqual(secondZip, firstZip);

  const firstTar = await normalizeBytes(tarBytes);
  const secondTar = await normalizeBytes(firstTar);
  assert.deepEqual(secondTar, firstTar);
});

test('normalize roundtrip preserves entry names and contents', async () => {
  const zipBytes = await buildArchive('zip', [
    { name: 'alpha.txt', data: encoder.encode('alpha') },
    { name: 'beta.txt', data: encoder.encode('beta') }
  ]);
  const tarBytes = await buildArchive('tar', [
    { name: 'hello.txt', data: encoder.encode('hello tar') },
    { name: 'data.bin', data: new Uint8Array([5, 6, 7]) }
  ]);

  await assertNormalizeRoundtrip(zipBytes);
  await assertNormalizeRoundtrip(tarBytes);
});

async function buildArchive(
  format: 'zip' | 'tar' | 'tgz',
  entries: Array<{ name: string; data: Uint8Array }>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter(format, writable);
  for (const entry of entries) {
    await writer.add(entry.name, entry.data);
  }
  await writer.close();
  return concatChunks(chunks);
}

async function normalizeArchive(reader: {
  normalizeToWritable?: (writable: WritableStream<Uint8Array>, options?: { isDeterministic?: boolean }) => Promise<unknown>;
}): Promise<{ report: { ok: boolean }; bytes: Uint8Array }> {
  const normalizeToWritable = reader.normalizeToWritable?.bind(reader);
  if (!normalizeToWritable) throw new Error('normalizeToWritable missing');
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const report = (await normalizeToWritable(writable, { isDeterministic: true })) as { ok: boolean };
  return { report, bytes: concatChunks(chunks) };
}

async function normalizeBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = await openArchive(bytes);
  const { bytes: normalized } = await normalizeArchive(reader);
  return normalized;
}

async function assertNormalizeRoundtrip(bytes: Uint8Array): Promise<void> {
  const reader = await openArchive(bytes);
  const originalEntries = await collectEntries(reader);
  const { bytes: normalizedBytes } = await normalizeArchive(reader);
  const normalized = await openArchive(normalizedBytes);
  const audit = await normalized.audit({ profile: 'agent' });
  assert.equal(audit.ok, true);
  const normalizedEntries = await collectEntries(normalized);
  assert.deepEqual(normalizedEntries, originalEntries);
}

async function collectEntries(reader: {
  entries: () => AsyncGenerator<{ name: string; open: () => Promise<ReadableStream<Uint8Array>> }>;
}): Promise<Record<string, Uint8Array>> {
  const entries: Record<string, Uint8Array> = {};
  for await (const entry of reader.entries()) {
    entries[entry.name] = await collect(await entry.open());
  }
  return entries;
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
  return concatChunks(chunks, total);
}

function concatChunks(chunks: Uint8Array[], total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`../test/fixtures/${name}`, import.meta.url)));
}

async function loadSchema(name: string): Promise<unknown> {
  const text = await readFile(new URL(`../schemas/${name}`, import.meta.url), 'utf8');
  return JSON.parse(text) as unknown;
}

async function assertNormalizeUnsupported(
  reader: { normalizeToWritable?: (writable: WritableStream<Uint8Array>) => Promise<unknown> },
  schema: JsonSchema
): Promise<void> {
  const normalizeToWritable = reader.normalizeToWritable?.bind(reader);
  assert.ok(normalizeToWritable);
  let error: unknown;
  try {
    await normalizeToWritable!(new WritableStream<Uint8Array>({ write() {} }));
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof ArchiveError);
  assert.equal(error.code, 'ARCHIVE_UNSUPPORTED_FEATURE');
  const json = error.toJSON();
  const result = validateSchema(schema, json);
  assert.equal(result.ok, true);
  assert.ok(json.hint);
  assert.ok(json.context);
}
