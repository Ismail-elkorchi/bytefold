import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fc from 'fast-check';
import { TarReader, openArchive } from '@ismail-elkorchi/bytefold/node';
import { ZipError, ZipReader, ZipWriter } from '@ismail-elkorchi/bytefold/node/zip';
import { openArchive as openArchiveWeb } from '@ismail-elkorchi/bytefold/web';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PROPERTY_CONFIG = {
  numRuns: 120,
  seed: 0x5eedc0de
} as const;

const WEB_PROPERTY_CONFIG = {
  numRuns: 24,
  seed: 0x5eedcafe
} as const;

const EOCD_SIGNATURE = 0x06054b50;

test('property: tar numeric field parsing remains deterministic for octal/NUL/space boundaries', async () => {
  await fc.assert(
    fc.asyncProperty(tarSizeFieldArbitrary(), async (sizeField) => {
      const expectedSize = modelParseTarOctal(sizeField);
      const archive = buildTarArchive(sizeField, expectedSize ?? 0n);
      const reader = await TarReader.fromUint8Array(archive);
      const entries = reader.entries();
      assert.equal(entries.length, 1, 'expected one tar entry');
      assert.equal(entries[0]?.size ?? -1n, expectedSize ?? 0n);
    }),
    PROPERTY_CONFIG
  );
});

test('property: zip EOCD comment length mutations are deterministic', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 80 }),
      fc.integer({ min: 0, max: 80 }),
      fc.integer({ min: 0, max: 8 }),
      async (declaredCommentLength, actualCommentLength, trailingBytesLength) => {
        const baseZip = await writeZipFixture();
        const eocdOffset = findSignatureFromEnd(baseZip, EOCD_SIGNATURE);
        assert.ok(eocdOffset >= 0, 'missing EOCD');

        const output = new Uint8Array(baseZip.length + actualCommentLength + trailingBytesLength);
        output.set(baseZip, 0);
        writeUint16LE(output, eocdOffset + 20, declaredCommentLength);
        for (let i = 0; i < actualCommentLength; i += 1) {
          output[baseZip.length + i] = 0x41 + (i % 26);
        }
        for (let i = 0; i < trailingBytesLength; i += 1) {
          output[baseZip.length + actualCommentLength + i] = 0x7a;
        }

        const shouldSucceed = actualCommentLength === declaredCommentLength && trailingBytesLength === 0;
        if (shouldSucceed) {
          const reader = await ZipReader.fromUint8Array(output);
          assert.equal(reader.entries().length, 1);
          return;
        }

        await assert.rejects(
          () => ZipReader.fromUint8Array(output),
          (error: unknown) => error instanceof ZipError
        );
      }
    ),
    PROPERTY_CONFIG
  );
});

test('property: gzip optional header fields (FEXTRA/FNAME/FCOMMENT) parse deterministically', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(),
      fc.boolean(),
      fc.integer({ min: 0, max: 24 }),
      fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,15}$/),
      fc.stringMatching(/^[a-z0-9 ._-]{0,24}$/),
      async (includeExtra, includeComment, extraLength, name, comment) => {
        const payload = encoder.encode(`payload-${name}`);
        const gzip = buildCustomGzip({
          payload,
          name,
          includeExtra,
          includeComment,
          extraLength,
          comment
        });

        const archive = await openArchive(gzip, { filename: 'payload.gz' });
        assert.equal(archive.format, 'gz');
        const entries: Array<{ name: string; bytes: Uint8Array }> = [];
        for await (const entry of archive.entries()) {
          entries.push({ name: entry.name, bytes: await collect(await entry.open()) });
        }
        assert.equal(entries.length, 1);
        assert.deepEqual(entries[0]?.bytes ?? new Uint8Array(0), payload);
        assert.equal(entries[0]?.name ?? '', name);
      }
    ),
    PROPERTY_CONFIG
  );
});

test('property: web URL full-fetch maxInputBytes abort remains typed and bounded', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 512, max: 4096 }),
      fc.constantFrom(128, 256, 512, 1024),
      async (maxInputBytes, chunkSize) => {
        const body = buildPatternBytes(128 * 1024);
        const stats = { requests: 0, bytesFlushed: 0, rangeHeaders: [] as string[], clientClosed: false };

        const server = http.createServer((req, res) => {
          stats.requests += 1;
          if (req.headers.range) stats.rangeHeaders.push(String(req.headers.range));
          res.statusCode = 200;
          res.setHeader('content-type', 'application/zip');
          res.setHeader('transfer-encoding', 'chunked');
          let offset = 0;
          const timer = setInterval(() => {
            if (req.destroyed || req.socket.destroyed || res.destroyed || res.writableEnded) {
              clearInterval(timer);
              return;
            }
            if (offset >= body.length) {
              clearInterval(timer);
              res.end();
              return;
            }
            const end = Math.min(offset + chunkSize, body.length);
            const chunk = body.subarray(offset, end);
            stats.bytesFlushed += chunk.length;
            res.write(chunk);
            offset = end;
          }, 2);

          req.on('close', () => {
            stats.clientClosed = true;
            clearInterval(timer);
          });
          res.on('close', () => {
            clearInterval(timer);
          });
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
          const address = server.address();
          assert.ok(address && typeof address !== 'string');
          const localUrl = `http://127.0.0.1:${address.port}/property.zip`;
          const secureUrl = 'https://bytefold.test/property.zip';
          await withReroutedFetch(secureUrl, localUrl, async () => {
            await assert.rejects(
              () => openArchiveWeb(secureUrl, { format: 'zip', limits: { maxInputBytes } }),
              (error: unknown) => error instanceof RangeError
            );
            await sleep(20);
          });
        } finally {
          server.close();
        }

        assert.equal(stats.requests, 1);
        assert.deepEqual(stats.rangeHeaders, []);
        assert.equal(stats.clientClosed, true);
        const budget = maxInputBytes + chunkSize * 8;
        assert.ok(stats.bytesFlushed <= budget, `bytesFlushed=${stats.bytesFlushed} exceeded budget=${budget}`);
      }
    ),
    WEB_PROPERTY_CONFIG
  );
});

test('property seeds are fixed and deterministic for reproducing failures', (t) => {
  t.diagnostic(`tar/zip/gzip property seed=${PROPERTY_CONFIG.seed} runs=${PROPERTY_CONFIG.numRuns}`);
  t.diagnostic(`web budget property seed=${WEB_PROPERTY_CONFIG.seed} runs=${WEB_PROPERTY_CONFIG.numRuns}`);
});

function tarSizeFieldArbitrary(): fc.Arbitrary<Uint8Array> {
  return fc
    .record({
      leadingSpaces: fc.integer({ min: 0, max: 3 }),
      octalDigits: fc.stringMatching(/^[0-7]{0,4}$/),
      includeNul: fc.boolean(),
      afterNulDigits: fc.stringMatching(/^[0-7]{0,3}$/),
      trailingSpaces: fc.integer({ min: 0, max: 3 })
    })
    .map((parts) => {
      const output = new Uint8Array(12);
      output.fill(0x20);
      let token = `${' '.repeat(parts.leadingSpaces)}${parts.octalDigits}`;
      if (parts.includeNul) {
        token += `\0${parts.afterNulDigits}`;
      }
      token += ' '.repeat(parts.trailingSpaces);
      const encoded = encoder.encode(token);
      output.set(encoded.subarray(0, output.length), 0);
      return output;
    });
}

function modelParseTarOctal(field: Uint8Array): bigint | undefined {
  const decoded = decoder.decode(field);
  const lastLineTerminator = Math.max(
    decoded.lastIndexOf('\n'),
    decoded.lastIndexOf('\r'),
    decoded.lastIndexOf('\u2028'),
    decoded.lastIndexOf('\u2029')
  );
  const nulIndex = decoded.indexOf('\0', lastLineTerminator + 1);
  const text = (nulIndex === -1 ? decoded : decoded.slice(0, nulIndex)).trim();
  if (!text) return undefined;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) return undefined;
  return BigInt(value);
}

function buildTarArchive(sizeField: Uint8Array, size: bigint): Uint8Array {
  const dataSize = Number(size);
  const data = new Uint8Array(dataSize);
  for (let i = 0; i < data.length; i += 1) data[i] = i & 0xff;

  const header = new Uint8Array(512);
  writeAscii(header, 0, 'entry.txt');
  writeAscii(header, 100, '0000644');
  writeAscii(header, 108, '0000000');
  writeAscii(header, 116, '0000000');
  header.set(sizeField.subarray(0, 12), 124);
  writeAscii(header, 136, '00000000000');
  header[156] = 0x30; // '0'
  writeAscii(header, 257, 'ustar');
  writeAscii(header, 263, '00');
  writeChecksum(header);

  const paddedData = alignToBlock(data.length);
  const output = new Uint8Array(512 + paddedData + 1024);
  output.set(header, 0);
  output.set(data, 512);
  return output;
}

function writeChecksum(header: Uint8Array): void {
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  let sum = 0;
  for (const byte of header) sum += byte;
  const octal = sum.toString(8).padStart(6, '0');
  writeAscii(header, 148, octal);
  header[154] = 0;
  header[155] = 0x20;
}

function writeAscii(buffer: Uint8Array, offset: number, value: string): void {
  const bytes = encoder.encode(value);
  const end = Math.min(bytes.length, buffer.length - offset);
  for (let i = 0; i < end; i += 1) {
    buffer[offset + i] = bytes[i]!;
  }
}

function alignToBlock(size: number): number {
  const block = 512;
  return Math.ceil(size / block) * block;
}

async function writeZipFixture(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable);
  await writer.add('hello.txt', encoder.encode('zip-eocd-property'), { method: 0 });
  await writer.close();
  return concatChunks(chunks);
}

function buildCustomGzip(options: {
  payload: Uint8Array;
  name: string;
  includeExtra: boolean;
  includeComment: boolean;
  extraLength: number;
  comment: string;
}): Uint8Array {
  const canonical = zlib.gzipSync(options.payload, { level: 6 });
  const compressed = canonical.subarray(10, canonical.length - 8);
  const trailer = canonical.subarray(canonical.length - 8);

  let flags = 0x08; // FNAME
  if (options.includeExtra) flags |= 0x04; // FEXTRA
  if (options.includeComment) flags |= 0x10; // FCOMMENT

  const parts: Uint8Array[] = [new Uint8Array([0x1f, 0x8b, 0x08, flags, 0, 0, 0, 0, 0, 0xff])];
  if (options.includeExtra) {
    const extra = new Uint8Array(options.extraLength);
    for (let i = 0; i < extra.length; i += 1) extra[i] = i & 0xff;
    const xlen = new Uint8Array([extra.length & 0xff, (extra.length >>> 8) & 0xff]);
    parts.push(xlen, extra);
  }
  parts.push(encoder.encode(options.name), new Uint8Array([0]));
  if (options.includeComment) {
    parts.push(encoder.encode(options.comment), new Uint8Array([0]));
  }
  parts.push(compressed, trailer);
  return concatChunks(parts);
}

function findSignatureFromEnd(buffer: Uint8Array, signature: number): number {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (readUint32LE(buffer, offset) === signature) return offset;
  }
  return -1;
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (
    buffer[offset]! |
    (buffer[offset + 1]! << 8) |
    (buffer[offset + 2]! << 16) |
    (buffer[offset + 3]! << 24)
  ) >>> 0;
}

function writeUint16LE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
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

function buildPatternBytes(size: number): Uint8Array {
  const output = new Uint8Array(size);
  let state = 0x9e37_79b9;
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[i] = state & 0xff;
  }
  return output;
}

async function withReroutedFetch<T>(secureUrl: string, localUrl: string, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (input: URL | RequestInfo, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : typeof input === 'string' ? input : input.toString();
    if (target !== secureUrl) {
      return originalFetch(input, init);
    }
    if (input instanceof Request) {
      return originalFetch(new Request(localUrl, input), init);
    }
    return originalFetch(localUrl, init);
  };
  try {
    return await run();
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
