import { openArchive, tarToFile, zipToFile, TarWriter } from '../dist/deno/index.js';

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
  const gzStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(tarBytes);
      controller.close();
    }
  }).pipeThrough(new CompressionStream('gzip'));
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

  if (zipArchive.normalizeToWritable) {
    const normChunks: Uint8Array[] = [];
    const normWritable = new WritableStream<Uint8Array>({
      write(chunk) {
        normChunks.push(chunk);
      }
    });
    await zipArchive.normalizeToWritable(normWritable, { deterministic: true });
    const normalized = concatChunks(normChunks);
    const normalizedArchive = await openArchive(normalized);
    if (normalizedArchive.format !== 'zip') throw new Error('normalized zip invalid');
  }
});
