import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArchiveError, createArchiveWriter, openArchive } from '@ismail-elkorchi/bytefold';
import { getCompressionCapabilities } from '@ismail-elkorchi/bytefold/compress';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('createArchiveWriter supports tgz', async () => {
  await withTempDir(async (dir) => {
    const bytes = await writeArchive('tgz', [
      { name: 'hello.txt', data: encoder.encode('hello tgz') },
      { name: 'bin.dat', data: new Uint8Array([0, 1, 2, 3, 4]) }
    ]);
    const filePath = path.join(dir, 'writer.tgz');
    await writeFile(filePath, bytes);
    const payload = new Uint8Array(await readFile(filePath));
    const reader = await openArchive(payload);
    assert.equal(reader.format, 'tgz');
    const entries = await collectEntries(reader);
    assert.deepEqual(Object.keys(entries).sort(), ['bin.dat', 'hello.txt']);
    assert.equal(decoder.decode(entries['hello.txt']!), 'hello tgz');
    assert.deepEqual(Array.from(entries['bin.dat']!), [0, 1, 2, 3, 4]);
    const report = await reader.audit({ profile: 'agent' });
    assert.equal(report.ok, true);
  });
});

test('createArchiveWriter supports tar', async () => {
  await withTempDir(async (dir) => {
    const bytes = await writeTarArchive([
      { name: 'hello.txt', data: encoder.encode('hello tar') },
      { name: 'bin.dat', data: new Uint8Array([5, 6, 7]) }
    ]);
    const filePath = path.join(dir, 'writer.tar');
    await writeFile(filePath, bytes);
    const payload = new Uint8Array(await readFile(filePath));
    const reader = await openArchive(payload);
    assert.equal(reader.format, 'tar');
    const entries = await collectEntries(reader);
    assert.deepEqual(Object.keys(entries).sort(), ['bin.dat', 'hello.txt']);
    assert.equal(decoder.decode(entries['hello.txt']!), 'hello tar');
    assert.deepEqual(Array.from(entries['bin.dat']!), [5, 6, 7]);
  });
});

test('createArchiveWriter supports tar.gz alias', async () => {
  await withTempDir(async (dir) => {
    const bytes = await writeArchive('tar.gz', [
      { name: 'alpha.txt', data: encoder.encode('tar.gz writer') },
      { name: 'beta.bin', data: new Uint8Array([9, 8, 7]) }
    ]);
    const filePath = path.join(dir, 'writer.tar.gz');
    await writeFile(filePath, bytes);
    const payload = new Uint8Array(await readFile(filePath));
    const reader = await openArchive(payload);
    assert.equal(reader.format, 'tgz');
    const entries = await collectEntries(reader);
    assert.deepEqual(Object.keys(entries).sort(), ['alpha.txt', 'beta.bin']);
    assert.equal(decoder.decode(entries['alpha.txt']!), 'tar.gz writer');
    assert.deepEqual(Array.from(entries['beta.bin']!), [9, 8, 7]);
  });
});

test('createArchiveWriter supports gz single-file', async () => {
  await withTempDir(async (dir) => {
    const bytes = await writeArchive('gz', [{ name: 'ignored.txt', data: encoder.encode('hello gz') }]);
    const filePath = path.join(dir, 'hello.txt.gz');
    await writeFile(filePath, bytes);
    const payload = new Uint8Array(await readFile(filePath));
    const reader = await openArchive(payload, { filename: 'hello.txt.gz' });
    assert.equal(reader.format, 'gz');
    const entries = await collectEntries(reader);
    assert.deepEqual(Object.keys(entries), ['hello.txt']);
    assert.equal(decoder.decode(entries['hello.txt']!), 'hello gz');
  });
});

test('createArchiveWriter supports br single-file and requires hint', async () => {
  const caps = getCompressionCapabilities();
  if (!caps.algorithms.brotli.compress || !caps.algorithms.brotli.decompress) {
    assert.fail('brotli support is required by the support matrix; update runtime policy or SPEC.md if unavailable');
  }
  const bytes = await writeArchive('br', [{ name: 'ignored.txt', data: encoder.encode('hello br') }]);

  await assert.rejects(
    async () => {
      await openArchive(bytes);
    },
    (err: unknown) => err instanceof ArchiveError && err.code === 'ARCHIVE_UNSUPPORTED_FORMAT'
  );

  const reader = await openArchive(bytes, { format: 'br', filename: 'hello.txt.br' });
  assert.equal(reader.format, 'br');
  const entries = await collectEntries(reader);
  assert.deepEqual(Object.keys(entries), ['hello.txt']);
  assert.equal(decoder.decode(entries['hello.txt']!), 'hello br');
});

test('createArchiveWriter supports zst single-file', async () => {
  const caps = getCompressionCapabilities();
  if (!caps.algorithms.zstd.compress || !caps.algorithms.zstd.decompress) {
    assert.fail('zstd support is required by the support matrix; update runtime policy or SPEC.md if unavailable');
  }
  const bytes = await writeArchive('zst', [{ name: 'ignored.txt', data: encoder.encode('hello zst') }]);
  const reader = await openArchive(bytes, { filename: 'hello.txt.zst' });
  assert.equal(reader.format, 'zst');
  const entries = await collectEntries(reader);
  assert.deepEqual(Object.keys(entries), ['hello.txt']);
  assert.equal(decoder.decode(entries['hello.txt']!), 'hello zst');
});

test('unsupported writer formats throw typed errors', async () => {
  const schema = (JSON.parse(
    await readFile(new URL('../schemas/error.schema.json', import.meta.url), 'utf8')
  ) as unknown) as JsonSchema;

  const formats: Array<'bz2' | 'tar.bz2' | 'xz' | 'tar.xz'> = ['bz2', 'tar.bz2', 'xz', 'tar.xz'];
  for (const format of formats) {
    let error: unknown;
    try {
      createArchiveWriter(format, new WritableStream<Uint8Array>({ write() {} }));
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof ArchiveError, `expected ArchiveError for ${format}`);
    assert.equal(error.code, 'ARCHIVE_UNSUPPORTED_FORMAT');
    const json = error.toJSON();
    const result = validateSchema(schema, json);
    assert.equal(result.ok, true);
    assert.ok(json.hint);
    assert.ok(json.context);
  }
});

type WriterFormat = 'tgz' | 'tar.gz' | 'gz' | 'br' | 'zst';

async function writeArchive(
  format: WriterFormat,
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

async function writeTarArchive(entries: Array<{ name: string; data: Uint8Array }>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('tar', writable);
  for (const entry of entries) {
    await writer.add(entry.name, entry.data);
  }
  await writer.close();
  return concatChunks(chunks);
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

function concatChunks(chunks: Uint8Array[], total?: number): Uint8Array {
  const length = total ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bytefold-writer-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
