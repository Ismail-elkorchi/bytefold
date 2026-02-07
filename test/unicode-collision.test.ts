import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArchiveError, openArchive } from '@ismail-elkorchi/bytefold';
import { ZipError } from '@ismail-elkorchi/bytefold/zip';
import { ZipReader } from '@ismail-elkorchi/bytefold/node/zip';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const FIXTURE_ROOT = new URL('../test/fixtures/ambiguous/', import.meta.url);
const NFC = 'caf\u00e9.txt';
const NFD = 'cafe\u0301.txt';

const nfcName = NFC.normalize('NFC');
const key = nfcName;

const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);
const AUDIT_SCHEMA = new URL('../schemas/audit-report.schema.json', import.meta.url);

const TAR_FIXTURE = new URL('tar-unicode-collision.tar', FIXTURE_ROOT);
const ZIP_FIXTURE = new URL('zip-unicode-collision.zip', FIXTURE_ROOT);

test('unicode normalization collisions are deterministic (tar + zip)', async () => {
  const auditSchema = (JSON.parse(await readFile(AUDIT_SCHEMA, 'utf8')) as unknown) as JsonSchema;
  const errorSchema = (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;

  const tarBytes = new Uint8Array(await readFile(TAR_FIXTURE));
  const tarReader = await openArchive(tarBytes, { filename: 'tar-unicode-collision.tar' });
  const tarAudit = await tarReader.audit({ profile: 'agent' });
  const tarAuditResult = validateSchema(auditSchema, JSON.parse(JSON.stringify(tarAudit)));
  assert.ok(tarAuditResult.ok, tarAuditResult.errors.join('\n'));
  assert.ok(tarAudit.issues.some((issue) => issue.code === 'TAR_UNICODE_COLLISION' && issue.severity === 'error'));

  await assert.rejects(
    async () => {
      const chunks: Uint8Array[] = [];
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        }
      });
      if (!tarReader.normalizeToWritable) throw new Error('normalizeToWritable missing');
      await tarReader.normalizeToWritable(writable, { isDeterministic: true });
    },
    (err: unknown) => {
      if (!(err instanceof ArchiveError)) return false;
      assert.equal(err.code, 'ARCHIVE_NAME_COLLISION');
      const json = err.toJSON() as { context?: Record<string, string> };
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      assert.equal(json.context?.collisionType, 'unicode_nfc');
      assert.equal(json.context?.collisionKind, 'unicode_nfc');
      assert.equal(json.context?.nameA, NFC);
      assert.equal(json.context?.nameB, NFD);
      assert.equal(json.context?.key, key);
      assert.equal(json.context?.format, 'tar');
      return true;
    }
  );

  const zipBytes = new Uint8Array(await readFile(ZIP_FIXTURE));
  const zipReader = await openArchive(zipBytes, { filename: 'zip-unicode-collision.zip' });
  const zipAudit = await zipReader.audit({ profile: 'agent' });
  const zipAuditResult = validateSchema(auditSchema, JSON.parse(JSON.stringify(zipAudit)));
  assert.ok(zipAuditResult.ok, zipAuditResult.errors.join('\n'));
  assert.ok(zipAudit.issues.some((issue) => issue.code === 'ZIP_UNICODE_COLLISION' && issue.severity === 'error'));

  await assert.rejects(
    async () => {
      const chunks: Uint8Array[] = [];
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        }
      });
      if (!zipReader.normalizeToWritable) throw new Error('normalizeToWritable missing');
      await zipReader.normalizeToWritable(writable, { isDeterministic: true });
    },
    (err: unknown) => {
      if (!(err instanceof ZipError)) return false;
      assert.equal(err.code, 'ZIP_NAME_COLLISION');
      const json = err.toJSON() as { context?: Record<string, string> };
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      assert.equal(json.context?.collisionType, 'unicode_nfc');
      assert.equal(json.context?.collisionKind, 'unicode_nfc');
      assert.equal(json.context?.nameA, NFC);
      assert.equal(json.context?.nameB, NFD);
      assert.equal(json.context?.key, key);
      assert.equal(json.context?.format, 'zip');
      return true;
    }
  );
});

test('zip extractAll fails on unicode name collisions', async () => {
  const errorSchema = (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;
  const zipBytes = new Uint8Array(await readFile(ZIP_FIXTURE));
  const reader = await ZipReader.fromUint8Array(zipBytes);
  const targetDir = await makeTempDir();

  await assert.rejects(
    async () => {
      await reader.extractAll(targetDir);
    },
    (err: unknown) => {
      if (!(err instanceof ZipError)) return false;
      assert.equal(err.code, 'ZIP_NAME_COLLISION');
      const json = err.toJSON() as { context?: Record<string, string> };
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      assert.equal(json.context?.collisionType, 'unicode_nfc');
      assert.equal(json.context?.collisionKind, 'unicode_nfc');
      assert.equal(json.context?.nameA, NFC);
      assert.equal(json.context?.nameB, NFD);
      assert.equal(json.context?.key, key);
      assert.equal(json.context?.format, 'zip');
      return true;
    }
  );
});

async function makeTempDir(): Promise<string> {
  const base = path.join(tmpdir(), 'bytefold-unicode-');
  const name = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dir = path.join(base + name);
  await mkdir(dir, { recursive: true });
  return dir;
}
