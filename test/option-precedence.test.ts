import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArchiveError, createArchiveWriter, openArchive } from '@ismail-elkorchi/bytefold';
import { CompressionError, createDecompressor } from '@ismail-elkorchi/bytefold/compress';
import { TarReader } from '@ismail-elkorchi/bytefold/tar';
import { ZipError, ZipReader } from '@ismail-elkorchi/bytefold/zip';

const HELLO_XZ = new URL('../test/fixtures/hello.txt.xz', import.meta.url);
const UNSUPPORTED_CHECK_XZ = new URL('../test/fixtures/xz-utils/unsupported-check.xz', import.meta.url);

test('openArchive: explicit limits override one field while other fields stay on profile defaults', async () => {
  const zipBytes = await buildHighRatioZip();

  const relaxedReader = await openArchive(zipBytes, {
    format: 'zip',
    profile: 'agent',
    limits: { maxCompressionRatio: 1_000_000 }
  });
  const relaxedAudit = await relaxedReader.audit();
  assert.equal(findIssue(relaxedAudit.issues, 'ZIP_LIMIT_EXCEEDED'), undefined);

  await assert.rejects(
    () =>
      openArchive(zipBytes, {
        format: 'zip',
        profile: 'agent',
        limits: { maxEntries: 10_000 }
      }),
    (err: unknown) => err instanceof ZipError && err.code === 'ZIP_LIMIT_EXCEEDED'
  );
});

test('ZipReader construction: profile defaults apply, explicit limits override only specified fields', async () => {
  const zipBytes = await buildHighRatioZip();

  const relaxedReader = await ZipReader.fromUint8Array(zipBytes, {
    profile: 'agent',
    limits: { maxCompressionRatio: 1_000_000 }
  });
  try {
    const relaxedAudit = await relaxedReader.audit();
    assert.equal(findIssue(relaxedAudit.issues, 'ZIP_LIMIT_EXCEEDED'), undefined);
  } finally {
    await relaxedReader.close();
  }

  await assert.rejects(
    () =>
      ZipReader.fromUint8Array(zipBytes, {
        profile: 'agent',
        limits: { maxEntries: 10_000 }
      }),
    (err: unknown) => err instanceof ZipError && err.code === 'ZIP_LIMIT_EXCEEDED'
  );
});

test('TarReader construction: explicit limit override is honored and strictness still follows profile', async () => {
  const tarBytes = await buildTarArchive(['one.txt', 'two.txt']);
  await assert.rejects(
    () => TarReader.fromUint8Array(tarBytes, { profile: 'agent', limits: { maxEntries: 1 } }),
    (err: unknown) => err instanceof ArchiveError && err.code === 'ARCHIVE_LIMIT_EXCEEDED'
  );

  const relaxedEntryLimitReader = await TarReader.fromUint8Array(tarBytes, {
    profile: 'agent',
    limits: { maxEntries: 10 }
  });
  const relaxedEntryLimitAudit = await relaxedEntryLimitReader.audit();
  assert.equal(relaxedEntryLimitAudit.summary.errors, 0);

  const corrupted = corruptTarHeaderChecksum(tarBytes);
  const compatReader = await TarReader.fromUint8Array(corrupted, {
    profile: 'compat',
    limits: { maxEntries: 10 }
  });
  const parseWarning = compatReader.warnings().find((issue) => issue.code === 'TAR_BAD_HEADER');
  assert.ok(parseWarning, 'expected TAR_BAD_HEADER parse warning in compat profile');
  assert.equal(parseWarning.severity, 'warning');
  const compatAudit = await compatReader.audit();
  assert.equal(compatAudit.summary.errors, 0);

  await assert.rejects(
    () => TarReader.fromUint8Array(corrupted, { profile: 'agent', limits: { maxEntries: 10 } }),
    (err: unknown) => err instanceof ArchiveError && err.code === 'ARCHIVE_BAD_HEADER'
  );
});

test('createDecompressor: explicit options override limits, profile behavior remains independent', async () => {
  const helloXzBytes = new Uint8Array(await readFile(HELLO_XZ));
  const unsupportedCheckBytes = new Uint8Array(await readFile(UNSUPPORTED_CHECK_XZ));

  const decoded = await collect(
    chunkReadable(helloXzBytes, 4).pipeThrough(
      createDecompressor({
        algorithm: 'xz',
        profile: 'agent',
        limits: { maxXzBufferedBytes: 1 },
        maxBufferedInputBytes: 64 * 1024
      })
    )
  );
  assert.equal(new TextDecoder().decode(decoded), 'hello from bytefold\n');

  await assert.rejects(
    () =>
      collect(
        chunkReadable(helloXzBytes, 4).pipeThrough(
          createDecompressor({
            algorithm: 'xz',
            profile: 'agent',
            limits: { maxXzBufferedBytes: 1 }
          })
        )
      ),
    (err: unknown) => err instanceof CompressionError && err.code === 'COMPRESSION_XZ_BUFFER_LIMIT'
  );

  await assert.doesNotReject(async () => {
    await collect(
      chunkReadable(unsupportedCheckBytes, 16).pipeThrough(
        createDecompressor({
          algorithm: 'xz',
          profile: 'compat',
          limits: { maxXzBufferedBytes: 64 * 1024 }
        })
      )
    );
  });

  await assert.rejects(
    () =>
      collect(
        chunkReadable(unsupportedCheckBytes, 16).pipeThrough(
          createDecompressor({
            algorithm: 'xz',
            profile: 'strict',
            limits: { maxXzBufferedBytes: 64 * 1024 }
          })
        )
      ),
    (err: unknown) => err instanceof CompressionError && err.code === 'COMPRESSION_XZ_UNSUPPORTED_CHECK'
  );
});

async function buildHighRatioZip(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('zip', writable);
  await writer.add('ratio.bin', new Uint8Array(512 * 1024));
  await writer.close();
  return concatChunks(chunks);
}

async function buildTarArchive(entryNames: string[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('tar', writable);
  for (const name of entryNames) {
    await writer.add(name, new TextEncoder().encode(name));
  }
  await writer.close();
  return concatChunks(chunks);
}

function corruptTarHeaderChecksum(data: Uint8Array): Uint8Array {
  const corrupted = data.slice();
  corrupted[0] = corrupted[0] === 0 ? 1 : 0;
  return corrupted;
}

function findIssue(
  issues: Array<{ code: string; severity: 'info' | 'warning' | 'error'; details?: Record<string, unknown> }>,
  code: string
): { code: string; severity: 'info' | 'warning' | 'error'; details?: Record<string, unknown> } | undefined {
  return issues.find((issue) => issue.code === code);
}

function chunkReadable(data: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      const end = Math.min(data.length, offset + Math.max(1, Math.floor(chunkSize)));
      controller.enqueue(data.subarray(offset, end));
      offset = end;
    }
  });
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
