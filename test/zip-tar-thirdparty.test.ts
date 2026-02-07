import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const FIXTURE_ROOT = new URL('../test/fixtures/', import.meta.url);
const AUDIT_SCHEMA = new URL('../schemas/audit-report.schema.json', import.meta.url);

const ZIP_FIXTURES = [
  'thirdparty/zip/zip_cp437_header.zip',
  'thirdparty/zip/zipdir_backslash.zip',
  'thirdparty/zip/zip64.zip'
];

const TAR_FIXTURES = [
  'thirdparty/tar/pax.tar',
  'thirdparty/tar/pax-records.tar'
];

test('third-party ZIP fixtures open, list, and audit cleanly', async () => {
  const auditSchema = await loadSchema(AUDIT_SCHEMA);
  for (const fixture of ZIP_FIXTURES) {
    const bytes = new Uint8Array(await readFile(new URL(fixture, FIXTURE_ROOT)));
    const reader = await openArchive(bytes, { format: 'zip', filename: fixture });
    assert.equal(reader.format, 'zip');
    const names: string[] = [];
    for await (const entry of reader.entries()) {
      names.push(entry.name);
    }
    assert.ok(names.length > 0, `missing entries for ${fixture}`);
    const report = await reader.audit();
    const result = validateSchema(auditSchema, toJson(report));
    assert.ok(result.ok, result.errors.join('\n'));
  }
});

test('third-party TAR fixtures open, list, and audit cleanly', async () => {
  const auditSchema = await loadSchema(AUDIT_SCHEMA);
  const longPaxName = `a/${Array.from({ length: 100 }, (_, i) => String(i + 1)).join('')}`;
  for (const fixture of TAR_FIXTURES) {
    const bytes = new Uint8Array(await readFile(new URL(fixture, FIXTURE_ROOT)));
    const reader = await openArchive(bytes, { format: 'tar', filename: fixture });
    assert.equal(reader.format, 'tar');
    const names: string[] = [];
    for await (const entry of reader.entries()) {
      names.push(entry.name);
    }
    assert.ok(names.length > 0, `missing entries for ${fixture}`);
    if (fixture.endsWith('pax.tar')) {
      assert.ok(names.includes(longPaxName), 'pax long path entry missing');
    }
    if (fixture.endsWith('pax-records.tar')) {
      assert.ok(names.includes('file'), 'pax records entry missing');
    }
    const report = await reader.audit();
    const result = validateSchema(auditSchema, toJson(report));
    assert.ok(result.ok, result.errors.join('\n'));
  }
});

async function loadSchema(url: URL): Promise<JsonSchema> {
  return (JSON.parse(await readFile(url, 'utf8')) as unknown) as JsonSchema;
}

function toJson(value: unknown): unknown {
  if (value && typeof value === 'object' && 'toJSON' in value) {
    const record = value as { toJSON?: () => unknown };
    if (record.toJSON) return record.toJSON();
  }
  return JSON.parse(JSON.stringify(value));
}
