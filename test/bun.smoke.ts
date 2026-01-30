import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openArchive, TarWriter, tarToFile, zipToFile } from '../dist/bun/index.js';

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
  const tmp = await mkdtemp(path.join(tmpdir(), 'archive-shield-bun-'));
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
    const gzStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(tarBytes);
        controller.close();
      }
    }).pipeThrough(new CompressionStream('gzip'));
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
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
