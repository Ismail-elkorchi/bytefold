import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { ArchiveError, createArchiveWriter, openArchive } from '@ismail-elkorchi/bytefold';
import { CompressionError } from '@ismail-elkorchi/bytefold/compress';
import { ZipError } from '@ismail-elkorchi/bytefold/zip';

test('openArchive: gzip maxTotalDecompressedBytes fails with typed limit error', async () => {
  const gz = zlib.gzipSync(new Uint8Array(256 * 1024).fill(0x61));

  await assert.rejects(
    () => openArchive(gz, { format: 'gz', limits: { maxTotalDecompressedBytes: 1024 } }),
    (err: unknown) =>
      err instanceof CompressionError &&
      err.code === 'COMPRESSION_RESOURCE_LIMIT' &&
      err.algorithm === 'gzip'
  );
});

test('openArchive: gzip maxTotalUncompressedBytes aliases the high-level output ceiling', async () => {
  const gz = zlib.gzipSync(new Uint8Array(256 * 1024).fill(0x61));

  await assert.rejects(
    () => openArchive(gz, { format: 'gz', limits: { maxTotalUncompressedBytes: 1024 } }),
    (err: unknown) =>
      err instanceof CompressionError &&
      err.code === 'COMPRESSION_RESOURCE_LIMIT' &&
      err.algorithm === 'gzip'
  );
});

test('openArchive: tgz profile agent rejects over-ratio payloads before tar detection', async () => {
  const tar = await buildArchiveBytes('tar', [['ratio.bin', new Uint8Array(512 * 1024)]]);
  const tgz = zlib.gzipSync(tar);

  await assert.rejects(
    () =>
      openArchive(tgz, {
        format: 'tgz',
        profile: 'agent',
        limits: { maxEntries: 10_000 }
      }),
    (err: unknown) =>
      err instanceof CompressionError &&
      err.code === 'COMPRESSION_RESOURCE_LIMIT' &&
      err.algorithm === 'gzip'
  );

  const relaxed = await openArchive(tgz, {
    format: 'tgz',
    profile: 'agent',
    limits: { maxCompressionRatio: 1_000_000 }
  });
  assert.equal(relaxed.format, 'tgz');
});

test('openArchive: zip maxEntries fails with typed context', async () => {
  const zip = await buildArchiveBytes('zip', [
    ['a.txt', new Uint8Array([0x61])],
    ['b.txt', new Uint8Array([0x62])]
  ]);

  await assert.rejects(
    () => openArchive(zip, { format: 'zip', limits: { maxEntries: 1 } }),
    (err: unknown) => {
      if (!(err instanceof ZipError) || err.code !== 'ZIP_LIMIT_EXCEEDED') return false;
      const json = err.toJSON() as { context?: Record<string, string> };
      assert.equal(json.context?.requiredEntries, '2');
      assert.equal(json.context?.limitEntries, '1');
      return true;
    }
  );
});

test('openArchive: zip maxZipCommentBytes fails on EOCD comments', async () => {
  const zip = addZipComment(
    await buildArchiveBytes('zip', [['a.txt', new Uint8Array([0x61])]]),
    new TextEncoder().encode('comment-too-large')
  );

  await assert.rejects(
    () => openArchive(zip, { format: 'zip', limits: { maxZipCommentBytes: 1 } }),
    (err: unknown) => {
      if (!(err instanceof ZipError) || err.code !== 'ZIP_LIMIT_EXCEEDED') return false;
      const json = err.toJSON() as { context?: Record<string, string> };
      assert.equal(json.context?.requiredCommentBytes, String('comment-too-large'.length));
      assert.equal(json.context?.limitCommentBytes, '1');
      return true;
    }
  );
});

test('openArchive: zip maxUncompressedEntryBytes rejects oversized entries', async () => {
  const zip = await buildArchiveBytes('zip', [['big.txt', new Uint8Array(4096)]]);

  await assert.rejects(
    () => openArchive(zip, { format: 'zip', limits: { maxUncompressedEntryBytes: 1024 } }),
    (err: unknown) =>
      err instanceof ZipError && err.code === 'ZIP_LIMIT_EXCEEDED' && err.entryName === 'big.txt'
  );
});

test('openArchive: zip maxTotalUncompressedBytes rejects oversized totals', async () => {
  const zip = await buildArchiveBytes('zip', [
    ['a.txt', new Uint8Array(4096)],
    ['b.txt', new Uint8Array(4096)]
  ]);

  await assert.rejects(
    () => openArchive(zip, { format: 'zip', limits: { maxTotalUncompressedBytes: 4096 } }),
    (err: unknown) => err instanceof ZipError && err.code === 'ZIP_LIMIT_EXCEEDED'
  );
});

test('openArchive: zip maxCompressionRatio rejects over-expanded entries in strict mode', async () => {
  const zip = await buildArchiveBytes('zip', [['ratio.bin', new Uint8Array(512 * 1024)]]);

  await assert.rejects(
    () => openArchive(zip, { format: 'zip', limits: { maxCompressionRatio: 0.5 } }),
    (err: unknown) =>
      err instanceof ZipError && err.code === 'ZIP_LIMIT_EXCEEDED' && err.entryName === 'ratio.bin'
  );
});

test('openArchive: tar maxEntries rejects extra members', async () => {
  const tar = await buildArchiveBytes('tar', [
    ['a.txt', new Uint8Array([0x61])],
    ['b.txt', new Uint8Array([0x62])]
  ]);

  await assert.rejects(
    () => openArchive(tar, { format: 'tar', limits: { maxEntries: 1 } }),
    (err: unknown) => err instanceof ArchiveError && err.code === 'ARCHIVE_LIMIT_EXCEEDED'
  );
});

test('openArchive: tar maxTotalUncompressedBytes rejects oversized totals', async () => {
  const tar = await buildArchiveBytes('tar', [
    ['a.txt', new Uint8Array(4096)],
    ['b.txt', new Uint8Array(4096)]
  ]);

  await assert.rejects(
    () => openArchive(tar, { format: 'tar', limits: { maxTotalUncompressedBytes: 4096 } }),
    (err: unknown) => err instanceof ArchiveError && err.code === 'ARCHIVE_LIMIT_EXCEEDED'
  );
});

async function buildArchiveBytes(
  format: 'zip' | 'tar',
  entries: Array<[name: string, data: Uint8Array]>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = createArchiveWriter(format, writable);
  for (const [name, data] of entries) {
    await writer.add(name, data);
  }
  await writer.close();
  return concatChunks(chunks);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function addZipComment(bytes: Uint8Array, comment: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + comment.length);
  out.set(bytes);
  const eocdOffset = bytes.length - 22;
  out[eocdOffset + 20] = comment.length & 0xff;
  out[eocdOffset + 21] = (comment.length >>> 8) & 0xff;
  out.set(comment, bytes.length);
  return out;
}
