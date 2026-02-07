import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openArchive } from '@ismail-elkorchi/bytefold';
import { ZipError } from '@ismail-elkorchi/bytefold/zip';
import { ZipReader } from '@ismail-elkorchi/bytefold/node/zip';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const FIXTURE_ROOT = new URL('../test/fixtures/ambiguous/', import.meta.url);
const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);
const AUDIT_SCHEMA = new URL('../schemas/audit-report.schema.json', import.meta.url);

const FUSS_FIXTURE = new URL('zip-casefold-fuss.zip', FIXTURE_ROOT);
const SIGMA_FIXTURE = new URL('zip-casefold-sigma.zip', FIXTURE_ROOT);
const TURKIC_FIXTURE = new URL('zip-casefold-turkic.zip', FIXTURE_ROOT);

const FUSS_A = 'FUSS.txt';
const FUSS_B = 'Fu\u00df.txt';
const FUSS_KEY = 'fuss.txt';

const SIGMA_A = '\u039f\u03a3.txt';
const SIGMA_B = '\u03bf\u03c2.txt';
const SIGMA_KEY = '\u03bf\u03c3.txt';

const TURKIC_A = 'I.txt';
const TURKIC_B = '\u0131.txt';

const CASEFOLD_CASES = [
  { fixture: FUSS_FIXTURE, nameA: FUSS_A, nameB: FUSS_B, key: FUSS_KEY },
  { fixture: SIGMA_FIXTURE, nameA: SIGMA_A, nameB: SIGMA_B, key: SIGMA_KEY }
];

test('casefold collisions are detected in audit + normalize + extractAll', async () => {
  const auditSchema = (JSON.parse(await readFile(AUDIT_SCHEMA, 'utf8')) as unknown) as JsonSchema;
  const errorSchema = (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;

  for (const { fixture, nameA, nameB, key } of CASEFOLD_CASES) {
    const bytes = new Uint8Array(await readFile(fixture));
    const reader = await openArchive(bytes, { filename: 'casefold.zip' });
    const audit = await reader.audit({ profile: 'agent' });
    const auditResult = validateSchema(auditSchema, JSON.parse(JSON.stringify(audit)));
    assert.ok(auditResult.ok, auditResult.errors.join('\n'));

    const issue = audit.issues.find(
      (candidate) => candidate.code === 'ZIP_CASE_COLLISION' && candidate.entryName === nameB
    );
    assert.ok(issue, 'missing casefold collision issue');
    assert.equal(issue?.details?.collisionKind, 'casefold');
    assert.equal(issue?.details?.otherName, nameA);
    assert.equal(issue?.details?.key, key);

    await assert.rejects(
      async () => {
        const chunks: Uint8Array[] = [];
        const writable = new WritableStream<Uint8Array>({
          write(chunk) {
            chunks.push(chunk);
          }
        });
        if (!reader.normalizeToWritable) throw new Error('normalizeToWritable missing');
        await reader.normalizeToWritable(writable, { deterministic: true });
      },
      (err: unknown) => {
        if (!(err instanceof ZipError)) return false;
        assert.equal(err.code, 'ZIP_NAME_COLLISION');
        const json = err.toJSON() as { context?: Record<string, string> };
        const result = validateSchema(errorSchema, json);
        assert.ok(result.ok, result.errors.join('\n'));
        assert.equal(json.context?.collisionType, 'case');
        assert.equal(json.context?.collisionKind, 'casefold');
        assert.equal(json.context?.nameA, nameA);
        assert.equal(json.context?.nameB, nameB);
        assert.equal(json.context?.key, key);
        assert.equal(json.context?.format, 'zip');
        return true;
      }
    );

    const nodeReader = await ZipReader.fromUint8Array(bytes);
    await assert.rejects(
      async () => {
        await nodeReader.extractAll(await makeTempDir());
      },
      (err: unknown) => {
        if (!(err instanceof ZipError)) return false;
        assert.equal(err.code, 'ZIP_NAME_COLLISION');
        const json = err.toJSON() as { context?: Record<string, string> };
        const result = validateSchema(errorSchema, json);
        assert.ok(result.ok, result.errors.join('\n'));
        assert.equal(json.context?.collisionType, 'case');
        assert.equal(json.context?.collisionKind, 'casefold');
        assert.equal(json.context?.nameA, nameA);
        assert.equal(json.context?.nameB, nameB);
        assert.equal(json.context?.key, key);
        assert.equal(json.context?.format, 'zip');
        return true;
      }
    );
  }
});

test('turkic mappings are excluded from casefold collisions', async () => {
  const auditSchema = (JSON.parse(await readFile(AUDIT_SCHEMA, 'utf8')) as unknown) as JsonSchema;
  const bytes = new Uint8Array(await readFile(TURKIC_FIXTURE));
  const reader = await openArchive(bytes, { filename: 'zip-casefold-turkic.zip' });
  const audit = await reader.audit({ profile: 'agent' });
  const auditResult = validateSchema(auditSchema, JSON.parse(JSON.stringify(audit)));
  assert.ok(auditResult.ok, auditResult.errors.join('\n'));
  assert.ok(!audit.issues.some((issue) => issue.code === 'ZIP_CASE_COLLISION'));

  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  if (!reader.normalizeToWritable) throw new Error('normalizeToWritable missing');
  await reader.normalizeToWritable(writable, { deterministic: true });

  const nodeReader = await ZipReader.fromUint8Array(bytes);
  await nodeReader.extractAll(await makeTempDir());

  const normalizedNames = new Set<string>();
  for (const entry of nodeReader.entries()) {
    normalizedNames.add(entry.name);
  }
  assert.ok(normalizedNames.has(TURKIC_A));
  assert.ok(normalizedNames.has(TURKIC_B));
});

async function makeTempDir(): Promise<string> {
  const base = path.join(tmpdir(), 'bytefold-casefold-');
  const name = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dir = path.join(base + name);
  await mkdir(dir, { recursive: true });
  return dir;
}
