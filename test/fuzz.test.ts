import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipReader, ZipWriter, ZipError } from '@ismail-elkorchi/bytefold/node/zip';
import * as zlib from 'node:zlib';

class XorShift32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextU32(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  nextInt(max: number): number {
    if (max <= 0) return 0;
    return this.nextU32() % max;
  }

  nextBool(): boolean {
    return (this.nextU32() & 1) === 1;
  }
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

function randomName(rng: XorShift32, index: number): string {
  const ascii = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const unicode = ['é', 'ß', 'ø', '雪'];
  let name = `entry-${index}-`;
  const len = 3 + rng.nextInt(6);
  for (let i = 0; i < len; i += 1) {
    if (rng.nextInt(10) === 0) {
      name += unicode[rng.nextInt(unicode.length)]!;
    } else {
      name += ascii[rng.nextInt(ascii.length)]!;
    }
  }
  return `${name}.bin`;
}

function randomBytes(rng: XorShift32, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    out[i] = rng.nextU32() & 0xff;
  }
  return out;
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8);
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (
    buffer[offset]! |
    (buffer[offset + 1]! << 8) |
    (buffer[offset + 2]! << 16) |
    (buffer[offset + 3]! << 24)
  ) >>> 0;
}

function findLocalDataOffset(buffer: Uint8Array, offset: bigint): number {
  const start = Number(offset);
  const signature = readUint32LE(buffer, start);
  assert.equal(signature, 0x04034b50);
  const nameLen = readUint16LE(buffer, start + 26);
  const extraLen = readUint16LE(buffer, start + 28);
  return start + 30 + nameLen + extraLen;
}

test('deterministic fuzz-ish roundtrips and mutations', async () => {
  const rng = new XorShift32(0x12345678);
  const iterations = 200;
  const hasZstd = typeof zlib.createZstdCompress === 'function';
  const methods = hasZstd ? [0, 8, 93] as const : [0, 8] as const;

  for (let i = 0; i < iterations; i += 1) {
    const entryCount = 1 + rng.nextInt(3);
    const entries: Array<{ name: string; data: Uint8Array; method: 0 | 8 | 93 }> = [];

    for (let j = 0; j < entryCount; j += 1) {
      const name = randomName(rng, i * 10 + j);
      const size = rng.nextInt(64 * 1024 + 1);
      const data = randomBytes(rng, size);
      const method = methods[rng.nextInt(methods.length)]!;
      entries.push({ name, data, method });
    }

    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(new Uint8Array(chunk));
      }
    });
    const writer = ZipWriter.toWritable(writable);
    for (const entry of entries) {
      await writer.add(entry.name, entry.data, { method: entry.method });
    }
    await writer.close();

    const zip = concat(chunks);
    const reader = await ZipReader.fromUint8Array(zip);

    for (const entry of entries) {
      const found = reader.entries().find((e) => e.name === entry.name);
      assert.ok(found, `missing entry ${entry.name}`);
      const stream = await reader.open(found);
      const buf = await new Response(stream).arrayBuffer();
      assert.deepEqual(new Uint8Array(buf), entry.data);
    }

    const first = reader.entries()[0]!;
    const dataOffset = findLocalDataOffset(zip, first.offset);
    const dataLength = Number(first.compressedSize);

    const mutated = zip.slice();
    const mutations = 3 + rng.nextInt(3);
    for (let m = 0; m < mutations; m += 1) {
      const index = m === 0 && dataLength > 0
        ? dataOffset + rng.nextInt(Math.max(1, dataLength))
        : rng.nextInt(mutated.length);
      mutated[index] = (mutated[index] ?? 0) ^ (1 + (rng.nextU32() & 0x7f));
    }

    let hadError = false;
    try {
      const reader2 = await ZipReader.fromUint8Array(mutated, { isStrict: false });
      for (const entry of reader2.entries()) {
        try {
          const stream = await reader2.open(entry, { isStrict: false });
          await new Response(stream).arrayBuffer();
        } catch (err: unknown) {
          if (err instanceof ZipError) {
            hadError = true;
            break;
          }
          throw err;
        }
      }
      if (!hadError) {
        assert.ok(reader2.warnings().length > 0, 'expected warnings for mutated zip');
      }
    } catch (err: unknown) {
      assert.ok(err instanceof ZipError, 'mutation should throw ZipError');
    }
  }
});
