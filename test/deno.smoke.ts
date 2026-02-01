import { openArchive, tarToFile, zipToFile, TarWriter, createArchiveWriter } from '../dist/deno/index.js';
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

Deno.test('deno smoke: zip, tar, tgz', async () => {
  const coreUrl = new URL('../dist/index.js', import.meta.url);
  const coreModule = await import(coreUrl.href);
  if (typeof coreModule.openArchive !== 'function') throw new Error('default entrypoint missing openArchive');
  const coreSource = new TextDecoder().decode(await Deno.readFile(coreUrl.pathname));
  if (/from\\s+['\"]node:/.test(coreSource) || /import\\s+['\"]node:/.test(coreSource)) {
    throw new Error('default entrypoint imports node:*');
  }

  const tmp = await Deno.makeTempDir();
  const zipPath = `${tmp}/smoke.zip`;
  const tarPath = `${tmp}/smoke.tar`;
  const tgzPath = `${tmp}/smoke.tgz`;

  const zipWriter = await zipToFile(zipPath);
  await zipWriter.add('hello.txt', encoder.encode('hello deno'));
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
  await Deno.writeFile(tgzPath, tgzBytes);

  const zipArchive = await openArchive(zipPath);
  const zipEntries: string[] = [];
  for await (const entry of zipArchive.entries()) {
    zipEntries.push(entry.name);
    const data = await collect(await entry.open());
    if (entry.name === 'hello.txt') {
      const text = new TextDecoder().decode(data);
      if (text !== 'hello deno') throw new Error('zip content mismatch');
    }
  }
  if (zipEntries.length !== 1) throw new Error('zip entries mismatch');

  const tarArchive = await openArchive(tarPath);
  const tarEntries: string[] = [];
  for await (const entry of tarArchive.entries()) {
    tarEntries.push(entry.name);
  }
  if (!tarEntries.includes('greet.txt')) throw new Error('tar entry missing');

  const tgzArchive = await openArchive(tgzPath);
  if (tgzArchive.format !== 'tgz') throw new Error('tgz format not detected');

  const normalize = (
    zipArchive as {
      normalizeToWritable?: (
        w: WritableStream<Uint8Array>,
        o?: { deterministic?: boolean }
      ) => Promise<unknown>;
    }
  ).normalizeToWritable?.bind(zipArchive);
  if (normalize) {
    const normChunks: Uint8Array[] = [];
    const normWritable = new WritableStream<Uint8Array>({
      write(chunk) {
        normChunks.push(chunk);
      }
    });
    await normalize(normWritable, { deterministic: true });
    const normalized = concatChunks(normChunks);
    const normalizedArchive = await openArchive(normalized);
    if (normalizedArchive.format !== 'zip') throw new Error('normalized zip invalid');
  }

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
      readableFromBytes(encoder.encode('bytefold-compress-deno')).pipeThrough(compressor).pipeThrough(decompressor)
    );
    const text = new TextDecoder().decode(roundtrip);
    if (text !== 'bytefold-compress-deno') throw new Error(`compression roundtrip failed for ${algorithm}`);
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
    if (!abortedOk) throw new Error('compression abort did not trigger');
  }

  if (caps.algorithms.zstd.compress && caps.algorithms.zstd.decompress) {
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      }
    });
    const writer = createArchiveWriter('tar.zst', writable);
    await writer.add('zstd.txt', encoder.encode('zstd tar'));
    await writer.close();
    const tzstBytes = concatChunks(chunks);
    const tzstReader = await openArchive(tzstBytes);
    if (tzstReader.format !== 'tar.zst') throw new Error('tar.zst format not detected');
  }

  if (caps.algorithms.brotli.compress && caps.algorithms.brotli.decompress) {
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      }
    });
    const writer = createArchiveWriter('tar.br', writable);
    await writer.add('br.txt', encoder.encode('brotli tar'));
    await writer.close();
    const tbrBytes = concatChunks(chunks);
    const tbrReader = await openArchive(tbrBytes, { format: 'tar.br' });
    if (tbrReader.format !== 'tar.br') throw new Error('tar.br format not detected');
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
