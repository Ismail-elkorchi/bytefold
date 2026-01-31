import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipReader, ZipWriter, ZipError } from '@ismail-elkorchi/bytefold/node/zip';

async function writeZip(
  entries: Array<{ name: string; data: Uint8Array; method?: 0 | 8 | 93; externalAttributes?: number }>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable);
  for (const entry of entries) {
    const options = {
      ...(entry.method !== undefined ? { method: entry.method } : {}),
      ...(entry.externalAttributes !== undefined ? { externalAttributes: entry.externalAttributes } : {})
    };
    await writer.add(entry.name, entry.data, Object.keys(options).length ? options : undefined);
  }
  await writer.close();
  return concat(chunks);
}

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

test('audit reports duplicates and case collisions', async () => {
  const data = new TextEncoder().encode('data');
  const zip = await writeZip([
    { name: 'dup.txt', data },
    { name: 'dup.txt', data },
    { name: 'File.txt', data },
    { name: 'file.TXT', data }
  ]);
  const reader = await ZipReader.fromUint8Array(zip, { profile: 'compat' });
  const report = await reader.audit({ profile: 'compat' });
  const codes = report.issues.map((issue) => issue.code);
  assert.ok(codes.includes('ZIP_DUPLICATE_ENTRY'));
  assert.ok(codes.includes('ZIP_CASE_COLLISION'));
  assert.doesNotThrow(() => {
    JSON.stringify(report);
  });
  await reader.close();
});

test('audit reports symlink entries and trailing bytes', async () => {
  const data = new TextEncoder().encode('../target');
  const symlinkAttrs = 0xa000 << 16;
  const zip = await writeZip([{ name: 'link', data, externalAttributes: symlinkAttrs }]);
  const withTrailing = concat([zip, new Uint8Array([1, 2, 3])]);
  const reader = await ZipReader.fromUint8Array(withTrailing, { profile: 'compat' });
  const report = await reader.audit({ profile: 'compat' });
  const codes = report.issues.map((issue) => issue.code);
  assert.ok(codes.includes('ZIP_SYMLINK_PRESENT'));
  assert.ok(codes.includes('ZIP_TRAILING_BYTES'));
  await reader.close();
});

test('audit reports local/central header mismatch', async () => {
  const data = new TextEncoder().encode('mismatch');
  const zip = await writeZip([{ name: 'mismatch.txt', data, method: 8 }]);
  const reader = await ZipReader.fromUint8Array(zip);
  const entry = reader.entries()[0]!;
  await reader.close();

  const mutated = zip.slice();
  const offset = Number(entry.offset);
  mutated[offset + 8] = 0;
  mutated[offset + 9] = 0;

  const reader2 = await ZipReader.fromUint8Array(mutated, { profile: 'compat' });
  const report = await reader2.audit({ profile: 'compat' });
  assert.ok(report.issues.some((issue) => issue.code === 'ZIP_HEADER_MISMATCH'));
  await reader2.close();
});

test('assertSafe treats warnings as errors in agent profile', async () => {
  const data = new TextEncoder().encode('data');
  const zip = await writeZip([
    { name: 'dup.txt', data },
    { name: 'dup.txt', data }
  ]);
  const reader = await ZipReader.fromUint8Array(zip, { profile: 'compat' });
  await assert.rejects(async () => {
    await reader.assertSafe({ profile: 'agent' });
  }, (err: unknown) => err instanceof ZipError && err.code === 'ZIP_AUDIT_FAILED');
  await reader.close();
});
