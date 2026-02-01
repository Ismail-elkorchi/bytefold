import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openArchive, TarWriter, tarToFile, zipToFile } from '../dist/bun/index.js';
import {
  CompressionError,
  createCompressor,
  createDecompressor,
  getCompressionCapabilities
} from '../dist/compress/index.js';

const encoder = new TextEncoder();

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

test('bun smoke: zip, tar, tgz', async () => {
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

    const tgzArchive = await openArchive(tgzPath);
    expect(tgzArchive.format).toBe('tgz');

    const caps = getCompressionCapabilities();
    const algorithms: Array<'gzip' | 'deflate-raw' | 'deflate' | 'brotli' | 'zstd'> = [
      'gzip',
      'deflate-raw',
      'deflate',
      'brotli',
      'zstd'
    ];
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
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

function readableFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });
}
