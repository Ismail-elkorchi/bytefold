import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ZipReader, ZipWriter, ZipError } from 'zip-next';

async function buildZip(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable);
  await writer.add('hello.txt', new TextEncoder().encode('hello'));
  await writer.add('data.bin', new Uint8Array([0, 1, 2, 3]));
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

async function readEntryBytes(reader: ZipReader, name: string): Promise<Uint8Array> {
  const entry = reader.entries().find((e) => e.name === name);
  assert.ok(entry, `missing entry ${name}`);
  const stream = await reader.open(entry);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function startServer(data: Uint8Array, supportRange: boolean): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.setHeader('Content-Length', data.length);
      res.end();
      return;
    }

    const range = req.headers.range;
    if (supportRange && typeof range === 'string') {
      const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (!match) {
        res.statusCode = 416;
        res.end();
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : data.length - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= data.length) {
        res.statusCode = 416;
        res.end();
        return;
      }
      const safeEnd = Math.min(end, data.length - 1);
      res.statusCode = 206;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${data.length}`);
      res.setHeader('Content-Length', safeEnd - start + 1);
      res.end(data.subarray(start, safeEnd + 1));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Length', data.length);
    res.end(data);
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

function serverUrl(server: http.Server): string {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/archive.zip`;
}

test('ZipReader.fromUrl reads via HTTP range requests', async (t) => {
  const zip = await buildZip();
  const server = await startServer(zip, true);
  t.after(() => server.close());

  const reader = await ZipReader.fromUrl(serverUrl(server));
  assert.equal(reader.entries().length, 2);
  assert.deepEqual(await readEntryBytes(reader, 'hello.txt'), new TextEncoder().encode('hello'));
  assert.deepEqual(await readEntryBytes(reader, 'data.bin'), new Uint8Array([0, 1, 2, 3]));
});

test('ZipReader.fromUrl rejects when HTTP range unsupported', async (t) => {
  const zip = await buildZip();
  const server = await startServer(zip, false);
  t.after(() => server.close());

  await assert.rejects(async () => {
    await ZipReader.fromUrl(serverUrl(server));
  }, (err: unknown) => err instanceof ZipError && err.code === 'ZIP_HTTP_RANGE_UNSUPPORTED');
});
