import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createArchiveWriter } from '../../dist/web/index.js';

const ROOT_DIRECTORY = fileURLToPath(new URL('../../', import.meta.url));
const DIST_DIRECTORY = path.join(ROOT_DIRECTORY, 'dist');
const HELLO_FIXTURE_URL = new URL('../fixtures/expected/hello.txt', import.meta.url);
const MODULE_PATH = '/dist/web/index.js';

test('browser web: blob zip roundtrip open/list/extract', async ({ page }) => {
  const harness = await startBrowserHarness();
  const helloBytes = await readHelloFixture();
  const zipBytes = await buildZipFixture(helloBytes);

  try {
    await page.goto(harness.baseUrl);
    const result = await page.evaluate(
      async ({ moduleUrl, zipBytesInput }) => {
        const collectStream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!value) continue;
              chunks.push(value);
              total += value.length;
            }
          } finally {
            reader.releaseLock();
          }

          const out = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
          }
          return out;
        };

        const bytefold = await import(moduleUrl);
        const archive = await bytefold.openArchive(new Blob([new Uint8Array(zipBytesInput)]), {
          format: 'zip'
        });

        const names: string[] = [];
        let helloPayload: number[] = [];
        for await (const entry of archive.entries()) {
          names.push(entry.name);
          if (entry.name === 'hello.txt') {
            const stream = await entry.open();
            const bytes = await collectStream(stream);
            helloPayload = Array.from(bytes);
          }
        }

        return {
          format: archive.format,
          inputKind: archive.detection?.inputKind,
          names,
          helloPayload
        };
      },
      {
        moduleUrl: `${harness.baseUrl}${MODULE_PATH}`,
        zipBytesInput: Array.from(zipBytes)
      }
    );

    expect(result.format).toBe('zip');
    expect(result.inputKind).toBe('blob');
    expect(result.names.sort()).toEqual(['hello.txt', 'nested/hello.txt']);
    expect(result.helloPayload).toEqual(Array.from(helloBytes));
  } finally {
    await harness.close();
  }
});

test('browser web: writer roundtrip zip store-only and tar', async ({ page }) => {
  const harness = await startBrowserHarness();
  const helloBytes = await readHelloFixture();

  try {
    await page.goto(harness.baseUrl);
    const result = await page.evaluate(
      async ({ moduleUrl, helloBytesInput }) => {
        const collectStream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!value) continue;
              chunks.push(value);
              total += value.length;
            }
          } finally {
            reader.releaseLock();
          }
          const out = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
          }
          return out;
        };

        const writeArchiveBytes = async (
          bytefoldModule: typeof import('../../dist/web/index.js'),
          format: 'zip' | 'tar',
          entries: Array<[string, Uint8Array]>,
          options?: Parameters<typeof import('../../dist/web/index.js').createArchiveWriter>[2]
        ): Promise<Uint8Array> => {
          const chunks: Uint8Array[] = [];
          const writable = new WritableStream<Uint8Array>({
            write(chunk) {
              const copy = new Uint8Array(chunk.length);
              copy.set(chunk);
              chunks.push(copy);
            }
          });
          const writer = bytefoldModule.createArchiveWriter(format, writable, options);
          for (const [name, data] of entries) {
            await writer.add(name, data);
          }
          await writer.close();
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const out = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
          }
          return out;
        };

        const collectEntries = async (archive: Awaited<ReturnType<typeof import('../../dist/web/index.js').openArchive>>) => {
          const entries: Record<string, Uint8Array> = {};
          for await (const entry of archive.entries()) {
            const stream = await entry.open();
            entries[entry.name] = await collectStream(stream);
          }
          return entries;
        };

        const toOwnedArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
          const out = new Uint8Array(bytes.length);
          out.set(bytes);
          return out.buffer;
        };

        const bytefold = await import(moduleUrl);
        const entryBytes = new Uint8Array(helloBytesInput);
        const zipBytes = await writeArchiveBytes(
          bytefold,
          'zip',
          [
            ['hello.txt', entryBytes],
            ['nested/hello.txt', entryBytes]
          ],
          { zip: { defaultMethod: 0 } }
        );
        const tarBytes = await writeArchiveBytes(bytefold, 'tar', [['hello.txt', entryBytes]], {
          tar: { isDeterministic: true }
        });

        const zipArchive = await bytefold.openArchive(new Blob([toOwnedArrayBuffer(zipBytes)]), { format: 'zip' });
        const tarArchive = await bytefold.openArchive(new Blob([toOwnedArrayBuffer(tarBytes)]), { format: 'tar' });

        const zipEntries = await collectEntries(zipArchive);
        const tarEntries = await collectEntries(tarArchive);

        return {
          zipFormat: zipArchive.format,
          tarFormat: tarArchive.format,
          zipInputKind: zipArchive.detection?.inputKind,
          tarInputKind: tarArchive.detection?.inputKind,
          zipNames: Object.keys(zipEntries).sort(),
          tarNames: Object.keys(tarEntries).sort(),
          zipHello: Array.from(zipEntries['hello.txt'] ?? []),
          zipNestedHello: Array.from(zipEntries['nested/hello.txt'] ?? []),
          tarHello: Array.from(tarEntries['hello.txt'] ?? [])
        };
      },
      {
        moduleUrl: `${harness.baseUrl}${MODULE_PATH}`,
        helloBytesInput: Array.from(helloBytes)
      }
    );

    expect(result.zipFormat).toBe('zip');
    expect(result.tarFormat).toBe('tar');
    expect(result.zipInputKind).toBe('blob');
    expect(result.tarInputKind).toBe('blob');
    expect(result.zipNames).toEqual(['hello.txt', 'nested/hello.txt']);
    expect(result.tarNames).toEqual(['hello.txt']);
    expect(result.zipHello).toEqual(Array.from(helloBytes));
    expect(result.zipNestedHello).toEqual(Array.from(helloBytes));
    expect(result.tarHello).toEqual(Array.from(helloBytes));
  } finally {
    await harness.close();
  }
});

test('browser web: url maxInputBytes aborts adversarial chunked fetch with bounded transfer', async ({ page }) => {
  const chunkSize = 1024;
  const maxInputBytes = 4096;
  const harness = await startBrowserHarness({
    adversarial: {
      chunkSize,
      intervalMs: 8,
      maxPostCloseWriteAttempts: 8
    }
  });

  try {
    await page.goto(harness.baseUrl);
    const browserStats = await page.evaluate(
      async ({ moduleUrl, archiveUrl, inputByteLimit }) => {
        const bytefold = await import(moduleUrl);
        const originalFetch = globalThis.fetch.bind(globalThis);
        const clientStats = {
          clientBytesRead: 0,
          clientChunksRead: 0
        };

        globalThis.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (!response.body) return response;
          const reader = response.body.getReader();
          const countedBody = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { value, done } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              if (value) {
                clientStats.clientBytesRead += value.length;
                clientStats.clientChunksRead += 1;
                controller.enqueue(value);
              }
            },
            async cancel(reason) {
              await reader.cancel(reason);
            }
          });

          return new Response(countedBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        };

        let didThrow = false;
        let threwRangeError = false;
        let errorMessage = '';
        try {
          await bytefold.openArchive(archiveUrl, {
            format: 'zip',
            limits: { maxInputBytes: inputByteLimit }
          });
        } catch (error: unknown) {
          didThrow = true;
          threwRangeError = error instanceof RangeError;
          errorMessage = error instanceof Error ? error.message : String(error);
        } finally {
          globalThis.fetch = originalFetch;
        }

        return {
          didThrow,
          threwRangeError,
          errorMessage,
          ...clientStats
        };
      },
      {
        moduleUrl: `${harness.baseUrl}${MODULE_PATH}`,
        archiveUrl: `${harness.baseUrl}/adversarial/chunked.bin`,
        inputByteLimit: maxInputBytes
      }
    );

    const stats = harness.adversarialStats;
    const observedClientClose = await waitForClientClose(stats, 1200);
    const closeLatencyMs =
      stats.firstWriteAtMs !== null && stats.clientClosedAtMs !== null ? stats.clientClosedAtMs - stats.firstWriteAtMs : null;

    expect(browserStats.didThrow).toBe(true);
    expect(browserStats.threwRangeError).toBe(true);
    expect(stats.requests).toBe(1);
    expect(stats.rangeHeaders).toEqual([]);
    expect(observedClientClose).toBe(true);
    expect(stats.writesAfterClientClosed).toBeGreaterThan(0);

    const clientBudget = maxInputBytes + chunkSize * 2;
    const serverBudget = maxInputBytes + chunkSize * 12;
    expect(browserStats.clientBytesRead).toBeLessThanOrEqual(clientBudget);
    expect(stats.bodyBytesFlushed).toBeLessThanOrEqual(serverBudget);
    expect(stats.bodyBytesFlushed).toBeLessThan(chunkSize * 32);
    expect(closeLatencyMs).not.toBeNull();
    expect(closeLatencyMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1000);

    test.info().annotations.push({
      type: 'falsification-stats',
      description:
        `clientBytesRead=${browserStats.clientBytesRead}, bodyBytesFlushed=${stats.bodyBytesFlushed}, ` +
        `bodyBytesAttempted=${stats.bodyBytesAttempted}, writesAfterClientClosed=${stats.writesAfterClientClosed}, ` +
        `closeLatencyMs=${closeLatencyMs}`
    });
  } finally {
    await harness.close();
  }
});

async function buildZipFixture(helloBytes: Uint8Array): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(copyChunk(chunk));
    }
  });

  const writer = createArchiveWriter('zip', writable, { zip: { defaultMethod: 0 } });
  await writer.add('hello.txt', helloBytes);
  await writer.add('nested/hello.txt', helloBytes);
  await writer.close();
  return concatChunks(chunks);
}

async function readHelloFixture(): Promise<Uint8Array> {
  const fixture = await readFile(HELLO_FIXTURE_URL);
  const out = new Uint8Array(fixture.length);
  out.set(fixture);
  return out;
}

type BrowserHarness = {
  adversarialStats: AdversarialStats;
  baseUrl: string;
  close: () => Promise<void>;
};

type AdversarialOptions = {
  chunkSize: number;
  intervalMs: number;
  maxPostCloseWriteAttempts: number;
};

type AdversarialStats = {
  bodyBytesAttempted: number;
  bodyBytesFlushed: number;
  clientClosedAtMs: number | null;
  firstWriteAtMs: number | null;
  rangeHeaders: string[];
  requests: number;
  writesAfterClientClosed: number;
};

async function startBrowserHarness(options?: { adversarial?: AdversarialOptions }): Promise<BrowserHarness> {
  const adversarial = options?.adversarial ?? { chunkSize: 1024, intervalMs: 8, maxPostCloseWriteAttempts: 8 };
  const adversarialStats: AdversarialStats = {
    bodyBytesAttempted: 0,
    bodyBytesFlushed: 0,
    clientClosedAtMs: null,
    firstWriteAtMs: null,
    rangeHeaders: [],
    requests: 0,
    writesAfterClientClosed: 0
  };
  const timers = new Set<NodeJS.Timeout>();

  const server = http.createServer((req, res) => {
    void serveBrowserHarnessRequest(req, res, adversarial, adversarialStats, timers).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      if (!res.writableEnded) {
        res.end('internal error');
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server, timers);
    throw new Error('Unable to resolve browser harness address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    adversarialStats,
    close: async () => closeServer(server, timers)
  };
}

async function serveBrowserHarnessRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  adversarial: AdversarialOptions,
  adversarialStats: AdversarialStats,
  timers: Set<NodeJS.Timeout>
): Promise<void> {
  const pathname = normalizePathname(req.url ?? '/');

  if (pathname === '/adversarial/chunked.bin') {
    handleAdversarialRequest(req, res, adversarial, adversarialStats, timers);
    return;
  }

  if (pathname === '/') {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body>bytefold browser smoke</body></html>');
    return;
  }

  if (!pathname.startsWith('/dist/')) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  const relativePath = pathname.slice('/dist/'.length);
  const absolutePath = path.resolve(DIST_DIRECTORY, relativePath);
  if (!absolutePath.startsWith(DIST_DIRECTORY + path.sep) && absolutePath !== DIST_DIRECTORY) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }

  try {
    const body = await readFile(absolutePath);
    res.statusCode = 200;
    res.setHeader('content-type', mimeTypeForPath(absolutePath));
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}

function handleAdversarialRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: AdversarialOptions,
  stats: AdversarialStats,
  timers: Set<NodeJS.Timeout>
): void {
  stats.requests += 1;
  if (req.headers.range) {
    stats.rangeHeaders.push(String(req.headers.range));
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('transfer-encoding', 'chunked');

  const chunk = buildPatternBytes(options.chunkSize);
  let requestClosed = false;
  let responseClosed = false;
  let hasAttemptedPostCloseWrites = false;

  const markClientClosed = (): void => {
    if (stats.clientClosedAtMs === null) {
      stats.clientClosedAtMs = Date.now();
    }
  };

  const attemptPostCloseWrites = (): void => {
    if (hasAttemptedPostCloseWrites) return;
    hasAttemptedPostCloseWrites = true;
    for (let i = 0; i < options.maxPostCloseWriteAttempts; i += 1) {
      stats.writesAfterClientClosed += 1;
      stats.bodyBytesAttempted += chunk.length;
      try {
        res.write(chunk, () => {
          stats.bodyBytesFlushed += chunk.length;
        });
      } catch {
        // Ignore writes after close in adversarial mode.
      }
    }
  };

  const timer = setInterval(() => {
    if (stats.firstWriteAtMs === null) {
      stats.firstWriteAtMs = Date.now();
    }
    if (requestClosed || responseClosed) {
      stats.writesAfterClientClosed += 1;
    }
    stats.bodyBytesAttempted += chunk.length;
    try {
      res.write(chunk, () => {
        stats.bodyBytesFlushed += chunk.length;
      });
    } catch {
      // Ignore writes that race with socket close in adversarial mode.
    }
    if (stats.writesAfterClientClosed >= options.maxPostCloseWriteAttempts) {
      clearInterval(timer);
      timers.delete(timer);
    }
  }, options.intervalMs);
  timers.add(timer);

  req.on('aborted', () => {
    requestClosed = true;
    markClientClosed();
    attemptPostCloseWrites();
  });
  req.on('close', () => {
    requestClosed = true;
    markClientClosed();
    attemptPostCloseWrites();
  });
  res.on('close', () => {
    responseClosed = true;
    markClientClosed();
    attemptPostCloseWrites();
  });
}

async function closeServer(server: http.Server, timers: Set<NodeJS.Timeout>): Promise<void> {
  for (const timer of timers) {
    clearInterval(timer);
  }
  timers.clear();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function normalizePathname(rawPath: string): string {
  const [pathname] = rawPath.split('?', 1);
  return pathname ? decodeURIComponent(pathname) : '/';
}

async function waitForClientClose(stats: AdversarialStats, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (stats.clientClosedAtMs !== null) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return stats.clientClosedAtMs !== null;
}

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.map') return 'application/json; charset=utf-8';
  if (extension === '.d.ts') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function copyChunk(chunk: Uint8Array): Uint8Array {
  const out = new Uint8Array(chunk.length);
  out.set(chunk);
  return out;
}

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

function buildPatternBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  let state = 0x9e37_79b9;
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}
