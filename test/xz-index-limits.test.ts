import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const FIXTURE_ROOT = new URL('../test/fixtures/', import.meta.url);

test('xz index record limit triggers audit issue', async () => {
  const auditSchema = (await loadSchema('audit-report.schema.json')) as JsonSchema;
  const bytes = new Uint8Array(await readFile(new URL('concat-two.xz', FIXTURE_ROOT)));
  const reader = await openArchive(bytes, { filename: 'concat-two.xz' });
  const report = await reader.audit({ limits: { maxXzIndexRecords: 1 } });
  const result = validateSchema(auditSchema, toJson(report));
  assert.ok(result.ok, result.errors.join('\n'));
  assert.equal(report.ok, false);
  const issue = report.issues.find((entry) => entry.code === 'COMPRESSION_RESOURCE_LIMIT');
  assert.ok(issue, 'missing index record limit issue');
  const details = issue?.details as Record<string, string> | undefined;
  assert.equal(details?.algorithm, 'xz');
  assert.ok(details?.requiredIndexRecords);
  assert.ok(details?.limitIndexRecords);
});

test('xz index byte limit triggers audit issue', async () => {
  const auditSchema = (await loadSchema('audit-report.schema.json')) as JsonSchema;
  const bytes = new Uint8Array(await readFile(new URL('concat-two.xz', FIXTURE_ROOT)));
  const reader = await openArchive(bytes, { filename: 'concat-two.xz' });
  const report = await reader.audit({ limits: { maxXzIndexBytes: 1 } });
  const result = validateSchema(auditSchema, toJson(report));
  assert.ok(result.ok, result.errors.join('\n'));
  assert.equal(report.ok, false);
  const issue = report.issues.find((entry) => entry.code === 'COMPRESSION_RESOURCE_LIMIT');
  assert.ok(issue, 'missing index byte limit issue');
  const details = issue?.details as Record<string, string> | undefined;
  assert.equal(details?.algorithm, 'xz');
  assert.ok(details?.requiredIndexBytes);
  assert.ok(details?.limitIndexBytes);
});

async function loadSchema(name: string): Promise<unknown> {
  const url = new URL(`../schemas/${name}`, import.meta.url);
  const text = await readFile(url, 'utf8');
  return JSON.parse(text) as unknown;
}

function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
