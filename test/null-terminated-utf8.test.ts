import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEXT_ENCODER = new TextEncoder();
const LEGACY_DECODER = new TextDecoder('utf-8');

type BinaryModule = {
  decodeNullTerminatedUtf8: (bytes: Uint8Array, fatal?: boolean) => string;
};

test('decodeNullTerminatedUtf8 matches legacy null-truncation semantics', async () => {
  const { decodeNullTerminatedUtf8 } = await loadBinaryModule();
  const cases = [
    TEXT_ENCODER.encode('0755'),
    TEXT_ENCODER.encode('000123\0ignored-suffix'),
    TEXT_ENCODER.encode('\0leading-nul'),
    TEXT_ENCODER.encode(' 0777 \0  padded-tail'),
    new Uint8Array([0x31, 0x00, 0xf0, 0x9f, 0x98, 0x80]),
    hexBytes('91badf07806515b26c4fe23c774903809deb9e7a9e49d2f550ad3bb8adfc5473f9e6885cc4da14f76c515713708dcafcf10d0e2742bb6e003fb8f79698e98c0c0982350abedd50dea8bf289ffcbe')
  ];
  for (const value of cases) {
    assert.equal(decodeNullTerminatedUtf8(value), legacyDecodeNullTerminatedUtf8(value));
  }
});

test('decodeNullTerminatedUtf8 handles adversarial long NUL patterns deterministically', async () => {
  const { decodeNullTerminatedUtf8 } = await loadBinaryModule();

  const manyNuls = new Uint8Array(512 * 1024);
  manyNuls.fill(0);
  assert.equal(decodeNullTerminatedUtf8(manyNuls), '');
  assert.equal(decodeNullTerminatedUtf8(manyNuls), legacyDecodeNullTerminatedUtf8(manyNuls));

  const prefix = TEXT_ENCODER.encode('12345670');
  const longTail = new Uint8Array(1024 * 1024);
  longTail.fill(0x31);
  const adversarial = new Uint8Array(prefix.length + 1 + longTail.length);
  adversarial.set(prefix, 0);
  adversarial[prefix.length] = 0;
  adversarial.set(longTail, prefix.length + 1);

  const once = decodeNullTerminatedUtf8(adversarial);
  assert.equal(once, '12345670');
  assert.equal(once, legacyDecodeNullTerminatedUtf8(adversarial));
  assert.equal(decodeNullTerminatedUtf8(adversarial), once);
  assert.equal(decodeNullTerminatedUtf8(adversarial), once);
});

test('decodeNullTerminatedUtf8 matches legacy semantics over deterministic random bytes', async () => {
  const { decodeNullTerminatedUtf8 } = await loadBinaryModule();
  const rand = mulberry32(0x5eed1234);
  for (let i = 0; i < 8192; i += 1) {
    const len = Math.floor(rand() * 128);
    const bytes = new Uint8Array(len);
    for (let j = 0; j < len; j += 1) {
      bytes[j] = Math.floor(rand() * 256);
    }
    assert.equal(decodeNullTerminatedUtf8(bytes), legacyDecodeNullTerminatedUtf8(bytes));
  }
});

async function loadBinaryModule(): Promise<BinaryModule> {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), 'dist/binary.js')).href;
  return (await import(moduleUrl)) as BinaryModule;
}

function legacyDecodeNullTerminatedUtf8(bytes: Uint8Array): string {
  return LEGACY_DECODER.decode(bytes).replace(/\0.*$/, '');
}

function hexBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'hex'));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
