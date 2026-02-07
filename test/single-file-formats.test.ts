import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArchiveError, openArchive } from '@ismail-elkorchi/bytefold';

const decoder = new TextDecoder();

test('single-file gz extracts and normalizes as unsupported', async () => {
  const payload = await readFixture('hello.txt.gz');
  const expected = await readTextFixture('expected/hello.txt');
  const reader = await openArchive(payload, { filename: 'hello.txt.gz' });
  assert.equal(reader.format, 'gz');

  const entries = await collectEntries(reader);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.name, 'hello.txt');
  assert.equal(decoder.decode(entries[0]!.data), expected);
  assertNoSeparators(entries[0]!.name);

  const report = await reader.audit({ profile: 'agent' });
  assert.equal(report.ok, true);
  await assertNormalizeUnsupported(reader);
});

test('single-file bz2 extracts and normalizes as unsupported', async () => {
  const payload = await readFixture('hello.txt.bz2');
  const reader = await openArchive(payload, { filename: 'hello.txt.bz2' });
  assert.equal(reader.format, 'bz2');

  const entries = await collectEntries(reader);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.name, 'hello.txt');
  assert.equal(decoder.decode(entries[0]!.data), 'hello bzip2\n');
  assertNoSeparators(entries[0]!.name);

  const report = await reader.audit({ profile: 'agent' });
  assert.equal(report.ok, true);
  await assertNormalizeUnsupported(reader);
});

test('single-file xz extracts and normalizes as unsupported', async () => {
  const payload = await readFixture('hello.txt.xz');
  const reader = await openArchive(payload, { filename: 'hello.txt.xz' });
  assert.equal(reader.format, 'xz');

  const entries = await collectEntries(reader);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.name, 'hello.txt');
  assert.equal(decoder.decode(entries[0]!.data), 'hello from bytefold\n');
  assertNoSeparators(entries[0]!.name);

  const report = await reader.audit({ profile: 'agent' });
  assert.equal(report.ok, true);
  await assertNormalizeUnsupported(reader);
});

test('single-file br requires explicit hint and extracts', async () => {
  const payload = await readFixture('hello.txt.br');
  await assert.rejects(
    async () => {
      await openArchive(payload);
    },
    (err: unknown) => err instanceof ArchiveError && err.code === 'ARCHIVE_UNSUPPORTED_FORMAT'
  );

  const reader = await openArchive(payload, { format: 'br', filename: 'hello.txt.br' });
  assert.equal(reader.format, 'br');

  const entries = await collectEntries(reader);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.name, 'hello.txt');
  assert.equal(decoder.decode(entries[0]!.data), await readTextFixture('expected/hello.txt'));
  assertNoSeparators(entries[0]!.name);

  const report = await reader.audit({ profile: 'agent' });
  assert.equal(report.ok, true);
  await assertNormalizeUnsupported(reader);
});

test('single-file zst extracts and normalizes as unsupported', async () => {
  const payload = await readFixture('hello.txt.zst');
  const reader = await openArchive(payload, { filename: 'hello.txt.zst' });
  assert.equal(reader.format, 'zst');

  const entries = await collectEntries(reader);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.name, 'hello.txt');
  assert.equal(decoder.decode(entries[0]!.data), await readTextFixture('expected/hello.txt'));
  assertNoSeparators(entries[0]!.name);

  const report = await reader.audit({ profile: 'agent' });
  assert.equal(report.ok, true);
  await assertNormalizeUnsupported(reader);
});

test('single-file name inference is deterministic', async () => {
  const samples: Array<{ fixture: string; filename: string; expected: string; format?: 'br' }> = [
    { fixture: 'hello.txt.gz', filename: 'dir/hello.txt.gz', expected: 'hello.txt' },
    { fixture: 'hello.txt.bz2', filename: 'dir/hello.txt.bz2', expected: 'hello.txt' },
    { fixture: 'hello.txt.xz', filename: 'dir/hello.txt.xz', expected: 'hello.txt' },
    { fixture: 'hello.txt.zst', filename: 'dir/hello.txt.zst', expected: 'hello.txt' },
    { fixture: 'hello.txt.br', format: 'br', filename: 'dir/hello.txt.br', expected: 'hello.txt' }
  ];

  for (const sample of samples) {
    const data = await readFixture(sample.fixture);
    const readerA = await openArchive(data, { filename: sample.filename, ...(sample.format ? { format: sample.format } : {}) });
    const readerB = await openArchive(data, { filename: sample.filename, ...(sample.format ? { format: sample.format } : {}) });
    const [entryA] = await collectEntries(readerA);
    const [entryB] = await collectEntries(readerB);
    assert.equal(entryA!.name, sample.expected);
    assert.equal(entryB!.name, sample.expected);
    assertNoSeparators(entryA!.name);
    assertNoSeparators(entryB!.name);
  }
});

test('concatenated gzip members decode sequentially', async () => {
  const payload = await readFixture('concat.gz');
  const expected = await readTextFixture('expected/hello.txt');
  const reader = await openArchive(payload, { filename: 'concat.gz' });
  assert.equal(reader.format, 'gz');

  const entries = await collectEntries(reader);
  assert.equal(entries.length, 1);
  assert.equal(decoder.decode(entries[0]!.data), `${expected}${expected}`);
});

test('concatenated bzip2 streams decode sequentially', async () => {
  const payload = await readFixture('concat.bz2');
  const reader = await openArchive(payload, { filename: 'concat.bz2' });
  assert.equal(reader.format, 'bz2');

  const entries = await collectEntries(reader);
  assert.equal(entries.length, 1);
  assert.equal(decoder.decode(entries[0]!.data), 'hello bzip2\nhello bzip2\n');
});

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`../test/fixtures/${name}`, import.meta.url)));
}

async function readTextFixture(name: string): Promise<string> {
  return decoder.decode(await readFixture(name));
}

async function collectEntries(reader: {
  entries: () => AsyncGenerator<{ name: string; open: () => Promise<ReadableStream<Uint8Array>> }>;
}): Promise<Array<{ name: string; data: Uint8Array }>> {
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  for await (const entry of reader.entries()) {
    entries.push({ name: entry.name, data: await collect(await entry.open()) });
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
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function assertNormalizeUnsupported(reader: { normalizeToWritable?: (w: WritableStream<Uint8Array>) => Promise<unknown> }) {
  const normalize = reader.normalizeToWritable?.bind(reader);
  assert.ok(normalize);
  await assert.rejects(
    async () => {
      await normalize!(new WritableStream<Uint8Array>({ write() {} }));
    },
    (err: unknown) => err instanceof ArchiveError && err.code === 'ARCHIVE_UNSUPPORTED_FEATURE'
  );
}

function assertNoSeparators(name: string) {
  assert.equal(/[\\/]/.test(name), false);
}
