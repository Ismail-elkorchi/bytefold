import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArchiveWriter, openArchive } from '@ismail-elkorchi/bytefold/web';

const HELLO_FIXTURE_URL = new URL('../test/fixtures/expected/hello.txt', import.meta.url);

test('web writer roundtrip: zip store-only -> blob -> openArchive', async () => {
  const helloBytes = await readFixtureBytes();

  const zipBytes = await writeArchive('zip', async (writer) => {
    await writer.add('hello.txt', helloBytes);
    await writer.add('nested/hello.txt', helloBytes);
  }, { zip: { defaultMethod: 0 } });

  const archive = await openArchive(new Blob([blobPartFromBytes(zipBytes)], { type: 'application/zip' }), {
    format: 'zip'
  });
  assert.equal(archive.format, 'zip');
  assert.equal(archive.detection?.inputKind, 'blob');

  const entries = await collectEntryBytes(archive);
  assert.deepEqual(Object.keys(entries).sort(), ['hello.txt', 'nested/hello.txt']);
  assert.deepEqual(entries['hello.txt'], helloBytes);
  assert.deepEqual(entries['nested/hello.txt'], helloBytes);

  const audit = await archive.audit({ profile: 'agent' });
  assert.equal(audit.ok, true);
  assert.equal(audit.summary.errors, 0);

  const { report: normalizeReport, bytes: normalizedBytes } = await normalizeArchiveToBytes(archive);
  assert.equal(normalizeReport.ok, true);
  assert.equal(normalizeReport.summary.errors, 0);

  const normalized = await openArchive(new Blob([blobPartFromBytes(normalizedBytes)], { type: 'application/zip' }), {
    format: 'zip'
  });
  const normalizedEntries = await collectEntryBytes(normalized);
  assert.deepEqual(Object.keys(normalizedEntries).sort(), ['hello.txt', 'nested/hello.txt']);
  assert.deepEqual(normalizedEntries['hello.txt'], helloBytes);
  assert.deepEqual(normalizedEntries['nested/hello.txt'], helloBytes);
});

test('web writer roundtrip: tar -> blob -> openArchive', async () => {
  const helloBytes = await readFixtureBytes();

  const tarBytes = await writeArchive('tar', async (writer) => {
    await writer.add('hello.txt', helloBytes);
  }, { tar: { isDeterministic: true } });

  const archive = await openArchive(new Blob([blobPartFromBytes(tarBytes)], { type: 'application/x-tar' }), {
    format: 'tar'
  });
  assert.equal(archive.format, 'tar');
  assert.equal(archive.detection?.inputKind, 'blob');

  const entries = await collectEntryBytes(archive);
  assert.deepEqual(Object.keys(entries), ['hello.txt']);
  assert.deepEqual(entries['hello.txt'], helloBytes);

  const audit = await archive.audit({ profile: 'agent' });
  assert.equal(audit.ok, true);
  assert.equal(audit.summary.errors, 0);

  const { report: normalizeReport, bytes: normalizedBytes } = await normalizeArchiveToBytes(archive);
  assert.equal(normalizeReport.ok, true);
  assert.equal(normalizeReport.summary.errors, 0);

  const normalized = await openArchive(new Blob([blobPartFromBytes(normalizedBytes)], { type: 'application/x-tar' }), {
    format: 'tar'
  });
  const normalizedEntries = await collectEntryBytes(normalized);
  assert.deepEqual(Object.keys(normalizedEntries), ['hello.txt']);
  assert.deepEqual(normalizedEntries['hello.txt'], helloBytes);
});

async function readFixtureBytes(): Promise<Uint8Array> {
  const fixture = await readFile(HELLO_FIXTURE_URL);
  const out = new Uint8Array(fixture.length);
  out.set(fixture);
  return out;
}

async function writeArchive(
  format: 'zip' | 'tar',
  writeEntries: (writer: ReturnType<typeof createArchiveWriter>) => Promise<void>,
  options?: Parameters<typeof createArchiveWriter>[2]
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(copyChunk(chunk));
    }
  });

  const writer = createArchiveWriter(format, writable, options);
  await writeEntries(writer);
  await writer.close();
  return concatChunks(chunks);
}

async function collectEntryBytes(reader: Awaited<ReturnType<typeof openArchive>>): Promise<Record<string, Uint8Array>> {
  const entries: Record<string, Uint8Array> = {};
  for await (const entry of reader.entries()) {
    entries[entry.name] = await collectStream(await entry.open());
  }
  return entries;
}

async function normalizeArchiveToBytes(reader: Awaited<ReturnType<typeof openArchive>>): Promise<{
  report: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof openArchive>>['normalizeToWritable']>>>;
  bytes: Uint8Array;
}> {
  if (!reader.normalizeToWritable) {
    throw new Error('normalizeToWritable is unavailable for this archive format');
  }

  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(copyChunk(chunk));
    }
  });

  const report = await reader.normalizeToWritable(writable, { isDeterministic: true });
  return { report, bytes: concatChunks(chunks) };
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(copyChunk(value));
    }
  } finally {
    reader.releaseLock();
  }
  return concatChunks(chunks);
}

function copyChunk(chunk: Uint8Array): Uint8Array {
  const out = new Uint8Array(chunk.length);
  out.set(chunk);
  return out;
}

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

function blobPartFromBytes(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return owned.buffer;
}
