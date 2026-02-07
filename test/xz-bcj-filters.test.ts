import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold';
import { CompressionError } from '@ismail-elkorchi/bytefold/compress';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const FIXTURE_ROOT = new URL('../test/fixtures/', import.meta.url);
const EXPECTED_ROOT = new URL('../test/fixtures/expected/', import.meta.url);
const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);

const BCJ_FIXTURES = [
  { fixture: 'xz-bcj/x86.xz', expected: 'xz-bcj-x86.bin', filterId: 0x04n, alignment: 1 },
  { fixture: 'xz-bcj/powerpc.xz', expected: 'xz-bcj-powerpc.bin', filterId: 0x05n, alignment: 4, isNew: true },
  { fixture: 'xz-bcj/ia64.xz', expected: 'xz-bcj-ia64.bin', filterId: 0x06n, alignment: 16, isNew: true },
  { fixture: 'xz-bcj/arm.xz', expected: 'xz-bcj-arm.bin', filterId: 0x07n, alignment: 4 },
  { fixture: 'xz-bcj/armthumb.xz', expected: 'xz-bcj-armthumb.bin', filterId: 0x08n, alignment: 2, isNew: true },
  { fixture: 'xz-bcj/sparc.xz', expected: 'xz-bcj-sparc.bin', filterId: 0x09n, alignment: 4, isNew: true },
  { fixture: 'xz-bcj/arm64.xz', expected: 'xz-bcj-arm64.bin', filterId: 0x0an, alignment: 4 },
  { fixture: 'xz-bcj/riscv.xz', expected: 'xz-bcj-riscv.bin', filterId: 0x0bn, alignment: 2 }
];

const NEW_BCJ_FIXTURES = BCJ_FIXTURES.filter((fixture) => fixture.isNew);

test('xz BCJ fixtures decode to expected bytes', async () => {
  for (const { fixture, expected } of BCJ_FIXTURES) {
    const bytes = await readFixture(fixture);
    const reader = await openArchive(bytes);
    let payload: Uint8Array | null = null;
    for await (const entry of reader.entries()) {
      payload = await collect(await entry.open());
    }
    assert.ok(payload, `${fixture} missing payload`);
    const expectedBytes = await readExpected(expected);
    assert.equal(payload.length, expectedBytes.length, `${fixture} length mismatch`);
    assert.deepEqual(payload, expectedBytes, `${fixture} bytes mismatch`);
  }
});

test('xz BCJ start offset applies across blocks', async () => {
  const bytes = await readFixture('xz-bcj/startoffset-multiblock-x86.xz');
  const expected = new Uint8Array(
    await readFile(new URL('xz-bcj/startoffset-multiblock-x86.bin', FIXTURE_ROOT))
  );
  const reader = await openArchive(bytes);
  let payload: Uint8Array | null = null;
  for await (const entry of reader.entries()) {
    payload = await collect(await entry.open());
  }
  assert.ok(payload, 'startoffset fixture missing payload');
  assert.equal(payload.length, expected.length, 'startoffset fixture length mismatch');
  assert.deepEqual(payload, expected, 'startoffset fixture bytes mismatch');
});

test('xz SHA-256 check mismatch yields typed error', async () => {
  const bytes = await readFixture('xz-check-sha256.xz');
  const expected = await readExpected('xz-check-sha256.bin');
  const mutated = new Uint8Array(bytes);
  const checkOffset = locateBlockCheckOffset(mutated, expected.length);
  mutated[checkOffset] = (mutated[checkOffset] ?? 0) ^ 0xff;

  const errorSchema = await loadErrorSchema();
  await assert.rejects(
    async () => {
      const reader = await openArchive(mutated);
      for await (const entry of reader.entries()) {
        await collect(await entry.open());
      }
    },
    (err: unknown) => {
      if (!(err instanceof CompressionError)) return false;
      assert.equal(err.code, 'COMPRESSION_XZ_BAD_CHECK');
      assert.equal(err.context?.check, 'sha256');
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      return true;
    }
  );
});

test('xz BCJ start offset alignment is enforced', async () => {
  const errorSchema = await loadErrorSchema();
  for (const fixture of NEW_BCJ_FIXTURES) {
    const bytes = await readFixture(fixture.fixture);
    const mutated = new Uint8Array(bytes);
    const header = parseBlockHeader(mutated);
    const bcj = header.filters.find((filter) => filter.id === fixture.filterId);
    assert.ok(bcj, `missing filter ${fixture.fixture}`);
    if (bcj.propsSize !== 4) throw new Error('expected BCJ props size 4');
    writeUint32LE(mutated, header.start + bcj.propsOffset, 1);
    updateHeaderCrc(mutated, header.start, header.size);

    await assert.rejects(
      async () => {
        const reader = await openArchive(mutated);
        for await (const entry of reader.entries()) {
          await collect(await entry.open());
        }
      },
      (err: unknown) => {
        if (!(err instanceof CompressionError)) return false;
        assert.equal(err.code, 'COMPRESSION_XZ_BAD_DATA');
        assert.equal(err.context?.filterId, formatFilterId(fixture.filterId));
        assert.equal(err.context?.requiredAlignment, String(fixture.alignment));
        assert.equal(err.context?.startOffset, '1');
        const json = err.toJSON();
        const result = validateSchema(errorSchema, json);
        assert.ok(result.ok, result.errors.join('\n'));
        return true;
      }
    );
  }
});

test('xz BCJ filters cannot be last in chain', async () => {
  const errorSchema = await loadErrorSchema();
  for (const fixture of NEW_BCJ_FIXTURES) {
    const bytes = await readFixture(fixture.fixture);
    const mutated = new Uint8Array(bytes);
    const header = parseBlockHeader(mutated);
    const filters = header.filters.map((filter) => ({
      id: filter.id,
      props: mutated.subarray(header.start + filter.propsOffset, header.start + filter.propsOffset + filter.propsSize)
    }));
    const bcj = filters.find((filter) => filter.id === fixture.filterId);
    assert.ok(bcj, `missing expected filters for ${fixture.fixture}`);

    const rebuilt = buildBlockHeader([bcj], header.size);
    mutated.set(rebuilt, header.start);

    await assert.rejects(
      async () => {
        const reader = await openArchive(mutated);
        for await (const entry of reader.entries()) {
          await collect(await entry.open());
        }
      },
      (err: unknown) => {
        if (!(err instanceof CompressionError)) return false;
        assert.equal(err.code, 'COMPRESSION_XZ_UNSUPPORTED_FILTER');
        assert.equal(err.context?.rule, 'non-last-only');
        assert.equal(err.context?.filterId, formatFilterId(fixture.filterId));
        const json = err.toJSON();
        const result = validateSchema(errorSchema, json);
        assert.ok(result.ok, result.errors.join('\n'));
        return true;
      }
    );
  }
});

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, FIXTURE_ROOT)));
}

async function readExpected(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, EXPECTED_ROOT)));
}

async function loadErrorSchema(): Promise<JsonSchema> {
  return (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;
}

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

function locateBlockCheckOffset(bytes: Uint8Array, payloadLength: number): number {
  if (bytes.length < 13) throw new Error('XZ stream too small');
  const headerSize = (bytes[12]! + 1) * 4;
  const lzma2Length = payloadLength + 4;
  const blockDataOffset = 12 + headerSize;
  const pad = (4 - (lzma2Length % 4)) & 3;
  return blockDataOffset + lzma2Length + pad;
}

type ParsedHeader = {
  start: number;
  size: number;
  filters: Array<{ id: bigint; propsOffset: number; propsSize: number }>;
};

function parseBlockHeader(bytes: Uint8Array): ParsedHeader {
  const start = 12;
  if (bytes.length < start + 1) throw new Error('missing block header');
  const size = (bytes[start]! + 1) * 4;
  const header = bytes.subarray(start, start + size);
  const filters: Array<{ id: bigint; propsOffset: number; propsSize: number }> = [];
  let offset = 1;
  const flags = header[offset++]!;
  if (flags & 0x40) {
    const read = readVliFromBuffer(header, offset);
    offset = read.offset;
  }
  if (flags & 0x80) {
    const read = readVliFromBuffer(header, offset);
    offset = read.offset;
  }
  const filterCount = (flags & 0x03) + 1;
  for (let i = 0; i < filterCount; i += 1) {
    const id = readVliFromBuffer(header, offset);
    offset = id.offset;
    const props = readVliFromBuffer(header, offset);
    offset = props.offset;
    const propsSize = Number(props.value);
    filters.push({ id: id.value, propsOffset: offset, propsSize });
    offset += propsSize;
  }
  return { start, size, filters };
}

function readVliFromBuffer(buffer: Uint8Array, start: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  for (let i = 0; i < 9; i += 1) {
    if (offset >= buffer.length) throw new Error('vli out of range');
    const byte = buffer[offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error('vli too long');
}

function formatFilterId(id: bigint): string {
  const hex = id.toString(16);
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  return `0x${padded}`;
}

function buildBlockHeader(filters: Array<{ id: bigint; props: Uint8Array }>, headerSize: number): Uint8Array {
  const parts: number[] = [];
  const flags = (filters.length - 1) & 0x03;
  parts.push(flags);
  for (const filter of filters) {
    parts.push(...encodeVli(filter.id));
    parts.push(...encodeVli(BigInt(filter.props.length)));
    parts.push(...filter.props);
  }
  const required = 1 + parts.length + 4;
  if (required > headerSize) {
    throw new Error('rebuilt header exceeds original size');
  }
  const header = new Uint8Array(headerSize);
  header[0] = headerSize / 4 - 1;
  header.set(parts, 1);
  const crc = crc32(header.subarray(0, header.length - 4));
  writeUint32LE(header, header.length - 4, crc);
  return header;
}

function encodeVli(value: bigint): number[] {
  let v = value;
  const out: number[] = [];
  while (true) {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
    if (v === 0n) break;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      if ((c & 1) !== 0) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(chunk: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < chunk.length; i += 1) {
    crc = CRC_TABLE[(crc ^ chunk[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32LE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}

function updateHeaderCrc(bytes: Uint8Array, start: number, size: number): void {
  const header = bytes.subarray(start, start + size);
  const crc = crc32(header.subarray(0, header.length - 4));
  writeUint32LE(header, header.length - 4, crc);
}
