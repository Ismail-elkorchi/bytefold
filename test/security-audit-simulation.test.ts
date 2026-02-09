import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveError, createArchiveWriter } from '@ismail-elkorchi/bytefold';
import { ZipError } from '@ismail-elkorchi/bytefold/zip';
import { openArchive as openArchiveWeb } from '@ismail-elkorchi/bytefold/web';
import { openArchive as openArchiveNode } from '@ismail-elkorchi/bytefold/node';

const ENCODER = new TextEncoder();

type ArchiveFormat = 'tar' | 'zip';

test('security simulation: zip traversal corpus yields traversal audit failures', async () => {
  const corpus = generateTraversalCorpus(0xc0ffee01, 12);
  for (const entryName of corpus) {
    await assertTraversalIssue('zip', entryName);
  }
});

test('security simulation: tar traversal corpus yields traversal audit failures', async () => {
  const corpus = generateTraversalCorpus(0x5eedbeef, 12);
  for (const entryName of corpus) {
    await assertTraversalIssue('tar', entryName);
  }
});

test('security simulation: web adapter URL input rejects non-http schemes', async () => {
  const urls = [
    'file:///tmp/archive.zip',
    'ftp://example.com/archive.zip',
    'data:application/octet-stream;base64,UEsDBA=='
  ];

  for (const input of urls) {
    await assert.rejects(
      async () => {
        await openArchiveWeb(input);
      },
      (error: unknown) => error instanceof ArchiveError && error.code === 'ARCHIVE_UNSUPPORTED_FEATURE'
    );
  }
});

async function assertTraversalIssue(format: ArchiveFormat, entryName: string): Promise<void> {
  const bytes = await writeArchiveWithSingleEntry(format, entryName);
  const reader = await openArchiveNode(bytes);
  const report = await reader.audit({ profile: 'agent' });
  const expectedIssueCode = format === 'zip' ? 'ZIP_PATH_TRAVERSAL' : 'TAR_PATH_TRAVERSAL';

  assert.equal(report.ok, false, `expected traversal audit failure for ${format}:${entryName}`);
  assert.ok(
    report.issues.some((issue) => issue.code === expectedIssueCode),
    `missing ${expectedIssueCode} for ${format}:${entryName}`
  );

  await assert.rejects(
    async () => {
      await reader.assertSafe({ profile: 'agent' });
    },
    (error: unknown) => {
      if (format === 'zip') {
        return error instanceof ZipError && error.code === 'ZIP_AUDIT_FAILED';
      }
      return error instanceof ArchiveError && error.code === 'ARCHIVE_AUDIT_FAILED';
    }
  );
}

async function writeArchiveWithSingleEntry(format: ArchiveFormat, entryName: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      // Copy each chunk to prevent test-side aliasing.
      chunks.push(new Uint8Array(chunk));
    }
  });

  const writer = createArchiveWriter(format, writable);
  await writer.add(entryName, ENCODER.encode('attack-sim'));
  await writer.close();
  return concatChunks(chunks);
}

function generateTraversalCorpus(seed: number, count: number): string[] {
  const leaves = ['payload.txt', 'escape.bin', 'probe.log', 'vector.md'];
  const patterns: Array<(leaf: string) => string> = [
    (leaf) => `../${leaf}`,
    (leaf) => `..\\${leaf}`,
    (leaf) => `/${leaf}`,
    (leaf) => `C:\\${leaf}`,
    (leaf) => `C:/${leaf}`,
    (leaf) => `nested/../../${leaf}`,
    (leaf) => `nested\\..\\..\\${leaf}`,
    (leaf) => `./../${leaf}`
  ];

  const next = createXorShift32(seed);
  const corpus: string[] = [];
  const seen = new Set<string>();

  while (corpus.length < count) {
    const pattern = patterns[next() % patterns.length]!;
    const leaf = leaves[next() % leaves.length]!;
    const candidate = pattern(`${leaf}-${next().toString(16).slice(0, 6)}`);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    corpus.push(candidate);
  }

  return corpus;
}

function createXorShift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state >>>= 0;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
