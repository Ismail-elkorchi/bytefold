import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { ArchiveError, openArchive } from '@ismail-elkorchi/bytefold/node';

type NodeOpenOptions = NonNullable<Parameters<typeof openArchive>[1]>;

function allowLocalHttp(options: NodeOpenOptions): NodeOpenOptions {
  return {
    ...options,
    url: {
      ...(options.url ?? {}),
      allowHttp: true
    }
  };
}

function buildGzipPayload(size = 256 * 1024): Uint8Array {
  const source = new Uint8Array(size);
  let state = 0x12345678;
  for (let i = 0; i < source.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    source[i] = state & 0xff;
  }
  return zlib.gzipSync(source);
}

test('node adapter: file full-buffer input honors maxInputBytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bytefold-node-input-'));
  const file = path.join(root, 'payload.gz');
  await writeFile(file, buildGzipPayload());

  try {
    await assert.rejects(
      async () => {
        await openArchive(file, { format: 'gz', limits: { maxInputBytes: 64 } });
      },
      (error: unknown) => error instanceof RangeError
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('node adapter: URL full fetch cancels slow responses once maxInputBytes is exceeded', async (t) => {
  const payload = buildGzipPayload();
  const chunkSize = 1024;
  const maxInputBytes = 512;
  let served = 0;

  const server = http.createServer((req, res) => {
    if (req.url !== '/payload.gz') {
      res.statusCode = 404;
      res.end();
      return;
    }

    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      const end = Math.min(offset + chunkSize, payload.length);
      const chunk = payload.subarray(offset, end);
      served += chunk.length;
      res.write(chunk);
      offset = end;
      if (offset >= payload.length) {
        clearInterval(timer);
        res.end();
      }
    }, 2);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/payload.gz`;

  await assert.rejects(
    async () => {
      await openArchive(url, { format: 'gz' });
    },
    (error: unknown) => error instanceof ArchiveError && error.code === 'ARCHIVE_UNSUPPORTED_FEATURE'
  );
  assert.equal(served, 0, 'http url inputs must reject before any transfer without opt-in');

  await assert.rejects(
    async () => {
      await openArchive(
        url,
        allowLocalHttp({
          format: 'gz',
          limits: { maxInputBytes }
        })
      );
    },
    (error: unknown) => error instanceof RangeError
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  const budget = maxInputBytes + chunkSize * 8;
  assert.ok(served <= budget, `expected bounded transfer <= ${budget}, received ${served}`);
});
