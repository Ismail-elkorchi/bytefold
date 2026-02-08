import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openArchive } from '@ismail-elkorchi/bytefold';

const THIRD_PARTY_ROOT = new URL('../test/fixtures/thirdparty/xz/', import.meta.url);

const THIRD_PARTY_FIXTURES = [
  {
    fixture: 'good-1-x86-lzma2.xz',
    expectedBytes: 1388,
    expectedSha256: 'dee7bc599bfc07147a302f44d1e994140bc812029baa4394d703e73e29117113'
  },
  { fixture: 'good-1-check-sha256.xz', expected: 'good-1-check-sha256.bin' }
];

test('xz third-party fixtures decode with resource ceilings', async () => {
  for (const { fixture, expected, expectedBytes, expectedSha256 } of THIRD_PARTY_FIXTURES) {
    const bytes = new Uint8Array(await readFile(new URL(fixture, THIRD_PARTY_ROOT)));
    const reader = await openArchive(bytes, {
      format: 'xz',
      limits: { maxXzDictionaryBytes: 1024 * 1024, maxXzBufferedBytes: 256 * 1024 }
    });
    let payload: Uint8Array | null = null;
    for await (const entry of reader.entries()) {
      payload = await collect(await entry.open());
    }
    assert.ok(payload, `${fixture} missing payload`);
    if (expected) {
      const expectedBytesData = new Uint8Array(await readFile(new URL(expected, THIRD_PARTY_ROOT)));
      assert.equal(payload.length, expectedBytesData.length, `${fixture} length mismatch`);
      assert.deepEqual(payload, expectedBytesData, `${fixture} bytes mismatch`);
      continue;
    }
    assert.equal(payload.length, expectedBytes, `${fixture} length mismatch`);
    assert.equal(sha256Hex(payload), expectedSha256, `${fixture} digest mismatch`);
  }
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
  return concatBytes(chunks);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
