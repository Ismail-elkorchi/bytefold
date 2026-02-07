import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { openArchive, ArchiveError } from '@ismail-elkorchi/bytefold/node';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const FIXTURE_ROOT = new URL('../test/fixtures/', import.meta.url);
const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);

const ETAG_V1 = '"bytefold-xz-etag-v1"';
const ETAG_V2 = '"bytefold-xz-etag-v2"';
const WEAK_ETAG_V1 = 'W/"bytefold-xz-etag-v1"';
const LAST_MODIFIED = new Date(0).toUTCString();

type MappingMode =
  | 'no-range'
  | 'bad-content-range'
  | 'resource-changed'
  | 'content-encoding'
  | 'bad-status'
  | 'size-unknown'
  | 'weak-etag';

type MappingCase = {
  name: string;
  mode: MappingMode;
  expectedArchiveCode: string;
  expectedHttpCode: string;
  options?: {
    zip?: {
      http?: {
        snapshot?: 'require-strong-etag' | 'best-effort';
      };
    };
  };
};

test('xz seekable preflight maps HTTP failures to archive HTTP codes', async () => {
  const bytes = new Uint8Array(await readFile(new URL('hello.txt.xz', FIXTURE_ROOT)));
  const schema = (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;

  const cases: MappingCase[] = [
    {
      name: 'range unsupported',
      mode: 'no-range',
      expectedArchiveCode: 'ARCHIVE_HTTP_RANGE_UNSUPPORTED',
      expectedHttpCode: 'HTTP_RANGE_UNSUPPORTED'
    },
    {
      name: 'invalid content-range',
      mode: 'bad-content-range',
      expectedArchiveCode: 'ARCHIVE_HTTP_RANGE_INVALID',
      expectedHttpCode: 'HTTP_RANGE_INVALID'
    },
    {
      name: 'resource changed',
      mode: 'resource-changed',
      expectedArchiveCode: 'ARCHIVE_HTTP_RESOURCE_CHANGED',
      expectedHttpCode: 'HTTP_RESOURCE_CHANGED'
    },
    {
      name: 'content-encoding rejected',
      mode: 'content-encoding',
      expectedArchiveCode: 'ARCHIVE_HTTP_CONTENT_ENCODING',
      expectedHttpCode: 'HTTP_CONTENT_ENCODING'
    },
    {
      name: 'strong etag required',
      mode: 'weak-etag',
      expectedArchiveCode: 'ARCHIVE_HTTP_STRONG_ETAG_REQUIRED',
      expectedHttpCode: 'HTTP_STRONG_ETAG_REQUIRED',
      options: { zip: { http: { snapshot: 'require-strong-etag' } } }
    },
    {
      name: 'bad response status',
      mode: 'bad-status',
      expectedArchiveCode: 'ARCHIVE_HTTP_BAD_RESPONSE',
      expectedHttpCode: 'HTTP_BAD_RESPONSE'
    },
    {
      name: 'size unknown',
      mode: 'size-unknown',
      expectedArchiveCode: 'ARCHIVE_HTTP_SIZE_UNKNOWN',
      expectedHttpCode: 'HTTP_SIZE_UNKNOWN'
    }
  ];

  for (const testCase of cases) {
    const { server, url } = await startXzMappingServer(bytes, testCase.mode);
    try {
      await assert.rejects(
        () =>
          openArchive(url, {
            format: 'xz',
            ...(testCase.options ?? {})
          }),
        (err: unknown) => {
          if (!(err instanceof ArchiveError)) return false;
          assert.equal(err.code, testCase.expectedArchiveCode, `${testCase.name} archive code mismatch`);
          const json = err.toJSON();
          const result = validateSchema(schema, json);
          assert.ok(result.ok, result.errors.join('\n'));
          const context = (json as { context?: Record<string, string> }).context;
          assert.equal(context?.httpCode, testCase.expectedHttpCode, `${testCase.name} http code mismatch`);
          return true;
        }
      );
    } finally {
      await closeServer(server);
    }
  }
});

async function startXzMappingServer(
  data: Uint8Array,
  mode: MappingMode
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      if (mode === 'size-unknown') {
        res.statusCode = 405;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Length', data.length);
      res.setHeader('Last-Modified', LAST_MODIFIED);
      if (mode === 'resource-changed') {
        res.setHeader('ETag', ETAG_V1);
      } else if (mode === 'weak-etag') {
        res.setHeader('ETag', WEAK_ETAG_V1);
      }
      res.end();
      return;
    }

    if (mode === 'bad-status') {
      res.statusCode = 503;
      res.end();
      return;
    }

    const range = req.headers.range;
    if (mode === 'no-range' || typeof range !== 'string') {
      res.statusCode = 200;
      res.setHeader('Content-Length', data.length);
      res.end(data);
      return;
    }

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
    const body = data.subarray(start, safeEnd + 1);
    res.statusCode = 206;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Last-Modified', LAST_MODIFIED);

    if (mode === 'resource-changed') {
      res.setHeader('ETag', ETAG_V2);
    } else if (mode === 'weak-etag') {
      res.setHeader('ETag', WEAK_ETAG_V1);
    }

    if (mode === 'content-encoding') {
      res.setHeader('Content-Encoding', 'gzip');
    }

    if (mode === 'bad-content-range' || mode === 'size-unknown') {
      res.setHeader('Content-Range', 'bytes 0-0/*');
      res.setHeader('Content-Length', 1);
      res.end(data.subarray(0, 1));
      return;
    }

    res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${data.length}`);
    res.setHeader('Content-Length', body.length);
    res.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}/hello.txt.xz` };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
