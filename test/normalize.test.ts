import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipReader, ZipWriter } from 'archive-shield/node/zip';

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function writeZip(entries: Array<{ name: string; data: Uint8Array; method?: number }>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable);
  for (const entry of entries) {
    await writer.add(entry.name, entry.data, entry.method !== undefined ? { method: entry.method } : undefined);
  }
  await writer.close();
  return concat(chunks);
}

async function normalizeZip(
  reader: ZipReader,
  options?: Parameters<ZipReader['normalizeToWritable']>[1]
): Promise<{ report: Awaited<ReturnType<ZipReader['normalizeToWritable']>>; data: Uint8Array }> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const report = await reader.normalizeToWritable(writable, options);
  return { report, data: concat(chunks) };
}

test('normalize safe mode produces deterministic ordering and recompresses', async () => {
  const zip = await writeZip([
    { name: 'b.txt', data: new TextEncoder().encode('b'), method: 0 },
    { name: 'a.txt', data: new TextEncoder().encode('a'), method: 8 }
  ]);

  const reader = await ZipReader.fromUint8Array(zip);
  const { report, data } = await normalizeZip(reader, { mode: 'safe', deterministic: true });
  assert.equal(report.summary.recompressedEntries, 2);

  const normalized = await ZipReader.fromUint8Array(data);
  const names = normalized.entries().map((entry) => entry.name);
  assert.deepEqual(names, ['a.txt', 'b.txt']);
  for (const entry of normalized.entries()) {
    assert.equal(entry.method, 8);
    const stream = await normalized.open(entry);
    const buf = await new Response(stream).arrayBuffer();
    assert.equal(new TextDecoder().decode(buf), entry.name.startsWith('a') ? 'a' : 'b');
  }
});

test('normalize lossless preserves raw compressed bytes', async () => {
  const data = new TextEncoder().encode('lossless');
  const zip = await writeZip([{ name: 'file.txt', data, method: 8 }]);
  const reader = await ZipReader.fromUint8Array(zip);
  const entry = reader.entries()[0]!;
  const raw = await reader.openRaw(entry);
  const rawBuf = await new Response(raw).arrayBuffer();

  const { data: normalizedData } = await normalizeZip(reader, { mode: 'lossless', deterministic: true });
  const normalizedReader = await ZipReader.fromUint8Array(normalizedData);
  const normalizedEntry = normalizedReader.entries()[0]!;
  const normalizedRaw = await normalizedReader.openRaw(normalizedEntry);
  const normalizedBuf = await new Response(normalizedRaw).arrayBuffer();

  assert.deepEqual(new Uint8Array(normalizedBuf), new Uint8Array(rawBuf));
});

test('normalize can rename duplicate entries', async () => {
  const zip = await writeZip([
    { name: 'dup.txt', data: new TextEncoder().encode('first'), method: 0 },
    { name: 'dup.txt', data: new TextEncoder().encode('second'), method: 0 }
  ]);

  const reader = await ZipReader.fromUint8Array(zip);
  const { report, data } = await normalizeZip(reader, { mode: 'safe', deterministic: true, onDuplicate: 'rename' });
  assert.equal(report.summary.renamedEntries, 1);

  const normalized = await ZipReader.fromUint8Array(data);
  const names = normalized.entries().map((entry) => entry.name).sort();
  assert.deepEqual(names, ['dup.txt', 'dup~1.txt']);
});
