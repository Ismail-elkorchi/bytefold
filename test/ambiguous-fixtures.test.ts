import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArchiveError, ZipError, openArchive } from '@ismail-elkorchi/bytefold';
import { validateSchema, type JsonSchema } from './schema-validator.js';

type IssueSummary = { code: string; severity: string; entryName?: string };

const FIXTURE_ROOT = new URL('../test/fixtures/ambiguous/', import.meta.url);
const LONG_NAME = `pax/${'a'.repeat(110)}.txt`;

const NORMALIZE_EXPECTATIONS: Record<
  string,
  | { output: string; expectedNames: string[] }
  | { errorCode: string; errorType: 'archive' | 'zip'; entryName: string }
> = {
  'tar-pax-longname.tar': {
    output: 'tar-pax-longname.norm.tar',
    expectedNames: [LONG_NAME, 'a/b/c.txt', 'conflict', 'conflict/', 'ok.txt']
  },
  'zip-paths.zip': {
    output: 'zip-paths.norm.zip',
    expectedNames: ['a/b.txt', 'a/c.txt', 'dir', 'dir/']
  },
  'tar-duplicates.tar': { errorCode: 'ARCHIVE_NAME_COLLISION', errorType: 'archive', entryName: 'dup.txt' },
  'tar-case-collision.tar': { errorCode: 'ARCHIVE_NAME_COLLISION', errorType: 'archive', entryName: 'README.TXT' },
  'tar-links.tar': { errorCode: 'ARCHIVE_UNSUPPORTED_FEATURE', errorType: 'archive', entryName: 'hardlink' },
  'tar-unicode-collision.tar': {
    errorCode: 'ARCHIVE_NAME_COLLISION',
    errorType: 'archive',
    entryName: 'cafe\u0301.txt'
  },
  'tar-path-traversal.tar': {
    errorCode: 'ARCHIVE_PATH_TRAVERSAL',
    errorType: 'archive',
    entryName: '../evil.txt'
  },
  'zip-duplicates.zip': { errorCode: 'ZIP_NAME_COLLISION', errorType: 'zip', entryName: 'dup.txt' },
  'zip-case-collision.zip': { errorCode: 'ZIP_NAME_COLLISION', errorType: 'zip', entryName: 'README.TXT' },
  'zip-unicode-collision.zip': {
    errorCode: 'ZIP_NAME_COLLISION',
    errorType: 'zip',
    entryName: 'cafe\u0301.txt'
  },
  'zip-casefold-fuss.zip': {
    errorCode: 'ZIP_NAME_COLLISION',
    errorType: 'zip',
    entryName: 'Fu\u00df.txt'
  },
  'zip-casefold-sigma.zip': {
    errorCode: 'ZIP_NAME_COLLISION',
    errorType: 'zip',
    entryName: '\u03bf\u03c2.txt'
  },
  'zip-path-traversal.zip': {
    errorCode: 'ZIP_PATH_TRAVERSAL',
    errorType: 'zip',
    entryName: '../evil.txt'
  }
};

test('ambiguous fixtures: audit + normalize determinism', async () => {
  const expectedIssues = (JSON.parse(
    await readFile(new URL('./expected-issues.json', FIXTURE_ROOT), 'utf8')
  ) as unknown) as Record<string, IssueSummary[]>;
  const auditSchema = (JSON.parse(
    await readFile(new URL('../schemas/audit-report.schema.json', import.meta.url), 'utf8')
  ) as unknown) as JsonSchema;
  const errorSchema = (JSON.parse(
    await readFile(new URL('../schemas/error.schema.json', import.meta.url), 'utf8')
  ) as unknown) as JsonSchema;

  for (const fixtureName of Object.keys(expectedIssues)) {
    const bytes = await readFixture(fixtureName);
    const reader = await openArchive(bytes, { filename: fixtureName });
    const audit = await reader.audit({ profile: 'agent' });
    const auditResult = validateSchema(auditSchema, JSON.parse(JSON.stringify(audit)));
    assert.ok(auditResult.ok, auditResult.errors.join('\n'));

    const actualIssues = sortIssues(summarizeIssues(audit.issues));
    const expected = sortIssues(expectedIssues[fixtureName] ?? []);
    assert.deepEqual(actualIssues, expected, `audit issues mismatch for ${fixtureName}`);

    const expectation = NORMALIZE_EXPECTATIONS[fixtureName];
    if (!expectation) continue;

    if ('output' in expectation) {
      const normalized = await normalizeBytes(bytes);
      const expectedBytes = await readFixture(expectation.output);
      assert.deepEqual(normalized, expectedBytes, `normalized bytes mismatch for ${fixtureName}`);
      const normalizedReader = await openArchive(normalized, { filename: expectation.output });
      const names = await collectNames(normalizedReader);
      assert.deepEqual(names.sort(), expectation.expectedNames.slice().sort());
    } else {
      let error: unknown;
      try {
        await normalizeBytes(bytes);
      } catch (err) {
        error = err;
      }
      assert.ok(error, `expected error for ${fixtureName}`);
      if (expectation.errorType === 'archive') {
        assert.ok(error instanceof ArchiveError);
      } else {
        assert.ok(error instanceof ZipError);
      }
      const err = error as ArchiveError | ZipError;
      assert.equal(err.code, expectation.errorCode);
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      assert.equal(json.context.entryName, expectation.entryName);
    }
  }
});

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, FIXTURE_ROOT)));
}

async function normalizeBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = await openArchive(bytes);
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const normalizeToWritable = reader.normalizeToWritable?.bind(reader);
  if (!normalizeToWritable) throw new Error('normalizeToWritable missing');
  await normalizeToWritable(writable, { isDeterministic: true });
  return concatChunks(chunks);
}

async function collectNames(reader: {
  entries: () => AsyncGenerator<{ name: string }>;
}): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of reader.entries()) {
    names.push(entry.name);
  }
  return names;
}

function summarizeIssues(issues: Array<{ code: string; severity: string; entryName?: string }>): IssueSummary[] {
  return issues.map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    ...(issue.entryName ? { entryName: issue.entryName } : {})
  }));
}

function sortIssues(issues: IssueSummary[]): IssueSummary[] {
  return [...issues].sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const aName = a.entryName ?? '';
    const bName = b.entryName ?? '';
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  });
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
