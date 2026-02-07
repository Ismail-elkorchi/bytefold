import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openArchive,
  TarWriter,
  tarToFile,
  zipToFile,
  createArchiveWriter,
  ArchiveError,
  ZipError
} from '../dist/bun/index.js';
import {
  CompressionError,
  createCompressor,
  createDecompressor,
  getCompressionCapabilities
} from '../dist/compress/index.js';

const encoder = new TextEncoder();
const ZIP_BUDGET_DIVISOR = 16;
const ZIP_RANGE_BLOCK_SIZE = 64 * 1024;
const ZIP_ETAG_V1 = '"bytefold-etag-v1"';
const ZIP_ETAG_V2 = '"bytefold-etag-v2"';
const ZIP_WEAK_ETAG_V1 = 'W/"bytefold-etag-v1"';
const ZIP_WEAK_ETAG_V2 = 'W/"bytefold-etag-v2"';
const ZIP_LAST_MODIFIED = new Date(0).toUTCString();
type IssueSummary = { code: string; severity: string; entryName?: string };
type AuditOptions = {
  profile?: 'compat' | 'strict' | 'agent';
  strict?: boolean;
  limits?: Record<string, unknown>;
  signal?: AbortSignal;
};
const runtimeVersions = JSON.parse(
  await readFile(new URL('../tools/runtime-versions.json', import.meta.url), 'utf8')
) as { bun?: string };

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
  return concatChunks(chunks);
}

function chunkReadable(input: Uint8Array, sizes: number[]): ReadableStream<Uint8Array> {
  let offset = 0;
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= input.length) {
        controller.close();
        return;
      }
      const size = sizes[index] ?? (input.length - offset);
      index += 1;
      const end = Math.min(input.length, offset + size);
      controller.enqueue(input.subarray(offset, end));
      offset = end;
    }
  });
}

function splitByPattern(total: number, pattern: number[]): number[] {
  const sizes: number[] = [];
  let remaining = total;
  let index = 0;
  while (remaining > 0) {
    const size = pattern[index % pattern.length] ?? 1;
    index += 1;
    const next = Math.min(remaining, Math.max(1, Math.floor(size)));
    sizes.push(next);
    remaining -= next;
  }
  return sizes;
}

async function decompressWithChunks(
  algorithm: 'gzip' | 'bzip2' | 'xz',
  input: Uint8Array,
  sizes: number[]
): Promise<Uint8Array> {
  const readable = chunkReadable(input, sizes);
  const transform = createDecompressor({ algorithm });
  const stream = readable.pipeThrough(transform);
  return collect(stream);
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

async function startRangeServer(
  data: Uint8Array,
  name = 'fixture.xz',
  mode: 'range' | 'no-range' | 'etag-mismatch' = 'range'
): Promise<{
  url: string;
  stats: { bytes: number; rangeBytes: number; requests: number; ranges: string[]; getRequests: number; missingRangeGets: number };
  stop: () => void;
}> {
  const stats = { bytes: 0, rangeBytes: 0, requests: 0, ranges: [] as string[], getRequests: 0, missingRangeGets: 0 };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      stats.requests += 1;
      if (request.method === 'HEAD') {
        const headers = new Headers({ 'content-length': String(data.length) });
        if (mode === 'etag-mismatch') headers.set('etag', ZIP_ETAG_V1);
        return new Response(null, { headers });
      }
      if (request.method === 'GET') stats.getRequests += 1;
      const range = request.headers.get('range');
      if ((mode === 'range' || mode === 'etag-mismatch') && range) {
        stats.ranges.push(range);
        const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
        if (!match) return new Response(null, { status: 416 });
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : data.length - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= data.length) {
          return new Response(null, { status: 416 });
        }
        const safeEnd = Math.min(end, data.length - 1);
        const body = data.subarray(start, safeEnd + 1);
        const payload = new Uint8Array(body).buffer;
        stats.bytes += body.length;
        stats.rangeBytes += body.length;
        return new Response(payload, {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${safeEnd}/${data.length}`,
            'content-length': String(body.length),
            'accept-ranges': 'bytes',
            ...(mode === 'etag-mismatch' ? { etag: ZIP_ETAG_V2 } : {})
          }
        });
      }
      if (request.method === 'GET') stats.missingRangeGets += 1;
      const payload = new Uint8Array(data).buffer;
      stats.bytes += data.length;
      return new Response(payload, { status: 200, headers: { 'content-length': String(data.length) } });
    }
  });
  return {
    url: `http://127.0.0.1:${server.port}/${name}`,
    stats,
    stop: () => server.stop()
  };
}

function zipBudgetFor(size: number): number {
  return Math.ceil(size / ZIP_BUDGET_DIVISOR);
}

function zipRequestBudgetFor(size: number): number {
  return 1 + Math.ceil(zipBudgetFor(size) / ZIP_RANGE_BLOCK_SIZE) + 2;
}

function assertIdentityEncodings(values: (string | undefined)[], label: string): void {
  if (!values.every(isIdentityEncoding)) {
    throw new Error(`${label} unexpected Accept-Encoding values: ${values.join(', ')}`);
  }
}

function assertIfRangeMatches(values: (string | undefined)[], expected: string, label: string): void {
  const present = values.filter((value): value is string => typeof value === 'string');
  if (present.length === 0) {
    throw new Error(`${label} missing If-Range validator`);
  }
  if (!present.every((value) => value === expected)) {
    throw new Error(`${label} unexpected If-Range values: ${present.join(', ')}`);
  }
}

function isIdentityEncoding(value: string | undefined): boolean {
  if (!value) return false;
  const tokens = value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  return tokens.length === 1 && tokens[0] === 'identity';
}

async function startZipRangeServer(
  data: Uint8Array,
  name: string,
  options: {
    mode:
      | 'range'
      | 'no-range'
      | 'no-range-slow'
      | 'head-blocked'
      | 'bad-content-range'
      | 'if-range-200'
      | 'content-encoding'
      | 'content-encoding-slow'
      | 'short-body'
      | 'long-body';
    etag?: string;
    lastModified?: string;
  }
): Promise<{
  url: string;
  stats: {
    bytes: number;
    rangeBytes: number;
    requests: number;
    headRequests: number;
    ranges: string[];
    statuses: number[];
    getRequests: number;
    missingRangeGets: number;
    ifRanges: (string | undefined)[];
    acceptEncodings: (string | undefined)[];
  };
  stop: () => void;
  setEtag: (etag: string) => void;
  setLastModified: (value: string) => void;
  armLongBody: () => void;
}> {
  let currentEtag = options.etag;
  let currentLastModified = options.lastModified;
  let longBodyActive = false;
  const stats = {
    bytes: 0,
    rangeBytes: 0,
    requests: 0,
    headRequests: 0,
    ranges: [] as string[],
    statuses: [] as number[],
    getRequests: 0,
    missingRangeGets: 0,
    ifRanges: [] as (string | undefined)[],
    acceptEncodings: [] as (string | undefined)[]
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      stats.requests += 1;
      const acceptEncoding = request.headers.get('accept-encoding');
      stats.acceptEncodings.push(acceptEncoding ?? undefined);
      const addValidators = (headers: Headers) => {
        if (currentEtag) headers.set('etag', currentEtag);
        if (currentLastModified) headers.set('last-modified', currentLastModified);
      };
      if (request.method === 'HEAD') {
        stats.headRequests += 1;
        if (options.mode === 'head-blocked') {
          stats.statuses.push(405);
          return new Response(null, { status: 405 });
        }
        stats.statuses.push(200);
        const headers = new Headers({ 'content-length': String(data.length) });
        addValidators(headers);
        return new Response(null, { headers });
      }
      if (request.method === 'GET') {
        stats.getRequests += 1;
        const ifRange = request.headers.get('if-range');
        stats.ifRanges.push(ifRange ?? undefined);
      }
      const range = request.headers.get('range');
      if (!range && request.method === 'GET') stats.missingRangeGets += 1;

      if (options.mode === 'if-range-200') {
        const ifRange = request.headers.get('if-range');
        if (range && ifRange && currentEtag && ifRange !== currentEtag) {
          stats.statuses.push(200);
          const headers = new Headers({ 'content-length': String(data.length) });
          addValidators(headers);
          return new Response(chunkedBody(data, stats, { trackRangeBytes: false }), { status: 200, headers });
        }
      }

      if (options.mode === 'no-range' || options.mode === 'no-range-slow') {
        stats.statuses.push(200);
        const headers = new Headers({ 'content-length': String(data.length) });
        addValidators(headers);
        return new Response(
          chunkedBody(data, stats, {
            trackRangeBytes: false,
            chunkSize: options.mode === 'no-range-slow' ? 512 : 16 * 1024,
            delay: options.mode === 'no-range-slow'
          }),
          { status: 200, headers }
        );
      }

      if (!range) {
        stats.statuses.push(200);
        const headers = new Headers({ 'content-length': String(data.length) });
        addValidators(headers);
        return new Response(chunkedBody(data, stats, { trackRangeBytes: false }), { status: 200, headers });
      }

      stats.ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (!match) {
        stats.statuses.push(416);
        return new Response(null, { status: 416 });
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : data.length - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= data.length) {
        stats.statuses.push(416);
        return new Response(null, { status: 416 });
      }
      const safeEnd = Math.min(end, data.length - 1);
      const body = data.subarray(start, safeEnd + 1);
      stats.statuses.push(206);
      const headers = new Headers({ 'accept-ranges': 'bytes' });
      if (options.mode === 'content-encoding' || options.mode === 'content-encoding-slow') {
        headers.set('content-encoding', 'gzip');
      }
      if (options.mode === 'bad-content-range') {
        headers.set('content-range', 'bytes 0-0/*');
      } else {
        headers.set('content-range', `bytes ${start}-${safeEnd}/${data.length}`);
      }
      addValidators(headers);

      if (options.mode === 'short-body') {
        headers.set('content-length', String(body.length));
        const truncated = body.subarray(0, Math.max(0, body.length - 1));
        return new Response(chunkedBody(truncated, stats, { trackRangeBytes: true }), { status: 206, headers });
      }

      if (options.mode === 'long-body' && longBodyActive) {
        const extended = new Uint8Array(body.length + 1);
        extended.set(body, 0);
        extended[extended.length - 1] = 0x42;
        return new Response(
          chunkedBody(extended, stats, { trackRangeBytes: true, chunkSize: 256, delay: true }),
          { status: 206, headers }
        );
      }

      if (options.mode === 'content-encoding-slow') {
        return new Response(chunkedBody(body, stats, { trackRangeBytes: true, chunkSize: 512, delay: true }), {
          status: 206,
          headers
        });
      }

      headers.set('content-length', String(body.length));
      return new Response(chunkedBody(body, stats, { trackRangeBytes: true }), { status: 206, headers });
    }
  });

  return {
    url: `http://127.0.0.1:${server.port}/${name}`,
    stats,
    stop: () => server.stop(),
    setEtag: (etag: string) => {
      currentEtag = etag;
    },
    setLastModified: (value: string) => {
      currentLastModified = value;
    },
    armLongBody: () => {
      longBodyActive = true;
    }
  };
}

function chunkedBody(
  data: Uint8Array,
  stats: { bytes: number; rangeBytes?: number },
  options: { trackRangeBytes: boolean; chunkSize?: number; delay?: boolean }
): ReadableStream<Uint8Array> {
  const chunkSize = options.chunkSize ?? 16 * 1024;
  let offset = 0;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) {
        controller.close();
        return;
      }
      if (offset >= data.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, data.length);
      const chunk = data.subarray(offset, end);
      stats.bytes += chunk.length;
      if (options.trackRangeBytes && typeof stats.rangeBytes === 'number') {
        stats.rangeBytes += chunk.length;
      }
      offset = end;
      controller.enqueue(chunk);
      if (options.delay) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    cancel() {
      cancelled = true;
    }
  });
}

function expectedTailRanges(size: number, blockSize: number, tailSize: number): string[] {
  const start = size - tailSize;
  if (start < 0) {
    if (size <= 0) return [];
    return [`bytes=0-${size - 1}`];
  }
  const startBlock = Math.floor(start / blockSize) * blockSize;
  const endOffset = size - 1;
  const endBlock = Math.floor(endOffset / blockSize) * blockSize;
  if (startBlock === endBlock) {
    return [`bytes=${startBlock}-${endOffset}`];
  }
  const ranges: string[] = [];
  for (let block = startBlock; block <= endBlock; block += blockSize) {
    const end = Math.min(block + blockSize - 1, endOffset);
    ranges.push(`bytes=${block}-${end}`);
  }
  return ranges;
}

function sumRangeBytes(ranges: string[]): number {
  let total = 0;
  for (const range of ranges) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    total += end - start + 1;
  }
  return total;
}

function assertVersion(runtime: string, actual: string, requirement: string): void {
  const minimum = parseRequirement(requirement);
  const current = parseSemver(actual);
  if (!current || compareSemver(current, minimum) < 0) {
    throw new Error(`${runtime} ${actual} does not satisfy required ${requirement}`);
  }
}

function parseRequirement(value: string) {
  const match = value.match(/>=\s*(\d+\.\d+\.\d+)/);
  if (!match) throw new Error(`invalid runtime requirement: ${value}`);
  const parsed = parseSemver(match[1]!);
  if (!parsed) throw new Error(`invalid runtime requirement: ${value}`);
  return parsed;
}

function parseSemver(value: string) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSemver(a: { major: number; minor: number; patch: number }, b: { major: number; minor: number; patch: number }) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

const bunTest = test as unknown as (name: string, fn: () => Promise<void>, timeout?: number) => void;

bunTest('bun smoke: zip, tar, tgz', async () => {
  const bunVersion = Bun.version;
  if (!bunVersion) throw new Error('Bun.version missing');
  assertVersion('bun', bunVersion, runtimeVersions.bun ?? '>=1.3.3');
  const coreUrl = new URL('../dist/index.js', import.meta.url);
  const coreModule = await import(coreUrl.href);
  if (typeof coreModule.openArchive !== 'function') throw new Error('default entrypoint missing openArchive');
  const corePath = fileURLToPath(coreUrl);
  const coreSource = new TextDecoder().decode(new Uint8Array(await Bun.file(corePath).arrayBuffer()));
  if (/from\\s+['\"]node:/.test(coreSource) || /import\\s+['\"]node:/.test(coreSource)) {
    throw new Error('default entrypoint imports node:*');
  }

  const tmp = await mkdtemp(path.join(tmpdir(), 'bytefold-bun-'));
  const zipPath = path.join(tmp, 'smoke.zip');
  const tarPath = path.join(tmp, 'smoke.tar');
  const tgzPath = path.join(tmp, 'smoke.tgz');

  try {
    const zipWriter = await zipToFile(zipPath);
    await zipWriter.add('hello.txt', encoder.encode('hello bun'));
    await zipWriter.close();

    const tarWriter = await tarToFile(tarPath);
    await tarWriter.add('greet.txt', encoder.encode('hello tar'));
    await tarWriter.close();

    const tarChunks: Uint8Array[] = [];
    const tarWritable = new WritableStream<Uint8Array>({
      write(chunk) {
        tarChunks.push(chunk);
      }
    });
    const tarWriterMem = TarWriter.toWritable(tarWritable);
    await tarWriterMem.add('tgz.txt', encoder.encode('hello tgz'));
    await tarWriterMem.close();
    const tarBytes = concatChunks(tarChunks);
    const gzipTransform = new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    const gzStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(tarBytes);
        controller.close();
      }
    }).pipeThrough(gzipTransform);
    const tgzBytes = await collect(gzStream);
    await Bun.write(tgzPath, tgzBytes);

    const zipArchive = await openArchive(zipPath);
    const entries = [] as string[];
    for await (const entry of zipArchive.entries()) {
      entries.push(entry.name);
    }
    expect(entries).toEqual(['hello.txt']);

    const tarArchive = await openArchive(tarPath);
    let sawTar = false;
    for await (const entry of tarArchive.entries()) {
      if (entry.name !== 'greet.txt') continue;
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'hello tar') throw new Error('tar content mismatch');
      sawTar = true;
    }
    if (!sawTar) throw new Error('tar missing greet.txt');

    const tgzArchive = await openArchive(tgzPath);
    expect(tgzArchive.format).toBe('tgz');
    let sawTgz = false;
    for await (const entry of tgzArchive.entries()) {
      if (entry.name !== 'tgz.txt') continue;
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'hello tgz') throw new Error('tgz content mismatch');
      sawTgz = true;
    }
    if (!sawTgz) throw new Error('tgz missing tgz.txt');

    const tgzChunks: Uint8Array[] = [];
    const tgzWritable = new WritableStream<Uint8Array>({
      write(chunk) {
        tgzChunks.push(chunk);
      }
    });
    const tgzWriter = createArchiveWriter('tgz', tgzWritable);
    await tgzWriter.add('alpha.txt', encoder.encode('tgz writer'));
    await tgzWriter.add('beta.bin', new Uint8Array([1, 2, 3]));
    await tgzWriter.close();
    const tgzOutput = concatChunks(tgzChunks);
    const tgzWriterArchive = await openArchive(tgzOutput);
    if (tgzWriterArchive.format !== 'tgz') throw new Error('tgz writer output not detected');
    const tgzEntries: Record<string, Uint8Array> = {};
    for await (const entry of tgzWriterArchive.entries()) {
      tgzEntries[entry.name] = await collect(await entry.open());
    }
    if (new TextDecoder().decode(tgzEntries['alpha.txt'] ?? new Uint8Array()) !== 'tgz writer') {
      throw new Error('tgz writer content mismatch');
    }
    const beta = tgzEntries['beta.bin'];
    if (!beta || beta.length !== 3 || beta[0] !== 1 || beta[1] !== 2 || beta[2] !== 3) {
      throw new Error('tgz writer binary mismatch');
    }

    const gzChunks: Uint8Array[] = [];
    const gzWritable = new WritableStream<Uint8Array>({
      write(chunk) {
        gzChunks.push(chunk);
      }
    });
    const gzWriter = createArchiveWriter('gz', gzWritable);
    await gzWriter.add('hello.txt', encoder.encode('gz writer'));
    await gzWriter.close();
    const gzOutput = concatChunks(gzChunks);
    const gzWriterArchive = await openArchive(gzOutput, { filename: 'hello.txt.gz' });
    if (gzWriterArchive.format !== 'gz') throw new Error('gz writer output not detected');
    for await (const entry of gzWriterArchive.entries()) {
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'gz writer') throw new Error('gz writer content mismatch');
    }

    const caps = getCompressionCapabilities();
    if (new Set(caps.notes).size !== caps.notes.length) {
      throw new Error('compression capabilities notes contain duplicates');
    }
    const algorithms: Array<'gzip' | 'deflate-raw' | 'deflate' | 'brotli' | 'zstd' | 'bzip2' | 'xz'> = [
      'gzip',
      'deflate-raw',
      'deflate',
      'brotli',
      'zstd',
      'bzip2',
      'xz'
    ];
    const requiredAlgorithms: Array<'gzip' | 'deflate-raw' | 'deflate' | 'brotli' | 'zstd'> = [
      'gzip',
      'deflate-raw',
      'deflate',
      'brotli',
      'zstd'
    ];
    for (const algorithm of requiredAlgorithms) {
      const support = caps.algorithms[algorithm];
      if (!support.compress || !support.decompress) {
        throw new Error(`Bun runtime missing ${algorithm} support; requires ${runtimeVersions.bun ?? '>=1.3.3'}`);
      }
    }
    const unsupportedCompress = algorithms.find((algorithm) => !caps.algorithms[algorithm].compress);
    if (unsupportedCompress) {
      let error: unknown;
      try {
        createCompressor({ algorithm: unsupportedCompress });
      } catch (err) {
        error = err;
      }
      if (!(error instanceof CompressionError) || error.code !== 'COMPRESSION_UNSUPPORTED_ALGORITHM') {
        throw new Error(`expected CompressionError for ${unsupportedCompress} compression`);
      }
    }
    const unsupportedDecompress = algorithms.find((algorithm) => !caps.algorithms[algorithm].decompress);
    if (unsupportedDecompress) {
      let error: unknown;
      try {
        createDecompressor({ algorithm: unsupportedDecompress });
      } catch (err) {
        error = err;
      }
      if (!(error instanceof CompressionError) || error.code !== 'COMPRESSION_UNSUPPORTED_ALGORITHM') {
        throw new Error(`expected CompressionError for ${unsupportedDecompress} decompression`);
      }
    }
    for (const algorithm of algorithms) {
      const support = caps.algorithms[algorithm];
      if (!support.compress || !support.decompress) continue;
      const compressor = createCompressor({ algorithm });
      const decompressor = createDecompressor({ algorithm });
      const roundtrip = await collect(
        readableFromBytes(encoder.encode('bytefold-compress-bun')).pipeThrough(compressor).pipeThrough(decompressor)
      );
      const text = new TextDecoder().decode(roundtrip);
      expect(text).toBe('bytefold-compress-bun');
    }

    const { validateSchema } = (await import(new URL('./schema-validator.ts', import.meta.url).href)) as {
      validateSchema: (schema: Record<string, unknown>, value: unknown) => { ok: boolean; errors: string[] };
    };
    const capabilitiesSchema = JSON.parse(
      await readFile(new URL('../schemas/capabilities-report.schema.json', import.meta.url), 'utf8')
    ) as Record<string, unknown>;
    const auditSchema = JSON.parse(
      await readFile(new URL('../schemas/audit-report.schema.json', import.meta.url), 'utf8')
    ) as Record<string, unknown>;
    const detectionSchema = JSON.parse(
      await readFile(new URL('../schemas/detection-report.schema.json', import.meta.url), 'utf8')
    ) as Record<string, unknown>;
    const normalizeSchema = JSON.parse(
      await readFile(new URL('../schemas/normalize-report.schema.json', import.meta.url), 'utf8')
    ) as Record<string, unknown>;
    const errorSchema = JSON.parse(
      await readFile(new URL('../schemas/error.schema.json', import.meta.url), 'utf8')
    ) as Record<string, unknown>;
    const capsResult = validateSchema(capabilitiesSchema, caps);
    if (!capsResult.ok) {
      throw new Error(`capabilities schema validation failed: ${capsResult.errors.join('\\n')}`);
    }

    await assertAuditNormalizeRoundtrip(zipArchive, auditSchema, normalizeSchema, validateSchema);
    await assertAuditNormalizeRoundtrip(tarArchive, auditSchema, normalizeSchema, validateSchema);
    await assertAuditNormalizeRoundtrip(tgzArchive, auditSchema, normalizeSchema, validateSchema);

    const abortAlgorithm = algorithms.find(
      (algorithm) => caps.algorithms[algorithm].compress && caps.algorithms[algorithm].decompress
    );
    if (abortAlgorithm) {
      const controller = new AbortController();
      let aborted = false;
      const compressor = createCompressor({
        algorithm: abortAlgorithm,
        signal: controller.signal,
        onProgress: () => {
          if (!aborted) {
            aborted = true;
            controller.abort();
          }
        }
      });
      let abortedOk = false;
      try {
        await collect(
          new ReadableStream<Uint8Array>({
            pull(ctrl) {
              ctrl.enqueue(new Uint8Array(64 * 1024));
            }
          }).pipeThrough(compressor)
        );
      } catch {
        abortedOk = true;
      }
      expect(abortedOk).toBe(true);
    }

    const tarBz2Path = fileURLToPath(new URL('../test/fixtures/fixture.tar.bz2', import.meta.url));
    const tarBz2Bytes = new Uint8Array(await Bun.file(tarBz2Path).arrayBuffer());
    const tarBz2Archive = await openArchive(tarBz2Bytes);
    expect(tarBz2Archive.format).toBe('tar.bz2');
    let sawHello = false;
    for await (const entry of tarBz2Archive.entries()) {
      if (entry.name !== 'hello.txt') continue;
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'hello tar.bz2\n') throw new Error('tar.bz2 content mismatch');
      sawHello = true;
    }
    if (!sawHello) throw new Error('tar.bz2 missing hello.txt');
    await assertAuditNormalizeRoundtrip(tarBz2Archive, auditSchema, normalizeSchema, validateSchema);

    const xzPath = fileURLToPath(new URL('../test/fixtures/hello.txt.xz', import.meta.url));
    const xzBytes = new Uint8Array(await Bun.file(xzPath).arrayBuffer());
    const xzArchive = await openArchive(xzBytes);
    if (xzArchive.format !== 'xz') throw new Error('xz format not detected');
    let sawXzHello = false;
    for await (const entry of xzArchive.entries()) {
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'hello from bytefold\n') throw new Error('xz content mismatch');
      sawXzHello = true;
    }
    if (!sawXzHello) throw new Error('xz missing entry');

    const xzPaddedPath = fileURLToPath(new URL('../test/fixtures/xz-padding-4m.xz', import.meta.url));
    const xzPaddedBytes = new Uint8Array(await Bun.file(xzPaddedPath).arrayBuffer());
    const xzPaddedArchive = await openArchive(xzPaddedBytes, { filename: 'xz-padding-4m.xz' });
    if (xzPaddedArchive.format !== 'xz') throw new Error('xz padded format not detected');
    let sawXzPadded = false;
    for await (const entry of xzPaddedArchive.entries()) {
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'hello from bytefold\n') throw new Error('xz padded content mismatch');
      sawXzPadded = true;
    }
    if (!sawXzPadded) throw new Error('xz padded missing entry');

    const bcjFixtures: Array<{ fixture: string; expected: string; expectedRoot?: string }> = [
      { fixture: 'x86.xz', expected: 'xz-bcj-x86.bin' },
      { fixture: 'powerpc.xz', expected: 'xz-bcj-powerpc.bin' },
      { fixture: 'ia64.xz', expected: 'xz-bcj-ia64.bin' },
      { fixture: 'arm.xz', expected: 'xz-bcj-arm.bin' },
      { fixture: 'armthumb.xz', expected: 'xz-bcj-armthumb.bin' },
      { fixture: 'sparc.xz', expected: 'xz-bcj-sparc.bin' },
      { fixture: 'arm64.xz', expected: 'xz-bcj-arm64.bin' },
      { fixture: 'riscv.xz', expected: 'xz-bcj-riscv.bin' },
      {
        fixture: 'startoffset-multiblock-x86.xz',
        expected: 'startoffset-multiblock-x86.bin',
        expectedRoot: 'xz-bcj'
      }
    ];
    for (const { fixture, expected, expectedRoot } of bcjFixtures) {
      const fixturePath = fileURLToPath(new URL(`../test/fixtures/xz-bcj/${fixture}`, import.meta.url));
      const expectedPath = fileURLToPath(
        new URL(`../test/fixtures/${expectedRoot ?? 'expected'}/${expected}`, import.meta.url)
      );
      const bytes = new Uint8Array(await Bun.file(fixturePath).arrayBuffer());
      const expectedBytes = new Uint8Array(await Bun.file(expectedPath).arrayBuffer());
      const archive = await openArchive(bytes);
      if (archive.format !== 'xz') throw new Error(`xz bcj format not detected (${fixture})`);
      let sawEntry = false;
      for await (const entry of archive.entries()) {
        const data = await collect(await entry.open());
        assertBytesEqual(data, expectedBytes, `xz bcj payload mismatch (${fixture})`);
        sawEntry = true;
      }
      if (!sawEntry) throw new Error(`xz bcj missing entry (${fixture})`);
    }

    {
      const thirdZipPath = fileURLToPath(
        new URL('../test/fixtures/thirdparty/zip/zip_cp437_header.zip', import.meta.url)
      );
      const thirdZipBytes = new Uint8Array(await Bun.file(thirdZipPath).arrayBuffer());
      const thirdZipArchive = await openArchive(thirdZipBytes, { format: 'zip' });
      if (thirdZipArchive.format !== 'zip') throw new Error('third-party zip format not detected');
      let sawZipEntry = false;
      for await (const entry of thirdZipArchive.entries()) {
        if (entry.name) sawZipEntry = true;
      }
      if (!sawZipEntry) throw new Error('third-party zip missing entries');
    }

    {
      const thirdTarPath = fileURLToPath(new URL('../test/fixtures/thirdparty/tar/pax.tar', import.meta.url));
      const thirdTarBytes = new Uint8Array(await Bun.file(thirdTarPath).arrayBuffer());
      const thirdTarArchive = await openArchive(thirdTarBytes, { format: 'tar' });
      if (thirdTarArchive.format !== 'tar') throw new Error('third-party tar format not detected');
      let sawTarEntry = false;
      for await (const entry of thirdTarArchive.entries()) {
        if (entry.name) sawTarEntry = true;
      }
      if (!sawTarEntry) throw new Error('third-party tar missing entries');
    }

    {
      const gzipHeaderPath = fileURLToPath(new URL('../test/fixtures/gzip-header-options.gz', import.meta.url));
      const gzipExpectedPath = fileURLToPath(new URL('../test/fixtures/expected/hello.txt', import.meta.url));
      const gzipHeaderBytes = new Uint8Array(await Bun.file(gzipHeaderPath).arrayBuffer());
      const gzipExpected = new Uint8Array(await Bun.file(gzipExpectedPath).arrayBuffer());
      const gzipArchive = await openArchive(gzipHeaderBytes, { format: 'gz' });
      if (gzipArchive.format !== 'gz') throw new Error('gzip header fixture format not detected');
      let sawGzipEntry = false;
      for await (const entry of gzipArchive.entries()) {
        const data = await collect(await entry.open());
        assertBytesEqual(data, gzipExpected, 'gzip header payload mismatch');
        if (entry.name !== 'hello.txt') throw new Error('gzip header name mismatch');
        sawGzipEntry = true;
      }
      if (!sawGzipEntry) throw new Error('gzip header missing entry');
      const report = await gzipArchive.audit();
      if (!report.ok) throw new Error('gzip header audit failed');
    }

    {
      const fhcrcOkPath = fileURLToPath(new URL('../test/fixtures/gzip-fhcrc-ok.gz', import.meta.url));
      const fhcrcBadPath = fileURLToPath(new URL('../test/fixtures/gzip-fhcrc-bad.gz', import.meta.url));
      const expectedPath = fileURLToPath(new URL('../test/fixtures/expected/hello.txt', import.meta.url));
      const fhcrcOkBytes = new Uint8Array(await Bun.file(fhcrcOkPath).arrayBuffer());
      const fhcrcExpected = new Uint8Array(await Bun.file(expectedPath).arrayBuffer());
      const okArchive = await openArchive(fhcrcOkBytes, { format: 'gz' });
      if (okArchive.format !== 'gz') throw new Error('gzip fhcrc format not detected');
      let sawOk = false;
      for await (const entry of okArchive.entries()) {
        const data = await collect(await entry.open());
        assertBytesEqual(data, fhcrcExpected, 'gzip fhcrc payload mismatch');
        if (entry.name !== 'hello.txt') throw new Error('gzip fhcrc name mismatch');
        sawOk = true;
      }
      if (!sawOk) throw new Error('gzip fhcrc missing entry');

      const fhcrcBadBytes = new Uint8Array(await Bun.file(fhcrcBadPath).arrayBuffer());
      let sawError = false;
      try {
        await openArchive(fhcrcBadBytes, { format: 'gz' });
      } catch (err) {
        if (!(err instanceof CompressionError)) throw err;
        if (err.code !== 'COMPRESSION_GZIP_BAD_HEADER') {
          throw new Error(`unexpected gzip fhcrc error: ${err.code}`);
        }
        const result = validateSchema(errorSchema, err.toJSON());
        if (!result.ok) {
          throw new Error(`gzip fhcrc error schema failed: ${result.errors.join('\\n')}`);
        }
        sawError = true;
      }
      if (!sawError) throw new Error('gzip fhcrc bad fixture did not throw');
    }

    {
      const mixedPath = fileURLToPath(new URL('../test/fixtures/xz-mixed/delta-x86-lzma2.xz', import.meta.url));
      const mixedExpectedPath = fileURLToPath(
        new URL('../test/fixtures/xz-mixed/delta-x86-lzma2.bin', import.meta.url)
      );
      const mixedBytes = new Uint8Array(await Bun.file(mixedPath).arrayBuffer());
      const mixedExpected = new Uint8Array(await Bun.file(mixedExpectedPath).arrayBuffer());
      const mixedArchive = await openArchive(mixedBytes);
      if (mixedArchive.format !== 'xz') throw new Error('xz mixed filters format not detected');
      let sawMixed = false;
      for await (const entry of mixedArchive.entries()) {
        const data = await collect(await entry.open());
        assertBytesEqual(data, mixedExpected, 'xz mixed filters payload mismatch');
        sawMixed = true;
      }
      if (!sawMixed) throw new Error('xz mixed filters missing entry');
    }

    {
      const concatPath = fileURLToPath(
        new URL('../test/fixtures/xz-concat/concat-two-streams-bcj.xz', import.meta.url)
      );
      const concatExpectedPath = fileURLToPath(
        new URL('../test/fixtures/xz-concat/concat-two-streams-bcj.bin', import.meta.url)
      );
      const concatBytes = new Uint8Array(await Bun.file(concatPath).arrayBuffer());
      const concatExpected = new Uint8Array(await Bun.file(concatExpectedPath).arrayBuffer());
      const concatArchive = await openArchive(concatBytes);
      if (concatArchive.format !== 'xz') throw new Error('xz concat bcj format not detected');
      let sawConcat = false;
      for await (const entry of concatArchive.entries()) {
        const data = await collect(await entry.open());
        assertBytesEqual(data, concatExpected, 'xz concat bcj payload mismatch');
        sawConcat = true;
      }
      if (!sawConcat) throw new Error('xz concat bcj missing entry');
    }

    {
      const chunkPath = fileURLToPath(new URL('../test/fixtures/xz-bcj/x86.xz', import.meta.url));
      const chunkBytes = new Uint8Array(await Bun.file(chunkPath).arrayBuffer());
      const expectedPath = fileURLToPath(new URL('../test/fixtures/expected/xz-bcj-x86.bin', import.meta.url));
      const chunkExpected = new Uint8Array(await Bun.file(expectedPath).arrayBuffer());
      const sizesA = splitByPattern(chunkBytes.length, [1, 2, 3, 5, 8, 13]);
      const sizesB = [chunkBytes.length];
      const outputA = await decompressWithChunks('xz', chunkBytes, sizesA);
      const outputB = await decompressWithChunks('xz', chunkBytes, sizesB);
      assertBytesEqual(outputA, chunkExpected, 'xz chunking expected mismatch (A)');
      assertBytesEqual(outputB, chunkExpected, 'xz chunking expected mismatch (B)');
      assertBytesEqual(outputA, outputB, 'xz chunking invariance mismatch');
    }

    const xzShaPath = fileURLToPath(new URL('../test/fixtures/xz-check-sha256.xz', import.meta.url));
    const xzShaBytes = new Uint8Array(await Bun.file(xzShaPath).arrayBuffer());
    const xzShaExpected = new Uint8Array(
      await Bun.file(fileURLToPath(new URL('../test/fixtures/expected/xz-check-sha256.bin', import.meta.url))).arrayBuffer()
    );
    const xzShaArchive = await openArchive(xzShaBytes);
    if (xzShaArchive.format !== 'xz') throw new Error('xz sha256 format not detected');
    let sawSha = false;
    for await (const entry of xzShaArchive.entries()) {
      const data = await collect(await entry.open());
      assertBytesEqual(data, xzShaExpected, 'xz sha256 payload mismatch');
      sawSha = true;
    }
    if (!sawSha) throw new Error('xz sha256 missing entry');

    const txzPath = fileURLToPath(new URL('../test/fixtures/fixture.tar.xz', import.meta.url));
    const txzBytes = new Uint8Array(await Bun.file(txzPath).arrayBuffer());
    const txzArchive = await openArchive(txzBytes);
    if (txzArchive.format !== 'tar.xz') throw new Error('tar.xz format not detected');
    let sawTxzHello = false;
    for await (const entry of txzArchive.entries()) {
      if (entry.name !== 'hello.txt') continue;
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'hello from bytefold\n') throw new Error('tar.xz content mismatch');
      sawTxzHello = true;
    }
    if (!sawTxzHello) throw new Error('tar.xz missing hello.txt');
    await assertAuditNormalizeRoundtrip(txzArchive, auditSchema, normalizeSchema, validateSchema);

    const tzstPath = fileURLToPath(new URL('../test/fixtures/fixture.tar.zst', import.meta.url));
    const tzstBytes = new Uint8Array(await Bun.file(tzstPath).arrayBuffer());
    const tzstArchive = await openArchive(tzstBytes);
    if (tzstArchive.format !== 'tar.zst') throw new Error('tar.zst format not detected');
    let sawTzstHello = false;
    for await (const entry of tzstArchive.entries()) {
      if (entry.name !== 'hello.txt') continue;
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'hello fixture\n') throw new Error('tar.zst fixture content mismatch');
      sawTzstHello = true;
    }
    if (!sawTzstHello) throw new Error('tar.zst fixture missing hello.txt');
    await assertAuditNormalizeRoundtrip(tzstArchive, auditSchema, normalizeSchema, validateSchema);

    const tbrPath = fileURLToPath(new URL('../test/fixtures/fixture.tar.br', import.meta.url));
    const tbrBytes = new Uint8Array(await Bun.file(tbrPath).arrayBuffer());
    const tbrArchive = await openArchive(tbrBytes, { format: 'tar.br' });
    if (tbrArchive.format !== 'tar.br') throw new Error('tar.br format not detected');
    let sawTbrHello = false;
    for await (const entry of tbrArchive.entries()) {
      if (entry.name !== 'hello.txt') continue;
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'hello fixture\n') throw new Error('tar.br fixture content mismatch');
      sawTbrHello = true;
    }
    if (!sawTbrHello) throw new Error('tar.br fixture missing hello.txt');
    await assertAuditNormalizeRoundtrip(tbrArchive, auditSchema, normalizeSchema, validateSchema);

    const expectedHello = new TextDecoder().decode(
      new Uint8Array(await Bun.file(fileURLToPath(new URL('../test/fixtures/expected/hello.txt', import.meta.url))).arrayBuffer())
    );

    const gzPath = fileURLToPath(new URL('../test/fixtures/hello.txt.gz', import.meta.url));
    const gzBytes = new Uint8Array(await Bun.file(gzPath).arrayBuffer());
    const gzArchive = await openArchive(gzBytes, { filename: 'hello.txt.gz' });
    if (gzArchive.format !== 'gz') throw new Error('gz format not detected');
    for await (const entry of gzArchive.entries()) {
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== expectedHello) throw new Error('gz content mismatch');
    }
    await assertSingleFileAuditNormalize(gzArchive, auditSchema, errorSchema, validateSchema);

    const brPath = fileURLToPath(new URL('../test/fixtures/hello.txt.br', import.meta.url));
    const brBytes = new Uint8Array(await Bun.file(brPath).arrayBuffer());
    const brArchive = await openArchive(brBytes, { format: 'br', filename: 'hello.txt.br' });
    if (brArchive.format !== 'br') throw new Error('br format not detected');
    for await (const entry of brArchive.entries()) {
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== expectedHello) throw new Error('br content mismatch');
    }
    await assertSingleFileAuditNormalize(brArchive, auditSchema, errorSchema, validateSchema);

    const zstPath = fileURLToPath(new URL('../test/fixtures/hello.txt.zst', import.meta.url));
    const zstBytes = new Uint8Array(await Bun.file(zstPath).arrayBuffer());
    const zstArchive = await openArchive(zstBytes, { filename: 'hello.txt.zst' });
    if (zstArchive.format !== 'zst') throw new Error('zst format not detected');
    for await (const entry of zstArchive.entries()) {
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== expectedHello) throw new Error('zst content mismatch');
    }
    await assertSingleFileAuditNormalize(zstArchive, auditSchema, errorSchema, validateSchema);

    const bz2Path = fileURLToPath(new URL('../test/fixtures/hello.txt.bz2', import.meta.url));
    const bz2Bytes = new Uint8Array(await Bun.file(bz2Path).arrayBuffer());
    const bz2Archive = await openArchive(bz2Bytes, { filename: 'hello.txt.bz2' });
    if (bz2Archive.format !== 'bz2') throw new Error('bz2 format not detected');
    for await (const entry of bz2Archive.entries()) {
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'hello bzip2\n') throw new Error('bz2 content mismatch');
    }
    await assertSingleFileAuditNormalize(bz2Archive, auditSchema, errorSchema, validateSchema);

    const singleXzPath = fileURLToPath(new URL('../test/fixtures/hello.txt.xz', import.meta.url));
    const singleXzBytes = new Uint8Array(await Bun.file(singleXzPath).arrayBuffer());
    const singleXzArchive = await openArchive(singleXzBytes);
    if (singleXzArchive.format !== 'xz') throw new Error('xz format not detected');
    for await (const entry of singleXzArchive.entries()) {
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'hello from bytefold\n') throw new Error('xz single-file mismatch');
    }
    await assertSingleFileAuditNormalize(singleXzArchive, auditSchema, errorSchema, validateSchema);

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/hello.txt.bz2', import.meta.url))).arrayBuffer()
      );
      let error: unknown;
      try {
        await openArchive(bytes, { filename: 'hello.txt.bz2', limits: { maxBzip2BlockSize: 1 } });
      } catch (err) {
        error = err;
      }
      if (!(error instanceof CompressionError) || error.code !== 'COMPRESSION_RESOURCE_LIMIT') {
        throw new Error('expected bzip2 resource limit error');
      }
      const json = error.toJSON() as { context?: Record<string, string> };
      const result = validateSchema(errorSchema, json);
      if (!result.ok) {
        throw new Error(`bzip2 resource error schema failed: ${result.errors.join('\\n')}`);
      }
      if (!json.context?.requiredBlockSize || !json.context?.limitBlockSize) {
        throw new Error('bzip2 resource error missing context');
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/concat-limit.bz2', import.meta.url))).arrayBuffer()
      );
      let error: unknown;
      try {
        await openArchive(bytes, { filename: 'concat-limit.bz2', limits: { maxBzip2BlockSize: 1 } });
      } catch (err) {
        error = err;
      }
      if (!(error instanceof CompressionError) || error.code !== 'COMPRESSION_RESOURCE_LIMIT') {
        throw new Error('expected concatenated bzip2 resource limit error');
      }
      const json = error.toJSON() as { context?: Record<string, string> };
      const result = validateSchema(errorSchema, json);
      if (!result.ok) {
        throw new Error(`concat bzip2 resource error schema failed: ${result.errors.join('\\n')}`);
      }
      if (!json.context?.requiredBlockSize || !json.context?.limitBlockSize) {
        throw new Error('concat bzip2 resource error missing context');
      }
      const reader = await openArchive(bytes, { filename: 'concat-limit.bz2' });
      const report = await reader.audit({ limits: { maxBzip2BlockSize: 1 } });
      const preflightIssue = report.issues.find(
        (issue) => issue.code === 'COMPRESSION_RESOURCE_PREFLIGHT_INCOMPLETE'
      );
      if (!preflightIssue) throw new Error('missing bzip2 preflight incomplete issue');
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/hello.txt.xz', import.meta.url))).arrayBuffer()
      );
      let error: unknown;
      try {
        await openArchive(bytes, { filename: 'hello.txt.xz', limits: { maxXzDictionaryBytes: 1024 } });
      } catch (err) {
        error = err;
      }
      if (!(error instanceof CompressionError) || error.code !== 'COMPRESSION_RESOURCE_LIMIT') {
        throw new Error('expected xz resource limit error');
      }
      const json = error.toJSON() as { context?: Record<string, string> };
      const result = validateSchema(errorSchema, json);
      if (!result.ok) {
        throw new Error(`xz resource error schema failed: ${result.errors.join('\\n')}`);
      }
      if (!json.context?.requiredDictionaryBytes || !json.context?.limitDictionaryBytes) {
        throw new Error('xz resource error missing context');
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/xz-check-sha256.xz', import.meta.url))).arrayBuffer()
      );
      const expected = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/expected/xz-check-sha256.bin', import.meta.url))).arrayBuffer()
      );
      const mutated = new Uint8Array(bytes);
      const checkOffset = locateBlockCheckOffset(mutated, expected.length);
      mutated[checkOffset] = (mutated[checkOffset] ?? 0) ^ 0xff;
      let error: unknown;
      try {
        const reader = await openArchive(mutated);
        for await (const entry of reader.entries()) {
          await collect(await entry.open());
        }
      } catch (err) {
        error = err;
      }
      if (!(error instanceof CompressionError) || error.code !== 'COMPRESSION_XZ_BAD_CHECK') {
        throw new Error('expected xz sha256 check error');
      }
      if (error.context?.check !== 'sha256') throw new Error('expected sha256 check context');
      const json = error.toJSON() as { context?: Record<string, string> };
      const result = validateSchema(errorSchema, json);
      if (!result.ok) {
        throw new Error(`xz sha256 error schema failed: ${result.errors.join('\\n')}`);
      }
      if (!json.context?.check) throw new Error('xz sha256 error missing context');
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/concat-limit.xz', import.meta.url))).arrayBuffer()
      );
      const dict = readXzDictionarySize(bytes);
      if (!dict) throw new Error('concat xz dictionary size missing');
      let error: unknown;
      try {
        await openArchive(bytes, { filename: 'concat-limit.xz', limits: { maxXzDictionaryBytes: dict } });
      } catch (err) {
        error = err;
      }
      if (!(error instanceof CompressionError) || error.code !== 'COMPRESSION_RESOURCE_LIMIT') {
        throw new Error('expected concatenated xz resource limit error');
      }
      const json = error.toJSON() as { context?: Record<string, string> };
      const result = validateSchema(errorSchema, json);
      if (!result.ok) {
        throw new Error(`concat xz resource error schema failed: ${result.errors.join('\\n')}`);
      }
      if (!json.context?.requiredDictionaryBytes || !json.context?.limitDictionaryBytes) {
        throw new Error('concat xz resource error missing context');
      }
      const reader = await openArchive(bytes, { filename: 'concat-limit.xz' });
      const report = await reader.audit({ limits: { maxXzDictionaryBytes: dict } });
      const issue = report.issues.find((entry) => entry.code === 'COMPRESSION_RESOURCE_LIMIT');
      if (!issue) throw new Error('missing concat xz resource limit issue');
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/concat-two.xz', import.meta.url))).arrayBuffer()
      );
      const reader = await openArchive(bytes, { filename: 'concat-two.xz' });
      const report = await reader.audit({ limits: { maxXzIndexRecords: 1 } });
      const auditResult = validateSchema(auditSchema, toJson(report));
      if (!auditResult.ok) throw new Error(`xz index record audit schema failed: ${auditResult.errors.join('\\n')}`);
      const issue = report.issues.find((entry) => entry.code === 'COMPRESSION_RESOURCE_LIMIT');
      if (!issue) throw new Error('missing xz index record limit issue');
      const details = issue.details as Record<string, string> | undefined;
      if (!details?.requiredIndexRecords || !details?.limitIndexRecords) {
        throw new Error('xz index record issue missing details');
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/concat-two.xz', import.meta.url))).arrayBuffer()
      );
      const reader = await openArchive(bytes, { filename: 'concat-two.xz' });
      const report = await reader.audit({ limits: { maxXzIndexBytes: 1 } });
      const auditResult = validateSchema(auditSchema, toJson(report));
      if (!auditResult.ok) throw new Error(`xz index byte audit schema failed: ${auditResult.errors.join('\\n')}`);
      const issue = report.issues.find((entry) => entry.code === 'COMPRESSION_RESOURCE_LIMIT');
      if (!issue) throw new Error('missing xz index byte limit issue');
      const details = issue.details as Record<string, string> | undefined;
      if (!details?.requiredIndexBytes || !details?.limitIndexBytes) {
        throw new Error('xz index byte issue missing details');
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/concat-two.xz', import.meta.url))).arrayBuffer()
      );
      const server = await startRangeServer(bytes, 'concat-two.xz');
      try {
        let error: unknown;
        try {
          await openArchive(server.url, { format: 'xz', limits: { maxXzIndexBytes: 1 } });
        } catch (err) {
          error = err;
        }
        if (!(error instanceof CompressionError) || error.code !== 'COMPRESSION_RESOURCE_LIMIT') {
          throw new Error('expected xz index byte limit error for http preflight');
        }
        const json = error.toJSON();
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`xz http preflight error schema failed: ${result.errors.join('\\n')}`);
        if (server.stats.requests !== 2) {
          throw new Error(`xz http preflight unexpected request count: ${server.stats.requests}`);
        }
        if (server.stats.bytes !== bytes.length) {
          throw new Error(`xz http preflight unexpected bytes: ${server.stats.bytes}`);
        }
      } finally {
        server.stop();
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/concat-two.xz', import.meta.url))).arrayBuffer()
      );
      const server = await startRangeServer(bytes, 'concat-two.xz');
      try {
        let error: unknown;
        try {
          await openArchive(server.url, { format: 'xz', limits: { maxXzIndexRecords: 1 } });
        } catch (err) {
          error = err;
        }
        if (!(error instanceof CompressionError) || error.code !== 'COMPRESSION_RESOURCE_LIMIT') {
          throw new Error('expected xz index record limit error for http preflight');
        }
        const json = error.toJSON();
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`xz http preflight error schema failed: ${result.errors.join('\\n')}`);
        if (server.stats.requests !== 2) {
          throw new Error(`xz http preflight unexpected request count: ${server.stats.requests}`);
        }
        if (server.stats.bytes !== bytes.length) {
          throw new Error(`xz http preflight unexpected bytes: ${server.stats.bytes}`);
        }
      } finally {
        server.stop();
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/xz-dict-huge.xz', import.meta.url))).arrayBuffer()
      );
      if (bytes.length <= 4 * 1024 * 1024) throw new Error('expected large xz dict fixture');
      const server = await startRangeServer(bytes, 'xz-dict-huge.xz');
      try {
        let error: unknown;
        try {
          await openArchive(server.url, { format: 'xz', limits: { maxXzDictionaryBytes: 1024 } });
        } catch (err) {
          error = err;
        }
        if (!(error instanceof CompressionError) || error.code !== 'COMPRESSION_RESOURCE_LIMIT') {
          throw new Error('expected xz dictionary limit error for http preflight');
        }
        const json = error.toJSON();
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`xz http dictionary error schema failed: ${result.errors.join('\\n')}`);
        if (server.stats.bytes >= 64 * 1024) {
          throw new Error(`xz http dictionary preflight served too many bytes: ${server.stats.bytes}`);
        }
        if (!server.stats.ranges.length) {
          throw new Error('xz http dictionary preflight missing range requests');
        }
        const expectedRanges = expectedTailRanges(bytes.length, 32 * 1024, 32 * 1024);
        if (JSON.stringify(server.stats.ranges) !== JSON.stringify(expectedRanges)) {
          throw new Error(`xz http dictionary preflight unexpected ranges: ${server.stats.ranges.join(',')}`);
        }
        if (server.stats.requests !== expectedRanges.length + 1) {
          throw new Error(`xz http dictionary preflight unexpected request count: ${server.stats.requests}`);
        }
      } finally {
        server.stop();
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/concat-two.xz', import.meta.url))).arrayBuffer()
      );
      const server = await startRangeServer(bytes, 'concat-two.xz', 'no-range');
      try {
        let error: unknown;
        try {
          await openArchive(server.url, { format: 'xz' });
        } catch (err) {
          error = err;
        }
        if (!(error instanceof ArchiveError) || error.code !== 'ARCHIVE_HTTP_RANGE_UNSUPPORTED') {
          throw new Error('expected ARCHIVE_HTTP_RANGE_UNSUPPORTED for xz no-range preflight');
        }
        const json = error.toJSON();
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`xz no-range schema failed: ${result.errors.join('\\n')}`);
      } finally {
        server.stop();
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/concat-two.xz', import.meta.url))).arrayBuffer()
      );
      const server = await startRangeServer(bytes, 'concat-two.xz', 'etag-mismatch');
      try {
        let error: unknown;
        try {
          await openArchive(server.url, { format: 'xz' });
        } catch (err) {
          error = err;
        }
        if (!(error instanceof ArchiveError) || error.code !== 'ARCHIVE_HTTP_RESOURCE_CHANGED') {
          throw new Error('expected ARCHIVE_HTTP_RESOURCE_CHANGED for xz etag mismatch preflight');
        }
        const json = error.toJSON() as { context?: Record<string, string> };
        const result = validateSchema(errorSchema, json as Record<string, unknown>);
        if (!result.ok) throw new Error(`xz resource-changed schema failed: ${result.errors.join('\\n')}`);
        if (json.context?.httpCode !== 'HTTP_RESOURCE_CHANGED') {
          throw new Error(`xz resource-changed missing httpCode: ${json.context?.httpCode ?? 'none'}`);
        }
      } finally {
        server.stop();
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/zip-preflight/basic.zip', import.meta.url))).arrayBuffer()
      );
      const server = await startRangeServer(bytes, 'basic.zip');
      try {
        const reader = await openArchive(server.url, { format: 'zip' });
        const detectionResult = validateSchema(detectionSchema, toJson(reader.detection));
        if (!detectionResult.ok) {
          throw new Error(`zip http success detection schema failed: ${detectionResult.errors.join('\n')}`);
        }
        const names: string[] = [];
        for await (const entry of reader.entries()) {
          names.push(entry.name);
        }
        if (JSON.stringify(names) !== JSON.stringify(['hello.txt'])) {
          throw new Error(`zip http entries mismatch: ${names.join(',')}`);
        }
        const expectedRanges = expectedTailRanges(bytes.length, 32 * 1024, Math.min(bytes.length, 0x10000 + 22));
        if (JSON.stringify(server.stats.ranges) !== JSON.stringify(expectedRanges)) {
          throw new Error(`zip http success unexpected ranges: ${server.stats.ranges.join(',')}`);
        }
        const expectedRangeBytes = sumRangeBytes(expectedRanges);
        if (server.stats.rangeBytes !== expectedRangeBytes) {
          throw new Error(`zip http success unexpected range bytes: ${server.stats.rangeBytes}`);
        }
        if (server.stats.bytes !== expectedRangeBytes) {
          throw new Error(`zip http success unexpected total bytes: ${server.stats.bytes}`);
        }
        if (server.stats.requests !== expectedRanges.length + 1) {
          throw new Error(`zip http success unexpected request count: ${server.stats.requests}`);
        }
      } finally {
        server.stop();
      }
    }

    {
      const bigPayload = new Uint8Array(4 * 1024 * 1024);
      for (let i = 0; i < bigPayload.length; i += 1) bigPayload[i] = i & 0xff;
      const smallPayload = encoder.encode('bytefold-zip-url-small');
      const bigZipPath = path.join(tmp, 'zip-url-big.zip');
      const bigWriter = await zipToFile(bigZipPath);
      await bigWriter.add('big.bin', bigPayload, { method: 0, mtime: new Date(0) });
      await bigWriter.add('small.txt', smallPayload, { method: 0, mtime: new Date(0) });
      await bigWriter.close();
      const bigZipBytes = new Uint8Array(await Bun.file(bigZipPath).arrayBuffer());

      const budget = zipBudgetFor(bigZipBytes.length);
      const requestBudget = zipRequestBudgetFor(bigZipBytes.length);

      const server = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'range',
        etag: ZIP_ETAG_V1,
        lastModified: ZIP_LAST_MODIFIED
      });
      try {
        const reader = await openArchive(server.url, { format: 'zip' });
        const names: string[] = [];
        for await (const entry of reader.entries()) names.push(entry.name);
        await closeArchive(reader);
        if (!names.includes('big.bin') || !names.includes('small.txt')) {
          throw new Error(`zip url list missing entries: ${names.join(',')}`);
        }
        if (server.stats.bytes >= bigZipBytes.length) {
          throw new Error(`zip url list downloaded full archive (${server.stats.bytes})`);
        }
        if (server.stats.bytes > budget) {
          throw new Error(`zip url list exceeded budget ${budget} (${server.stats.bytes})`);
        }
        if (server.stats.requests > requestBudget) {
          throw new Error(`zip url list exceeded request budget ${requestBudget} (${server.stats.requests})`);
        }
        if (server.stats.missingRangeGets !== 0) {
          throw new Error(`zip url list had ${server.stats.missingRangeGets} GET without Range`);
        }
        if (server.stats.getRequests !== server.stats.ranges.length) {
          throw new Error(`zip url list unexpected GET range count ${server.stats.getRequests}`);
        }
        assertIfRangeMatches(server.stats.ifRanges, ZIP_ETAG_V1, 'zip url list');
        assertIdentityEncodings(server.stats.acceptEncodings, 'zip url list');
      } finally {
        server.stop();
      }

      const serverExtract = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'range',
        etag: ZIP_ETAG_V1,
        lastModified: ZIP_LAST_MODIFIED
      });
      try {
        const reader = await openArchive(serverExtract.url, { format: 'zip' });
        let found = false;
        for await (const entry of reader.entries()) {
          if (entry.name !== 'small.txt') continue;
          const data = await collect(await entry.open());
          assertBytesEqual(data, smallPayload, 'zip url small entry mismatch');
          found = true;
        }
        await closeArchive(reader);
        if (!found) throw new Error('zip url extract missing small.txt');
        if (serverExtract.stats.bytes >= bigZipBytes.length) {
          throw new Error(`zip url extract downloaded full archive (${serverExtract.stats.bytes})`);
        }
        if (serverExtract.stats.bytes > budget) {
          throw new Error(`zip url extract exceeded budget ${budget} (${serverExtract.stats.bytes})`);
        }
        if (serverExtract.stats.requests > requestBudget) {
          throw new Error(`zip url extract exceeded request budget ${requestBudget} (${serverExtract.stats.requests})`);
        }
        if (serverExtract.stats.missingRangeGets !== 0) {
          throw new Error(`zip url extract had ${serverExtract.stats.missingRangeGets} GET without Range`);
        }
        if (serverExtract.stats.getRequests !== serverExtract.stats.ranges.length) {
          throw new Error(`zip url extract unexpected GET range count ${serverExtract.stats.getRequests}`);
        }
        assertIfRangeMatches(serverExtract.stats.ifRanges, ZIP_ETAG_V1, 'zip url extract');
        assertIdentityEncodings(serverExtract.stats.acceptEncodings, 'zip url extract');
      } finally {
        serverExtract.stop();
      }

      const serverNoRange = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'no-range'
      });
      try {
        let error: unknown;
        try {
          await openArchive(serverNoRange.url, { format: 'zip' });
        } catch (err) {
          error = err;
        }
        if (!(error instanceof ZipError) || error.code !== 'ZIP_HTTP_RANGE_UNSUPPORTED') {
          throw new Error('zip url no-range did not throw ZIP_HTTP_RANGE_UNSUPPORTED');
        }
        const json = error.toJSON() as { code?: string };
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`zip url no-range schema failed: ${result.errors.join('\\n')}`);
        if (json.code !== 'ZIP_HTTP_RANGE_UNSUPPORTED') {
          throw new Error('zip url no-range error code mismatch');
        }
        if (serverNoRange.stats.bytes > budget) {
          throw new Error(`zip url no-range exceeded budget ${budget} (${serverNoRange.stats.bytes})`);
        }
        if (serverNoRange.stats.requests > requestBudget) {
          throw new Error(`zip url no-range exceeded request budget ${requestBudget} (${serverNoRange.stats.requests})`);
        }
      } finally {
        serverNoRange.stop();
      }

      const serverNoRangeSlow = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'no-range-slow'
      });
      try {
        let error: unknown;
        try {
          await openArchive(serverNoRangeSlow.url, { format: 'zip' });
        } catch (err) {
          error = err;
        }
        if (!(error instanceof ZipError) || error.code !== 'ZIP_HTTP_RANGE_UNSUPPORTED') {
          throw new Error('zip url no-range slow did not throw ZIP_HTTP_RANGE_UNSUPPORTED');
        }
        const json = error.toJSON() as { code?: string };
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`zip url no-range slow schema failed: ${result.errors.join('\\n')}`);
        if (serverNoRangeSlow.stats.bytes > 4096) {
          throw new Error(`zip url no-range slow served too many bytes (${serverNoRangeSlow.stats.bytes})`);
        }
      } finally {
        serverNoRangeSlow.stop();
      }

      const serverChange = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'range',
        etag: ZIP_ETAG_V1,
        lastModified: ZIP_LAST_MODIFIED
      });
      try {
        const reader = await openArchive(serverChange.url, { format: 'zip', zip: { http: { cache: { maxBlocks: 0 } } } });
        const names: string[] = [];
        for await (const entry of reader.entries()) names.push(entry.name);
        if (!names.includes('small.txt') || !names.includes('big.bin')) {
          throw new Error('zip url change missing entries');
        }
        serverChange.setEtag(ZIP_ETAG_V2);
        let error: unknown;
        let outputLength = 0;
        try {
          for await (const entry of reader.entries()) {
            if (entry.name !== 'big.bin') continue;
            const stream = await entry.open();
            const streamReader = stream.getReader();
            try {
              const { value } = await streamReader.read();
              if (value) outputLength = value.length;
            } finally {
              await streamReader.cancel().catch(() => {});
            }
          }
        } catch (err) {
          error = err;
        } finally {
          await closeArchive(reader);
        }
        if (!(error instanceof ZipError) || error.code !== 'ZIP_HTTP_RESOURCE_CHANGED') {
          throw new Error('zip url change did not throw ZIP_HTTP_RESOURCE_CHANGED');
        }
        if (outputLength !== 0) {
          throw new Error(`zip url change produced ${outputLength} bytes before failure`);
        }
        const json = error.toJSON() as { code?: string };
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`zip url change schema failed: ${result.errors.join('\\n')}`);
        if (serverChange.stats.bytes > budget) {
          throw new Error(`zip url change exceeded budget ${budget} (${serverChange.stats.bytes})`);
        }
        if (serverChange.stats.requests > requestBudget) {
          throw new Error(`zip url change exceeded request budget ${requestBudget} (${serverChange.stats.requests})`);
        }
        assertIdentityEncodings(serverChange.stats.acceptEncodings, 'zip url change');
      } finally {
        serverChange.stop();
      }

      const serverIfRange200 = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'if-range-200',
        etag: ZIP_ETAG_V1,
        lastModified: ZIP_LAST_MODIFIED
      });
      try {
        const reader = await openArchive(serverIfRange200.url, { format: 'zip' });
        const names: string[] = [];
        for await (const entry of reader.entries()) names.push(entry.name);
        if (!names.includes('small.txt') || !names.includes('big.bin')) {
          throw new Error('zip url if-range-200 missing entries');
        }
        serverIfRange200.setEtag(ZIP_ETAG_V2);
        let error: unknown;
        try {
          for await (const entry of reader.entries()) {
            if (entry.name !== 'big.bin') continue;
            const stream = await entry.open();
            const streamReader = stream.getReader();
            try {
              await streamReader.read();
            } finally {
              await streamReader.cancel().catch(() => {});
            }
          }
        } catch (err) {
          error = err;
        } finally {
          await closeArchive(reader);
        }
        if (!(error instanceof ZipError) || error.code !== 'ZIP_HTTP_RESOURCE_CHANGED') {
          throw new Error('zip url if-range-200 did not throw ZIP_HTTP_RESOURCE_CHANGED');
        }
        const json = error.toJSON() as { code?: string };
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`zip url if-range-200 schema failed: ${result.errors.join('\\n')}`);
        if (serverIfRange200.stats.bytes > budget) {
          throw new Error(`zip url if-range-200 exceeded budget ${budget} (${serverIfRange200.stats.bytes})`);
        }
        if (serverIfRange200.stats.requests > requestBudget) {
          throw new Error(
            `zip url if-range-200 exceeded request budget ${requestBudget} (${serverIfRange200.stats.requests})`
          );
        }
        assertIfRangeMatches(serverIfRange200.stats.ifRanges, ZIP_ETAG_V1, 'zip url if-range-200');
        assertIdentityEncodings(serverIfRange200.stats.acceptEncodings, 'zip url if-range-200');
      } finally {
        serverIfRange200.stop();
      }

      const serverHeadBlocked = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'head-blocked',
        etag: ZIP_ETAG_V1,
        lastModified: ZIP_LAST_MODIFIED
      });
      try {
        const reader = await openArchive(serverHeadBlocked.url, { format: 'zip' });
        const names: string[] = [];
        for await (const entry of reader.entries()) names.push(entry.name);
        await closeArchive(reader);
        if (!names.includes('big.bin') || !names.includes('small.txt')) {
          throw new Error(`zip url head-blocked missing entries: ${names.join(',')}`);
        }
        if (serverHeadBlocked.stats.bytes >= bigZipBytes.length) {
          throw new Error(`zip url head-blocked downloaded full archive (${serverHeadBlocked.stats.bytes})`);
        }
        if (serverHeadBlocked.stats.bytes > budget) {
          throw new Error(`zip url head-blocked exceeded budget ${budget} (${serverHeadBlocked.stats.bytes})`);
        }
        if (serverHeadBlocked.stats.requests > requestBudget) {
          throw new Error(
            `zip url head-blocked exceeded request budget ${requestBudget} (${serverHeadBlocked.stats.requests})`
          );
        }
        if (!serverHeadBlocked.stats.statuses.includes(405)) {
          throw new Error('zip url head-blocked did not record 405 status');
        }
        if (serverHeadBlocked.stats.missingRangeGets !== 0) {
          throw new Error(`zip url head-blocked had ${serverHeadBlocked.stats.missingRangeGets} GET without Range`);
        }
      } finally {
        serverHeadBlocked.stop();
      }

      const serverEncoded = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'content-encoding',
        etag: ZIP_ETAG_V1,
        lastModified: ZIP_LAST_MODIFIED
      });
      try {
        let error: unknown;
        try {
          await openArchive(serverEncoded.url, { format: 'zip' });
        } catch (err) {
          error = err;
        }
        if (!(error instanceof ZipError) || error.code !== 'ZIP_HTTP_CONTENT_ENCODING') {
          throw new Error('zip url content-encoding did not throw ZIP_HTTP_CONTENT_ENCODING');
        }
        const json = error.toJSON() as { code?: string };
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`zip url content-encoding schema failed: ${result.errors.join('\\n')}`);
        if (serverEncoded.stats.bytes > budget) {
          throw new Error(`zip url content-encoding exceeded budget ${budget} (${serverEncoded.stats.bytes})`);
        }
        if (serverEncoded.stats.requests > requestBudget) {
          throw new Error(
            `zip url content-encoding exceeded request budget ${requestBudget} (${serverEncoded.stats.requests})`
          );
        }
        assertIfRangeMatches(serverEncoded.stats.ifRanges, ZIP_ETAG_V1, 'zip url content-encoding');
        assertIdentityEncodings(serverEncoded.stats.acceptEncodings, 'zip url content-encoding');
      } finally {
        serverEncoded.stop();
      }

      const serverEncodedSlow = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'content-encoding-slow',
        etag: ZIP_ETAG_V1,
        lastModified: ZIP_LAST_MODIFIED
      });
      try {
        let error: unknown;
        try {
          await openArchive(serverEncodedSlow.url, { format: 'zip' });
        } catch (err) {
          error = err;
        }
        if (!(error instanceof ZipError) || error.code !== 'ZIP_HTTP_CONTENT_ENCODING') {
          throw new Error('zip url content-encoding slow did not throw ZIP_HTTP_CONTENT_ENCODING');
        }
        const json = error.toJSON() as { code?: string };
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`zip url content-encoding slow schema failed: ${result.errors.join('\\n')}`);
        if (serverEncodedSlow.stats.bytes > 4096) {
          throw new Error(`zip url content-encoding slow served too many bytes (${serverEncodedSlow.stats.bytes})`);
        }
      } finally {
        serverEncodedSlow.stop();
      }

      const serverBadRange = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'bad-content-range',
        etag: ZIP_ETAG_V1,
        lastModified: ZIP_LAST_MODIFIED
      });
      try {
        let error: unknown;
        try {
          await openArchive(serverBadRange.url, { format: 'zip' });
        } catch (err) {
          error = err;
        }
        if (!(error instanceof ZipError) || error.code !== 'ZIP_HTTP_RANGE_INVALID') {
          throw new Error('zip url bad content-range did not throw ZIP_HTTP_RANGE_INVALID');
        }
        const json = error.toJSON() as { code?: string };
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`zip url bad content-range schema failed: ${result.errors.join('\\n')}`);
        if (serverBadRange.stats.bytes > budget) {
          throw new Error(`zip url bad content-range exceeded budget ${budget} (${serverBadRange.stats.bytes})`);
        }
        if (serverBadRange.stats.requests > requestBudget) {
          throw new Error(
            `zip url bad content-range exceeded request budget ${requestBudget} (${serverBadRange.stats.requests})`
          );
        }
      } finally {
        serverBadRange.stop();
      }

      const serverLongBody = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'long-body',
        etag: ZIP_ETAG_V1,
        lastModified: ZIP_LAST_MODIFIED
      });
      try {
        let error: unknown;
        const reader = await openArchive(serverLongBody.url, {
          format: 'zip',
          zip: { http: { cache: { blockSize: 1024, maxBlocks: 0 } } }
        });
        try {
          for await (const _entry of reader.entries()) {
            // list first
          }
          serverLongBody.armLongBody();
          for await (const entry of reader.entries()) {
            if (entry.name !== 'big.bin') continue;
            const stream = await entry.open();
            const streamReader = stream.getReader();
            try {
              await streamReader.read();
            } finally {
              await streamReader.cancel().catch(() => {});
            }
          }
        } catch (err) {
          error = err;
        } finally {
          await closeArchive(reader);
        }
        if (!(error instanceof ZipError) || error.code !== 'ZIP_HTTP_BAD_RESPONSE') {
          throw new Error('zip url long-body did not throw ZIP_HTTP_BAD_RESPONSE');
        }
        const json = error.toJSON() as { code?: string };
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`zip url long-body schema failed: ${result.errors.join('\\n')}`);
      } finally {
        serverLongBody.stop();
      }

      const serverWeak = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'range',
        etag: ZIP_WEAK_ETAG_V1,
        lastModified: ZIP_LAST_MODIFIED
      });
      try {
        const reader = await openArchive(serverWeak.url, { format: 'zip' });
        for await (const entry of reader.entries()) {
          if (entry.name !== 'small.txt') continue;
          const data = await collect(await entry.open());
          assertBytesEqual(data, smallPayload, 'zip url weak etag small entry mismatch');
          break;
        }
        serverWeak.setEtag(ZIP_WEAK_ETAG_V2);
        let error: unknown;
        try {
          for await (const entry of reader.entries()) {
            if (entry.name !== 'big.bin') continue;
            const stream = await entry.open();
            const streamReader = stream.getReader();
            try {
              await streamReader.read();
            } finally {
              await streamReader.cancel().catch(() => {});
            }
          }
        } catch (err) {
          error = err;
        } finally {
          await closeArchive(reader);
        }
        if (!(error instanceof ZipError) || error.code !== 'ZIP_HTTP_RESOURCE_CHANGED') {
          throw new Error('zip url weak etag mismatch did not throw ZIP_HTTP_RESOURCE_CHANGED');
        }
        const json = error.toJSON() as { code?: string };
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`zip url weak etag schema failed: ${result.errors.join('\\n')}`);
        if (!serverWeak.stats.ifRanges.every((value) => value === undefined)) {
          throw new Error('zip url weak etag should not send If-Range');
        }
        assertIdentityEncodings(serverWeak.stats.acceptEncodings, 'zip url weak etag');
        if (serverWeak.stats.bytes > budget) {
          throw new Error(`zip url weak etag exceeded budget ${budget} (${serverWeak.stats.bytes})`);
        }
        if (serverWeak.stats.requests > requestBudget) {
          throw new Error(`zip url weak etag exceeded request budget ${requestBudget} (${serverWeak.stats.requests})`);
        }
      } finally {
        serverWeak.stop();
      }

      const serverStrongRequired = await startZipRangeServer(bigZipBytes, 'zip-url-big.zip', {
        mode: 'range',
        etag: ZIP_WEAK_ETAG_V1,
        lastModified: ZIP_LAST_MODIFIED
      });
      try {
        let error: unknown;
        try {
          await openArchive(serverStrongRequired.url, {
            format: 'zip',
            zip: { http: { snapshot: 'require-strong-etag' } }
          });
        } catch (err) {
          error = err;
        }
        if (!(error instanceof ZipError) || error.code !== 'ZIP_HTTP_STRONG_ETAG_REQUIRED') {
          throw new Error('zip url require-strong-etag did not throw ZIP_HTTP_STRONG_ETAG_REQUIRED');
        }
        const json = error.toJSON() as { code?: string };
        const result = validateSchema(errorSchema, json);
        if (!result.ok) throw new Error(`zip url strong etag schema failed: ${result.errors.join('\\n')}`);
        if (serverStrongRequired.stats.bytes > budget) {
          throw new Error(`zip url require-strong-etag exceeded budget ${budget} (${serverStrongRequired.stats.bytes})`);
        }
        if (serverStrongRequired.stats.requests > requestBudget) {
          throw new Error(
            `zip url require-strong-etag exceeded request budget ${requestBudget} (${serverStrongRequired.stats.requests})`
          );
        }
      } finally {
        serverStrongRequired.stop();
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/hello.txt.xz', import.meta.url))).arrayBuffer()
      );
      const server = await startRangeServer(bytes, 'hello.txt.xz');
      try {
        const reader = await openArchive(server.url, { format: 'xz', limits: { maxXzPreflightBlockHeaders: 1 } });
        const detectionResult = validateSchema(detectionSchema, toJson(reader.detection));
        if (!detectionResult.ok) {
          throw new Error(`xz http success detection schema failed: ${detectionResult.errors.join('\n')}`);
        }
        let sawEntry = false;
        for await (const entry of reader.entries()) {
          const data = await collect(await entry.open());
          const text = new TextDecoder().decode(data);
          if (text !== 'hello from bytefold\n') throw new Error('xz http success payload mismatch');
          sawEntry = true;
        }
        if (!sawEntry) throw new Error('xz http success missing entry');
        const report = await reader.audit();
        const auditResult = validateSchema(auditSchema, toJson(report));
        if (!auditResult.ok) throw new Error(`xz http success audit schema failed: ${auditResult.errors.join('\\n')}`);
        const incomplete = report.issues.find((entry) => entry.code === 'COMPRESSION_RESOURCE_PREFLIGHT_INCOMPLETE');
        if (incomplete) throw new Error('xz http success preflight marked incomplete');
        const expectedRanges = expectedTailRanges(bytes.length, 32 * 1024, 32 * 1024);
        if (JSON.stringify(server.stats.ranges) !== JSON.stringify(expectedRanges)) {
          throw new Error(`xz http success unexpected ranges: ${server.stats.ranges.join(',')}`);
        }
        const expectedRangeBytes = sumRangeBytes(expectedRanges);
        if (server.stats.rangeBytes !== expectedRangeBytes) {
          throw new Error(`xz http success unexpected range bytes: ${server.stats.rangeBytes}`);
        }
        if (server.stats.bytes !== expectedRangeBytes + bytes.length) {
          throw new Error(`xz http success unexpected total bytes: ${server.stats.bytes}`);
        }
        if (server.stats.requests !== expectedRanges.length + 2) {
          throw new Error(`xz http success unexpected request count: ${server.stats.requests}`);
        }
      } finally {
        server.stop();
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/xz-many-blocks/many-blocks.xz', import.meta.url))).arrayBuffer()
      );
      const expected = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('../test/fixtures/xz-many-blocks/many-blocks.bin', import.meta.url))).arrayBuffer()
      );
      const server = await startRangeServer(bytes, 'xz-many-blocks/many-blocks.xz');
      try {
        const reader = await openArchive(server.url, { format: 'xz', limits: { maxXzPreflightBlockHeaders: 1 } });
        let sawEntry = false;
        for await (const entry of reader.entries()) {
          const data = await collect(await entry.open());
          assertBytesEqual(data, expected, 'xz many-blocks payload mismatch');
          sawEntry = true;
        }
        if (!sawEntry) throw new Error('xz many-blocks missing entry');
        const report = await reader.audit();
        const auditResult = validateSchema(auditSchema, toJson(report));
        if (!auditResult.ok) throw new Error(`xz many-blocks audit schema failed: ${auditResult.errors.join('\\n')}`);
        const incomplete = report.issues.find((entry) => entry.code === 'COMPRESSION_RESOURCE_PREFLIGHT_INCOMPLETE');
        if (!incomplete) throw new Error('xz many-blocks missing preflight incomplete issue');
        const details = incomplete.details as Record<string, string> | undefined;
        if (details?.requiredBlockHeaders !== '5' || details?.limitBlockHeaders !== '1') {
          throw new Error('xz many-blocks preflight details mismatch');
        }
        const tailRanges = expectedTailRanges(bytes.length, 32 * 1024, 32 * 1024);
        const headRange = `bytes=0-${Math.min(32 * 1024 - 1, bytes.length - 1)}`;
        const expectedRanges = [...tailRanges, headRange];
        if (JSON.stringify(server.stats.ranges) !== JSON.stringify(expectedRanges)) {
          throw new Error(`xz many-blocks unexpected ranges: ${server.stats.ranges.join(',')}`);
        }
        const expectedRangeBytes = sumRangeBytes(expectedRanges);
        if (server.stats.rangeBytes !== expectedRangeBytes) {
          throw new Error(`xz many-blocks unexpected range bytes: ${server.stats.rangeBytes}`);
        }
        if (server.stats.requests !== expectedRanges.length + 2) {
          throw new Error(`xz many-blocks unexpected request count: ${server.stats.requests}`);
        }
      } finally {
        server.stop();
      }
    }

    const concatGzPath = fileURLToPath(new URL('../test/fixtures/concat.gz', import.meta.url));
    const concatGzBytes = new Uint8Array(await Bun.file(concatGzPath).arrayBuffer());
    const concatGzArchive = await openArchive(concatGzBytes, { filename: 'concat.gz' });
    if (concatGzArchive.format !== 'gz') throw new Error('concat gz format not detected');
    for await (const entry of concatGzArchive.entries()) {
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== `${expectedHello}${expectedHello}`) throw new Error('concat gz content mismatch');
    }

    const concatBz2Path = fileURLToPath(new URL('../test/fixtures/concat.bz2', import.meta.url));
    const concatBz2Bytes = new Uint8Array(await Bun.file(concatBz2Path).arrayBuffer());
    const concatBz2Archive = await openArchive(concatBz2Bytes, { filename: 'concat.bz2' });
    if (concatBz2Archive.format !== 'bz2') throw new Error('concat bz2 format not detected');
    for await (const entry of concatBz2Archive.entries()) {
      const data = await collect(await entry.open());
      const text = new TextDecoder().decode(data);
      if (text !== 'hello bzip2\nhello bzip2\n') throw new Error('concat bz2 content mismatch');
    }

    await assertWriterRoundtrip('tar.br', 'br tar', { format: 'tar.br' });
    await assertWriterRoundtrip('tar.zst', 'zst tar', {});
    await assertSingleWriterRoundtrip('br', 'br single', { format: 'br', filename: 'hello.txt.br' });
    await assertSingleWriterRoundtrip('zst', 'zst single', { filename: 'hello.txt.zst' });

    const ambiguousRoot = new URL('../test/fixtures/ambiguous/', import.meta.url);
    const expectedIssues = (JSON.parse(
      await readFile(new URL('expected-issues.json', ambiguousRoot), 'utf8')
    ) as unknown) as Record<string, IssueSummary[]>;
    const normalizeExpectations: Record<
      string,
      | { output: string }
      | { errorCode: string; errorType: 'archive' | 'zip'; entryName: string }
    > = {
      'tar-pax-longname.tar': { output: 'tar-pax-longname.norm.tar' },
      'zip-paths.zip': { output: 'zip-paths.norm.zip' },
      'tar-duplicates.tar': { errorCode: 'ARCHIVE_NAME_COLLISION', errorType: 'archive', entryName: 'dup.txt' },
      'tar-case-collision.tar': { errorCode: 'ARCHIVE_NAME_COLLISION', errorType: 'archive', entryName: 'README.TXT' },
      'tar-links.tar': { errorCode: 'ARCHIVE_UNSUPPORTED_FEATURE', errorType: 'archive', entryName: 'hardlink' },
      'tar-unicode-collision.tar': {
        errorCode: 'ARCHIVE_NAME_COLLISION',
        errorType: 'archive',
        entryName: 'cafe\u0301.txt'
      },
      'tar-path-traversal.tar': { errorCode: 'ARCHIVE_PATH_TRAVERSAL', errorType: 'archive', entryName: '../evil.txt' },
      'zip-duplicates.zip': { errorCode: 'ZIP_NAME_COLLISION', errorType: 'zip', entryName: 'dup.txt' },
      'zip-case-collision.zip': { errorCode: 'ZIP_NAME_COLLISION', errorType: 'zip', entryName: 'README.TXT' },
      'zip-unicode-collision.zip': {
        errorCode: 'ZIP_NAME_COLLISION',
        errorType: 'zip',
        entryName: 'cafe\u0301.txt'
      },
      'zip-casefold-fuss.zip': {
        errorCode: 'ZIP_NAME_COLLISION',
        errorType: 'zip',
        entryName: 'Fu\u00df.txt'
      },
      'zip-casefold-sigma.zip': {
        errorCode: 'ZIP_NAME_COLLISION',
        errorType: 'zip',
        entryName: '\u03bf\u03c2.txt'
      },
      'zip-path-traversal.zip': { errorCode: 'ZIP_PATH_TRAVERSAL', errorType: 'zip', entryName: '../evil.txt' }
    };

    for (const [fixtureName, expected] of Object.entries(expectedIssues)) {
      const bytes = new Uint8Array(await Bun.file(fileURLToPath(new URL(fixtureName, ambiguousRoot))).arrayBuffer());
      const reader = await openArchive(bytes, { filename: fixtureName });
      const audit = await reader.audit({ profile: 'agent' });
      const auditResult = validateSchema(auditSchema, toJson(audit));
      if (!auditResult.ok) {
        throw new Error(`ambiguous audit schema failed: ${auditResult.errors.join('\\n')}`);
      }
      const actualIssues = sortIssues(summarizeIssues(audit.issues));
      const expectedIssuesSorted = sortIssues(expected);
      if (JSON.stringify(actualIssues) !== JSON.stringify(expectedIssuesSorted)) {
        throw new Error(`ambiguous audit mismatch for ${fixtureName}`);
      }
      if (fixtureName === 'zip-casefold-fuss.zip' || fixtureName === 'zip-casefold-sigma.zip') {
        const issue = audit.issues.find((candidate) => candidate.code === 'ZIP_CASE_COLLISION');
        if (!issue || (issue.details as { collisionKind?: string } | undefined)?.collisionKind !== 'casefold') {
          throw new Error(`casefold collision details missing for ${fixtureName}`);
        }
      }
      if (fixtureName === 'zip-casefold-turkic.zip') {
        if (audit.issues.some((candidate) => candidate.code === 'ZIP_CASE_COLLISION')) {
          throw new Error(`unexpected casefold collision for ${fixtureName}`);
        }
      }

      const expectation = normalizeExpectations[fixtureName];
      if (!expectation) continue;
      if ('output' in expectation) {
        const normalized = await normalizeToBytes(reader);
        const expectedBytes = new Uint8Array(
          await Bun.file(fileURLToPath(new URL(expectation.output, ambiguousRoot))).arrayBuffer()
        );
        if (!bytesEqual(normalized.bytes, expectedBytes)) {
          throw new Error(`ambiguous normalize bytes mismatch for ${fixtureName}`);
        }
      } else {
        let error: unknown;
        try {
          await normalizeToBytes(reader);
        } catch (err) {
          error = err;
        }
        if (!error) throw new Error(`expected normalization error for ${fixtureName}`);
        if (expectation.errorType === 'archive') {
          if (!(error instanceof ArchiveError)) throw new Error(`expected ArchiveError for ${fixtureName}`);
        } else if (!(error instanceof ZipError)) {
          throw new Error(`expected ZipError for ${fixtureName}`);
        }
        const err = error as ArchiveError | ZipError;
        if (err.code !== expectation.errorCode) throw new Error(`unexpected error code for ${fixtureName}`);
        const json = err.toJSON();
        const result = validateSchema(errorSchema, json);
        if (!result.ok) {
          throw new Error(`ambiguous error schema failed for ${fixtureName}: ${result.errors.join('\\n')}`);
        }
        if (json.context.entryName !== expectation.entryName) {
          throw new Error(`ambiguous error context mismatch for ${fixtureName}`);
        }
      }
    }

    {
      const bytes = new Uint8Array(
        await Bun.file(fileURLToPath(new URL('zip-casefold-turkic.zip', ambiguousRoot))).arrayBuffer()
      );
      const reader = await openArchive(bytes, { filename: 'zip-casefold-turkic.zip' });
      await normalizeToBytes(reader);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, 20000);

function readableFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });
}

function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function summarizeIssues(issues: Array<{ code: string; severity: string; entryName?: string }>): IssueSummary[] {
  return issues.map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    ...(issue.entryName ? { entryName: issue.entryName } : {})
  }));
}

function sortIssues(issues: IssueSummary[]): IssueSummary[] {
  return [...issues].sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const aName = a.entryName ?? '';
    const bName = b.entryName ?? '';
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  });
}

async function normalizeToBytes(reader: {
  normalizeToWritable?: (writable: WritableStream<Uint8Array>, options?: { deterministic?: boolean }) => Promise<unknown>;
}): Promise<{ report: unknown; bytes: Uint8Array }> {
  const normalizeToWritable = reader.normalizeToWritable?.bind(reader);
  if (!normalizeToWritable) throw new Error('normalizeToWritable missing');
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const report = await normalizeToWritable(writable, { deterministic: true });
  return { report, bytes: concatChunks(chunks) };
}

async function assertAuditNormalizeRoundtrip(
  reader: {
    audit: (options?: AuditOptions) => Promise<unknown>;
    normalizeToWritable?: (writable: WritableStream<Uint8Array>, options?: { deterministic?: boolean }) => Promise<unknown>;
  },
  auditSchema: Record<string, unknown>,
  normalizeSchema: Record<string, unknown>,
  validateSchema: (schema: Record<string, unknown>, value: unknown) => { ok: boolean; errors: string[] }
): Promise<void> {
  const audit = await reader.audit({ profile: 'agent' });
  const auditResult = validateSchema(auditSchema, toJson(audit));
  if (!auditResult.ok) {
    throw new Error(`audit schema validation failed: ${auditResult.errors.join('\\n')}`);
  }
  if (!(audit as { ok?: boolean }).ok) {
    throw new Error('audit report not ok');
  }
  const normalized = await normalizeToBytes(reader);
  const normalizeResult = validateSchema(normalizeSchema, toJson(normalized.report));
  if (!normalizeResult.ok) {
    throw new Error(`normalize schema validation failed: ${normalizeResult.errors.join('\\n')}`);
  }
  if (!(normalized.report as { ok?: boolean }).ok) {
    throw new Error('normalize report not ok');
  }
  const reopened = await openArchive(normalized.bytes);
  const audit2 = await reopened.audit({ profile: 'agent' });
  const audit2Result = validateSchema(auditSchema, toJson(audit2));
  if (!audit2Result.ok) {
    throw new Error(`normalized audit schema validation failed: ${audit2Result.errors.join('\\n')}`);
  }
  if (!(audit2 as { ok?: boolean }).ok) {
    throw new Error('normalized audit report not ok');
  }
}

async function assertSingleFileAuditNormalize(
  reader: {
    audit: (options?: AuditOptions) => Promise<unknown>;
    normalizeToWritable?: (writable: WritableStream<Uint8Array>) => Promise<unknown>;
  },
  auditSchema: Record<string, unknown>,
  errorSchema: Record<string, unknown>,
  validateSchema: (schema: Record<string, unknown>, value: unknown) => { ok: boolean; errors: string[] }
): Promise<void> {
  const audit = await reader.audit({ profile: 'agent' });
  const auditResult = validateSchema(auditSchema, toJson(audit));
  if (!auditResult.ok) {
    throw new Error(`single-file audit schema validation failed: ${auditResult.errors.join('\\n')}`);
  }
  if (!(audit as { ok?: boolean }).ok) {
    throw new Error('single-file audit report not ok');
  }
  const normalizeToWritable = reader.normalizeToWritable?.bind(reader);
  if (!normalizeToWritable) throw new Error('normalizeToWritable missing');
  let error: unknown;
  try {
    await normalizeToWritable(new WritableStream<Uint8Array>({ write() {} }));
  } catch (err) {
    error = err;
  }
  if (!(error instanceof ArchiveError) || error.code !== 'ARCHIVE_UNSUPPORTED_FEATURE') {
    throw new Error('expected ARCHIVE_UNSUPPORTED_FEATURE for single-file normalize');
  }
  const json = error.toJSON();
  const result = validateSchema(errorSchema, json);
  if (!result.ok) {
    throw new Error(`single-file normalize error schema validation failed: ${result.errors.join('\\n')}`);
  }
  if (!json.hint || !json.context || Object.keys(json.context).length === 0) {
    throw new Error('expected hint/context for single-file normalize');
  }
}

async function assertWriterRoundtrip(
  format: 'tar.br' | 'tar.zst',
  text: string,
  openOptions: { format?: 'tar.br' }
): Promise<void> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter(format, writable);
  await writer.add('hello.txt', new TextEncoder().encode(text));
  await writer.close();
  const archive = await openArchive(concatChunks(chunks), openOptions);
  let saw = false;
  for await (const entry of archive.entries()) {
    if (entry.name !== 'hello.txt') continue;
    const data = await collect(await entry.open());
    const decoded = new TextDecoder().decode(data);
    if (decoded !== text) throw new Error(`${format} writer content mismatch`);
    saw = true;
  }
  if (!saw) throw new Error(`${format} writer missing hello.txt`);
}

async function assertSingleWriterRoundtrip(
  format: 'br' | 'zst',
  text: string,
  openOptions: { format?: 'br'; filename?: string }
): Promise<void> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter(format, writable);
  await writer.add('hello.txt', new TextEncoder().encode(text));
  await writer.close();
  const archive = await openArchive(concatChunks(chunks), openOptions);
  let saw = false;
  for await (const entry of archive.entries()) {
    const data = await collect(await entry.open());
    const decoded = new TextDecoder().decode(data);
    if (decoded !== text) throw new Error(`${format} writer content mismatch`);
    saw = true;
  }
  if (!saw) throw new Error(`${format} writer missing entry`);
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (actual.length !== expected.length) {
    throw new Error(`${label}: length mismatch (${actual.length} vs ${expected.length})`);
  }
  for (let i = 0; i < actual.length; i += 1) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${label}: byte mismatch at ${i}`);
    }
  }
}

async function closeArchive(reader: unknown): Promise<void> {
  const close = (reader as { close?: () => Promise<void> }).close;
  if (close) await close.call(reader);
}

function locateBlockCheckOffset(bytes: Uint8Array, payloadLength: number): number {
  if (bytes.length < 13) throw new Error('XZ stream too small');
  const headerSize = (bytes[12]! + 1) * 4;
  const lzma2Length = payloadLength + 4;
  const blockDataOffset = 12 + headerSize;
  const pad = (4 - (lzma2Length % 4)) & 3;
  return blockDataOffset + lzma2Length + pad;
}
