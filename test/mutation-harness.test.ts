import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openArchive, ArchiveError, ZipError } from '@ismail-elkorchi/bytefold/node';
import { CompressionError } from '@ismail-elkorchi/bytefold/compress';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const FIXTURE_ROOT = new URL('../test/fixtures/', import.meta.url);
const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);
const AUDIT_SCHEMA = new URL('../schemas/audit-report.schema.json', import.meta.url);

const MUTATION_SEED = 0x51d0f00d;
const MAX_MUTATION_CASES = 500;
const MAX_BUDGET_MULTIPLIER = 4;

type Fixture = { name: string; format: 'zip' | 'tar' | 'gz' | 'bz2' | 'xz' };
type Shape = 'bytes' | 'stream' | 'file' | 'url';

const SHAPES: Shape[] = ['bytes', 'stream', 'file', 'url'];

const FIXTURES: Fixture[] = [
  { name: 'gzip-header-options.gz', format: 'gz' },
  { name: 'thirdparty/zip/zip_cp437_header.zip', format: 'zip' },
  { name: 'thirdparty/zip/zip64.zip', format: 'zip' },
  { name: 'thirdparty/tar/pax.tar', format: 'tar' },
  { name: 'ambiguous/tar-path-traversal.tar', format: 'tar' },
  { name: 'hello.txt.bz2', format: 'bz2' },
  { name: 'hello.txt.xz', format: 'xz' }
];

test('mutation harness produces typed errors or schema-valid audits across boundaries', { timeout: 60000 }, async () => {
  const errorSchema = await loadSchema(ERROR_SCHEMA);
  const auditSchema = await loadSchema(AUDIT_SCHEMA);
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bytefold-mutation-'));
  const server = createRangeServer();
  await server.listen();

  const summary = {
    fixtures: 0,
    cases: 0,
    operatorCounts: new Map<string, number>(),
    failureCodes: new Set<string>()
  };

  try {
    for (const fixture of FIXTURES) {
      summary.fixtures += 1;
      const input = new Uint8Array(await readFile(new URL(fixture.name, FIXTURE_ROOT)));
      const rng = xorshift32(MUTATION_SEED ^ hashString(fixture.name));
      const mutations = buildMutations(input, rng);

      for (const mutation of mutations) {
        for (const shape of SHAPES) {
          summary.cases += 1;
          assert.ok(summary.cases <= MAX_MUTATION_CASES, 'mutation case budget exceeded');
          summary.operatorCounts.set(
            mutation.operator,
            (summary.operatorCounts.get(mutation.operator) ?? 0) + 1
          );

          const budget = createBudget(mutation.bytes.length, fixture.format, mutation.label, shape);
          const caseId = `mut-${summary.cases}-${hashString(mutation.label + shape)}`;
          const inputValue = await prepareInput(shape, mutation.bytes, tempDir, caseId, server, budget);

          let reader: Awaited<ReturnType<typeof openArchive>> | null = null;
          try {
            reader = await openArchive(inputValue, {
              format: fixture.format,
              signal: budget.signal
            });
          } catch (err) {
            recordFailure(err, summary.failureCodes, errorSchema);
            continue;
          }

          try {
            const report = await reader.audit({ signal: budget.signal });
            const json = toJson(report);
            const result = validateSchema(auditSchema, json);
            assert.ok(result.ok, result.errors.join('\n'));
          } catch (err) {
            recordFailure(err, summary.failureCodes, errorSchema);
          } finally {
            const close = (reader as { close?: () => Promise<void> }).close;
            if (close) {
              await close.call(reader).catch(() => {});
            }
          }
        }
      }
    }
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.ok(summary.cases > 0, 'no mutation cases executed');
  printSummary(summary);
});

type MutationCase = { label: string; operator: string; bytes: Uint8Array };

function buildMutations(input: Uint8Array, rng: () => number): MutationCase[] {
  const cases: MutationCase[] = [];
  const length = input.length;

  const truncatePositions = [0, 1, Math.floor(length / 2), Math.max(0, length - 1)];
  for (const pos of uniquePositions(truncatePositions, length)) {
    cases.push({ label: `truncate-${pos}`, operator: 'truncate', bytes: input.subarray(0, pos) });
  }

  const flipCount = Math.min(5, Math.max(1, length));
  for (let i = 0; i < flipCount; i += 1) {
    const offset = length === 0 ? 0 : rng() % length;
    const bit = 1 << (rng() % 8);
    const mutated = new Uint8Array(input);
    if (mutated.length > 0) mutated[offset] = (mutated[offset]! ^ bit) & 0xff;
    cases.push({ label: `flip-${offset}`, operator: 'flip', bytes: mutated });
  }

  for (const appendSize of [1, 4, 8]) {
    const junk = new Uint8Array(appendSize);
    for (let i = 0; i < junk.length; i += 1) junk[i] = rng() & 0xff;
    cases.push({ label: `append-${appendSize}`, operator: 'append', bytes: concatBytes([input, junk]) });
  }

  const dupCount = Math.min(3, Math.max(1, Math.floor(length / 8)));
  for (let i = 0; i < dupCount; i += 1) {
    if (length === 0) {
      cases.push({ label: 'dup-empty', operator: 'duplicate', bytes: new Uint8Array(0) });
      break;
    }
    const start = rng() % length;
    const maxSlice = Math.min(length - start, 16);
    const sliceLen = Math.max(1, (rng() % maxSlice) + 1);
    const prefix = input.subarray(0, start + sliceLen);
    const slice = input.subarray(start, start + sliceLen);
    const suffix = input.subarray(start + sliceLen);
    cases.push({ label: `dup-${start}-${sliceLen}`, operator: 'duplicate', bytes: concatBytes([prefix, slice, suffix]) });
  }

  return cases;
}

type Budget = {
  signal: AbortSignal;
  consume: (bytes: number) => void;
  maxBytes: number;
  used: () => number;
};

function createBudget(size: number, format: Fixture['format'], label: string, shape: Shape): Budget {
  const controller = new AbortController();
  const maxBytes = Math.max(1024, size * MAX_BUDGET_MULTIPLIER);
  let used = 0;
  const consume = (bytes: number) => {
    used += bytes;
    if (used > maxBytes && !controller.signal.aborted) {
      controller.abort(
        new ArchiveError('ARCHIVE_LIMIT_EXCEEDED', 'Mutation harness budget exceeded', {
          context: {
            format,
            label,
            shape,
            limitBytes: String(maxBytes),
            observedBytes: String(used)
          }
        })
      );
    }
  };
  return { signal: controller.signal, consume, maxBytes, used: () => used };
}

type UrlServer = {
  register: (id: string, bytes: Uint8Array, budget: Budget) => void;
  urlFor: (id: string) => string;
  listen: () => Promise<void>;
  close: () => Promise<void>;
};

function createRangeServer(): UrlServer {
  const cases = new Map<string, { bytes: Uint8Array; budget: Budget }>();
  let port = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const caseId = url.pathname.replace(/^\/+/, '');
    const entry = cases.get(caseId);
    if (!entry) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const bytes = entry.bytes;

    res.setHeader('Accept-Ranges', 'bytes');
    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.setHeader('Content-Length', bytes.length);
      res.end();
      return;
    }

    let start = 0;
    let end = bytes.length - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
      if (!match) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${bytes.length}`);
        res.end();
        return;
      }
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= bytes.length) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${bytes.length}`);
        res.end();
        return;
      }
      end = Math.min(end, bytes.length - 1);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
    } else {
      res.statusCode = 200;
    }

    const slice = bytes.subarray(start, end + 1);
    entry.budget.consume(slice.length);
    res.setHeader('Content-Length', slice.length);
    res.end(slice);
  });

  return {
    register: (id, bytes, budget) => {
      cases.set(id, { bytes, budget });
    },
    urlFor: (id) => `http://127.0.0.1:${port}/${id}`,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (address && typeof address === 'object') port = address.port;
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      })
  };
}

async function prepareInput(
  shape: Shape,
  bytes: Uint8Array,
  tempDir: string,
  caseId: string,
  server: UrlServer,
  budget: Budget
): Promise<Uint8Array | ReadableStream<Uint8Array> | string | URL> {
  switch (shape) {
    case 'bytes':
      budget.consume(bytes.length);
      return bytes;
    case 'stream': {
      const seed = hashString(`${caseId}-stream`);
      return chunkStream(bytes, xorshift32(seed), budget);
    }
    case 'file': {
      const filePath = path.join(tempDir, `${caseId}.bin`);
      await writeFile(filePath, bytes);
      budget.consume(bytes.length);
      return filePath;
    }
    case 'url': {
      server.register(caseId, bytes, budget);
      return new URL(server.urlFor(caseId));
    }
    default: {
      const exhaustive: never = shape;
      return exhaustive;
    }
  }
}

function chunkStream(bytes: Uint8Array, rng: () => number, budget: Budget): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const maxChunk = Math.max(1, Math.min(64, bytes.length - offset));
      const size = 1 + (rng() % maxChunk);
      const end = Math.min(bytes.length, offset + size);
      const chunk = bytes.subarray(offset, end);
      offset = end;
      budget.consume(chunk.length);
      controller.enqueue(chunk);
    }
  });
}

function uniquePositions(values: number[], length: number): number[] {
  const seen = new Set<number>();
  for (const value of values) {
    const clamped = Math.max(0, Math.min(length, Math.floor(value)));
    seen.add(clamped);
  }
  return [...seen.values()].sort((a, b) => a - b);
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

function xorshift32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x >>>= 0;
    x ^= x << 5;
    x >>>= 0;
    return x >>> 0;
  };
}

function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return hash >>> 0;
}

async function loadSchema(url: URL): Promise<JsonSchema> {
  return (JSON.parse(await readFile(url, 'utf8')) as unknown) as JsonSchema;
}

function recordFailure(err: unknown, failureCodes: Set<string>, errorSchema: JsonSchema): void {
  assertTypedError(err, errorSchema);
  const code = getErrorCode(err);
  if (code) failureCodes.add(code);
}

function assertTypedError(err: unknown, errorSchema: JsonSchema): void {
  assert.ok(err instanceof ArchiveError || err instanceof CompressionError || err instanceof ZipError);
  const json = (err as ArchiveError | CompressionError | ZipError).toJSON();
  const result = validateSchema(errorSchema, json);
  assert.ok(result.ok, result.errors.join('\n'));
}

function getErrorCode(err: unknown): string | null {
  if (err instanceof ArchiveError || err instanceof CompressionError || err instanceof ZipError) {
    return err.code;
  }
  return null;
}

function toJson(value: unknown): unknown {
  if (value && typeof value === 'object' && 'toJSON' in value) {
    const record = value as { toJSON?: () => unknown };
    if (record.toJSON) return record.toJSON();
  }
  return JSON.parse(JSON.stringify(value));
}

function printSummary(summary: {
  fixtures: number;
  cases: number;
  operatorCounts: Map<string, number>;
  failureCodes: Set<string>;
}): void {
  const operatorSummary = [...summary.operatorCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([op, count]) => `${op}=${count}`)
    .join(', ');
  const failureSummary =
    summary.failureCodes.size > 0
      ? [...summary.failureCodes.values()].sort().join(', ')
      : 'none';
  console.log(
    `[mutation-harness] fixtures=${summary.fixtures} cases=${summary.cases} operators={${operatorSummary}} failureCodes=${failureSummary}`
  );
}
