import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { ZipError, ZipReader, ZipWriter } from 'archive-shield/node/zip';

const PASSWORD = 'archive-shield-password';

async function writeZip(
  entries: Array<{ name: string; data: Uint8Array; method?: 0 | 8 | 93 }>,
  encryption: { type: 'zipcrypto'; password: string } | { type: 'aes'; password: string; strength: 256; vendorVersion: 1 | 2 },
  writerOptions?: Parameters<typeof ZipWriter.toWritable>[1]
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable, writerOptions);
  for (const entry of entries) {
    await writer.add(entry.name, entry.data, {
      method: entry.method ?? 8,
      encryption
    });
  }
  await writer.close();
  return concat(chunks);
}

async function readEntryBytes(reader: ZipReader, name: string, password: string): Promise<Uint8Array> {
  const entry = reader.entries().find((e) => e.name === name);
  assert.ok(entry, `missing entry ${name}`);
  const stream = await reader.open(entry, { password });
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
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

test('zipcrypto roundtrip deflate', async () => {
  const data1 = new TextEncoder().encode('zipcrypto-one');
  const data2 = new TextEncoder().encode('zipcrypto-two');
  const zip = await writeZip(
    [
      { name: 'one.txt', data: data1, method: 8 },
      { name: 'two.txt', data: data2, method: 8 }
    ],
    { type: 'zipcrypto', password: PASSWORD }
  );
  const reader = await ZipReader.fromUint8Array(zip);
  assert.deepEqual(await readEntryBytes(reader, 'one.txt', PASSWORD), data1);
  assert.deepEqual(await readEntryBytes(reader, 'two.txt', PASSWORD), data2);
});

test('aes-256 ae-2 roundtrip deflate', async () => {
  const data = new TextEncoder().encode('aes-256-data');
  const zip = await writeZip([{ name: 'aes.txt', data, method: 8 }], {
    type: 'aes',
    password: PASSWORD,
    strength: 256,
    vendorVersion: 2
  });
  const reader = await ZipReader.fromUint8Array(zip);
  assert.deepEqual(await readEntryBytes(reader, 'aes.txt', PASSWORD), data);
});

test('aes-256 ae-1 roundtrip deflate', async () => {
  const data = new TextEncoder().encode('aes-256-ae1');
  const zip = await writeZip([{ name: 'aes1.txt', data, method: 8 }], {
    type: 'aes',
    password: PASSWORD,
    strength: 256,
    vendorVersion: 1
  });
  const reader = await ZipReader.fromUint8Array(zip);
  assert.deepEqual(await readEntryBytes(reader, 'aes1.txt', PASSWORD), data);
});

test('wrong password yields auth error', async () => {
  const data = new TextEncoder().encode('secret');
  const zip = await writeZip([{ name: 'secret.txt', data, method: 8 }], {
    type: 'zipcrypto',
    password: PASSWORD
  });
  const reader = await ZipReader.fromUint8Array(zip);
  const entry = reader.entries()[0]!;
  await assert.rejects(async () => {
    const stream = await reader.open(entry, { password: 'wrong' });
    await new Response(stream).arrayBuffer();
  }, (err: unknown) => err instanceof ZipError && err.code === 'ZIP_BAD_PASSWORD');
});

test('aes wrong password yields auth error', async () => {
  const data = new TextEncoder().encode('secret-aes');
  const zip = await writeZip([{ name: 'secret.txt', data, method: 8 }], {
    type: 'aes',
    password: PASSWORD,
    strength: 256,
    vendorVersion: 2
  });
  const reader = await ZipReader.fromUint8Array(zip);
  const entry = reader.entries()[0]!;
  await assert.rejects(async () => {
    const stream = await reader.open(entry, { password: 'wrong' });
    await new Response(stream).arrayBuffer();
  }, (err: unknown) => err instanceof ZipError && (err.code === 'ZIP_BAD_PASSWORD' || err.code === 'ZIP_AUTH_FAILED'));
});

test('aes headers and crc rules', async () => {
  const data = new TextEncoder().encode('aes header check');
  const zip = await writeZip([{ name: 'file.txt', data, method: 8 }], {
    type: 'aes',
    password: PASSWORD,
    strength: 256,
    vendorVersion: 2
  });
  const lfhOffset = 0;
  assert.equal(readUint32LE(zip, lfhOffset), 0x04034b50);
  assert.equal(readUint16LE(zip, lfhOffset + 8), 99);
  assert.equal(readUint32LE(zip, lfhOffset + 14), 0);
  const lfhNameLen = readUint16LE(zip, lfhOffset + 26);
  const lfhExtraLen = readUint16LE(zip, lfhOffset + 28);
  const lfhExtra = zip.subarray(30 + lfhNameLen, 30 + lfhNameLen + lfhExtraLen);
  const lfhAesExtra = findExtraField(lfhExtra, 0x9901);
  assert.ok(lfhAesExtra, 'missing AES extra field in local header');
  assert.equal(readUint16LE(lfhAesExtra, 0), 2);
  assert.equal(lfhAesExtra[2], 0x41);
  assert.equal(lfhAesExtra[3], 0x45);
  assert.equal(lfhAesExtra[4], 0x03);

  const eocdOffset = findEocd(zip);
  const cdOffset = readUint32LE(zip, eocdOffset + 16);
  assert.equal(readUint32LE(zip, cdOffset), 0x02014b50);
  assert.equal(readUint16LE(zip, cdOffset + 10), 99);
  assert.equal(readUint32LE(zip, cdOffset + 16), 0);
  const cdNameLen = readUint16LE(zip, cdOffset + 28);
  const cdExtraLen = readUint16LE(zip, cdOffset + 30);
  const cdExtraStart = cdOffset + 46 + cdNameLen;
  const cdExtra = zip.subarray(cdExtraStart, cdExtraStart + cdExtraLen);
  const cdAesExtra = findExtraField(cdExtra, 0x9901);
  assert.ok(cdAesExtra, 'missing AES extra field in central directory');
});

test('seekable patch mode writes encrypted entries without data descriptor', async () => {
  const data = new TextEncoder().encode('seekable aes');
  const filePath = path.join(tmpdir(), `archive-shield-aes-seekable-${Date.now()}.zip`);
  const writer = await ZipWriter.toFile(filePath, { seekable: 'on' });
  await writer.add('file.txt', data, {
    method: 8,
    encryption: { type: 'aes', password: PASSWORD, strength: 256, vendorVersion: 2 }
  });
  await writer.close();
  const zip = new Uint8Array(await readFile(filePath));
  const flags = readUint16LE(zip, 6);
  assert.equal(flags & 0x08, 0, 'data descriptor flag should be clear');
  const reader = await ZipReader.fromFile(filePath);
  assert.deepEqual(await readEntryBytes(reader, 'file.txt', PASSWORD), data);
  await reader.close();
});

test('7z interoperability (optional)', async (t) => {
  const cmd = find7z();
  if (!cmd) {
    t.skip('7z not available');
    return;
  }
  const dir = await makeTempDir();
  try {
    const inputPath = path.join(dir, 'input.txt');
    const content = 'hello-7z';
    await writeFile(inputPath, content);
    const aesZip = path.join(dir, 'aes.zip');
    run7z(cmd, ['a', '-tzip', '-mem=AES256', `-p${PASSWORD}`, aesZip, 'input.txt'], dir);
    const zipcryptoZip = path.join(dir, 'zipcrypto.zip');
    run7z(cmd, ['a', '-tzip', '-mem=ZipCrypto', `-p${PASSWORD}`, zipcryptoZip, 'input.txt'], dir);

    const aesReader = await ZipReader.fromFile(aesZip);
    assert.equal(new TextDecoder().decode(await readEntryBytes(aesReader, 'input.txt', PASSWORD)), content);
    await aesReader.close();

    const zcReader = await ZipReader.fromFile(zipcryptoZip);
    assert.equal(new TextDecoder().decode(await readEntryBytes(zcReader, 'input.txt', PASSWORD)), content);
    await zcReader.close();

    const oursZip = path.join(dir, 'ours.zip');
    const writer = await ZipWriter.toFile(oursZip);
    await writer.add('input.txt', new TextEncoder().encode(content), {
      method: 8,
      encryption: { type: 'aes', password: PASSWORD, strength: 256, vendorVersion: 2 }
    });
    await writer.close();
    run7z(cmd, ['t', `-p${PASSWORD}`, oursZip], dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function findExtraField(extra: Uint8Array, headerId: number): Uint8Array | undefined {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = readUint16LE(extra, offset);
    const size = readUint16LE(extra, offset + 2);
    const start = offset + 4;
    const end = start + size;
    if (end > extra.length) break;
    if (id === headerId) return extra.subarray(start, end);
    offset = end;
  }
  return undefined;
}

function findEocd(buffer: Uint8Array): number {
  const minOffset = Math.max(0, buffer.length - 0x10000 - 22);
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (readUint32LE(buffer, i) === 0x06054b50) {
      return i;
    }
  }
  throw new Error('EOCD not found');
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8);
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset]! |
      (buffer[offset + 1]! << 8) |
      (buffer[offset + 2]! << 16) |
      (buffer[offset + 3]! << 24)) >>>
    0
  );
}

function find7z(): string | undefined {
  for (const cmd of ['7z', '7za']) {
    const res = spawnSync(cmd, ['-h'], { stdio: 'ignore' });
    if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
      continue;
    }
    if (res.status === 0 || res.status === 1) {
      return cmd;
    }
  }
  return undefined;
}

function run7z(cmd: string, args: string[], cwd: string): void {
  const res = spawnSync(cmd, args, { cwd, stdio: 'ignore' });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`${cmd} failed with exit code ${res.status}`);
  }
}

async function makeTempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `archive-shield-7z-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
