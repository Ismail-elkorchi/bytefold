import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold';
import { CompressionError } from '@ismail-elkorchi/bytefold/compress';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const FIXTURE_ROOT = new URL('../test/fixtures/', import.meta.url);
const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);

async function loadErrorSchema(): Promise<JsonSchema> {
  return (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;
}

async function expectLimitError(
  action: () => Promise<unknown>,
  algorithm: string,
  requiredKey: string,
  limitKey: string
): Promise<void> {
  const errorSchema = await loadErrorSchema();
  await assert.rejects(
    action,
    (err: unknown) => {
      if (!(err instanceof CompressionError)) return false;
      assert.equal(err.code, 'COMPRESSION_RESOURCE_LIMIT');
      const json = err.toJSON() as { algorithm?: string; context?: Record<string, string> };
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      assert.equal(json.algorithm, algorithm);
      assert.ok(json.context?.[requiredKey]);
      assert.ok(json.context?.[limitKey]);
      return true;
    }
  );
}

function readXzDictionarySize(data: Uint8Array): number | undefined {
  if (data.length < 12) return undefined;
  if (data[0] !== 0xfd || data[1] !== 0x37 || data[2] !== 0x7a || data[3] !== 0x58 || data[4] !== 0x5a || data[5] !== 0x00) {
    return undefined;
  }
  let offset = 12;
  if (offset >= data.length) return undefined;
  const headerSizeByte = data[offset]!;
  if (headerSizeByte === 0x00) return undefined;
  const headerSize = (headerSizeByte + 1) * 4;
  if (headerSize < 8 || headerSize > 1024) return undefined;
  if (offset + headerSize > data.length) return undefined;
  const header = data.subarray(offset, offset + headerSize);
  const storedCrc = readUint32LE(header, header.length - 4);
  if (crc32(header.subarray(0, header.length - 4)) !== storedCrc) return undefined;
  let pos = 1;
  const flags = header[pos++]!;
  if ((flags & 0x3c) !== 0) return undefined;
  const filterCount = (flags & 0x03) + 1;
  if (filterCount > 4) return undefined;
  if (flags & 0x40) {
    const read = readVli(header, pos);
    if (!read) return undefined;
    pos = read.offset;
  }
  if (flags & 0x80) {
    const read = readVli(header, pos);
    if (!read) return undefined;
    pos = read.offset;
  }
  let dictProp: number | null = null;
  for (let i = 0; i < filterCount; i += 1) {
    const id = readVli(header, pos);
    if (!id) return undefined;
    pos = id.offset;
    const propsSize = readVli(header, pos);
    if (!propsSize) return undefined;
    pos = propsSize.offset;
    const propsBytes = Number(propsSize.value);
    if (!Number.isFinite(propsBytes)) return undefined;
    if (pos + propsBytes > header.length - 4) return undefined;
    if (id.value === 0x21n) {
      if (propsBytes !== 1) return undefined;
      dictProp = header[pos]!;
    }
    pos += propsBytes;
  }
  if (dictProp === null) return undefined;
  return decodeDictionarySize(dictProp);
}

function decodeDictionarySize(props: number): number {
  const bits = props & 0x3f;
  if (bits > 40) return 0;
  if (bits === 40) return 0xffffffff;
  const base = 2 | (bits & 1);
  const shift = (bits >> 1) + 11;
  return base * 2 ** shift;
}

function readVli(buffer: Uint8Array, start: number): { value: bigint; offset: number } | null {
  let offset = start;
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < 9; i += 1) {
    if (offset >= buffer.length - 4) return null;
    const byte = buffer[offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  return null;
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16) | (buffer[offset + 3]! << 24)) >>> 0;
}

function crc32(chunk: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < chunk.length; i += 1) {
    crc = CRC_TABLE[(crc ^ chunk[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
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

test('resource ceilings: bzip2 and xz fail early with typed errors', async () => {
  const bz2Bytes = new Uint8Array(await readFile(new URL('hello.txt.bz2', FIXTURE_ROOT)));
  await expectLimitError(
    () => openArchive(bz2Bytes, { filename: 'hello.txt.bz2', limits: { maxBzip2BlockSize: 1 } }),
    'bzip2',
    'requiredBlockSize',
    'limitBlockSize'
  );

  const tarBz2Bytes = new Uint8Array(await readFile(new URL('fixture.tar.bz2', FIXTURE_ROOT)));
  await expectLimitError(
    () => openArchive(tarBz2Bytes, { filename: 'fixture.tar.bz2', limits: { maxBzip2BlockSize: 1 } }),
    'bzip2',
    'requiredBlockSize',
    'limitBlockSize'
  );

  const concatBz2Bytes = new Uint8Array(await readFile(new URL('concat-limit.bz2', FIXTURE_ROOT)));
  await expectLimitError(
    () => openArchive(concatBz2Bytes, { filename: 'concat-limit.bz2', limits: { maxBzip2BlockSize: 1 } }),
    'bzip2',
    'requiredBlockSize',
    'limitBlockSize'
  );

  const xzBytes = new Uint8Array(await readFile(new URL('hello.txt.xz', FIXTURE_ROOT)));
  await expectLimitError(
    () => openArchive(xzBytes, { filename: 'hello.txt.xz', limits: { maxXzDictionaryBytes: 1024 } }),
    'xz',
    'requiredDictionaryBytes',
    'limitDictionaryBytes'
  );

  const concatXzBytes = new Uint8Array(await readFile(new URL('concat-limit.xz', FIXTURE_ROOT)));
  const stream1Dict = readXzDictionarySize(concatXzBytes);
  assert.ok(stream1Dict && stream1Dict > 0, 'missing first-stream dictionary size');
  await expectLimitError(
    () =>
      openArchive(concatXzBytes, {
        filename: 'concat-limit.xz',
        limits: { maxXzDictionaryBytes: stream1Dict }
      }),
    'xz',
    'requiredDictionaryBytes',
    'limitDictionaryBytes'
  );

  const concatTwoBytes = new Uint8Array(await readFile(new URL('concat-two.xz', FIXTURE_ROOT)));
  await expectLimitError(
    () =>
      openArchive(concatTwoBytes, {
        filename: 'concat-two.xz',
        limits: { maxXzIndexRecords: 1 }
      }),
    'xz',
    'requiredIndexRecords',
    'limitIndexRecords'
  );
  await expectLimitError(
    () =>
      openArchive(concatTwoBytes, {
        filename: 'concat-two.xz',
        limits: { maxXzIndexBytes: 1 }
      }),
    'xz',
    'requiredIndexBytes',
    'limitIndexBytes'
  );
});

test('audit preflight reports resource ceilings without decompression', async () => {
  const bz2Bytes = new Uint8Array(await readFile(new URL('hello.txt.bz2', FIXTURE_ROOT)));
  const bz2Reader = await openArchive(bz2Bytes, { filename: 'hello.txt.bz2' });
  const bz2Report = await bz2Reader.audit({ limits: { maxBzip2BlockSize: 1 } });
  const bz2Issue = bz2Report.issues.find((issue) => issue.code === 'COMPRESSION_RESOURCE_LIMIT');
  assert.ok(bz2Issue, 'missing bzip2 resource limit issue');
  assert.equal((bz2Issue?.details as { algorithm?: string } | undefined)?.algorithm, 'bzip2');

  const bz2PreflightIssue = bz2Report.issues.find(
    (issue) => issue.code === 'COMPRESSION_RESOURCE_PREFLIGHT_INCOMPLETE'
  );
  assert.ok(bz2PreflightIssue, 'missing bzip2 preflight incomplete issue');

  const xzBytes = new Uint8Array(await readFile(new URL('hello.txt.xz', FIXTURE_ROOT)));
  const xzReader = await openArchive(xzBytes, { filename: 'hello.txt.xz' });
  const xzReport = await xzReader.audit({ limits: { maxXzDictionaryBytes: 1024 } });
  const xzIssue = xzReport.issues.find((issue) => issue.code === 'COMPRESSION_RESOURCE_LIMIT');
  assert.ok(xzIssue, 'missing xz resource limit issue');
  assert.equal((xzIssue?.details as { algorithm?: string } | undefined)?.algorithm, 'xz');

  const concatXzBytes = new Uint8Array(await readFile(new URL('concat-limit.xz', FIXTURE_ROOT)));
  const concatReader = await openArchive(concatXzBytes, { filename: 'concat-limit.xz' });
  const concatDict = readXzDictionarySize(concatXzBytes);
  assert.ok(concatDict && concatDict > 0, 'missing concat xz dictionary size');
  const concatReport = await concatReader.audit({ limits: { maxXzDictionaryBytes: concatDict } });
  const concatIssue = concatReport.issues.find((issue) => issue.code === 'COMPRESSION_RESOURCE_LIMIT');
  assert.ok(concatIssue, 'missing concat xz resource limit issue');
});
