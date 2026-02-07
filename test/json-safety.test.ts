import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BYTEFOLD_REPORT_SCHEMA_VERSION, createArchiveWriter, openArchive } from '@ismail-elkorchi/bytefold';
import { getCompressionCapabilities } from '@ismail-elkorchi/bytefold/compress';

const encoder = new TextEncoder();

test('JSON-safe reports stringify without bigint leakage', async () => {
  const zipBytes = await buildArchive('zip', 'zip.txt', 'zip data');
  const zipReader = await openArchive(zipBytes);
  assert.ok(zipReader.detection);
  assertJsonSafe('detection report (zip)', zipReader.detection);
  assertDetectionShape(zipReader.detection);

  const zipAudit = await zipReader.audit();
  assertJsonSafe('zip audit report', zipAudit);
  assertAuditShape(zipAudit);

  assert.ok(zipReader.normalizeToWritable, 'zip normalizeToWritable missing');
  const zipNormReport = await normalize(zipReader);
  assertJsonSafe('zip normalize report', zipNormReport);
  assertNormalizeShape(zipNormReport);

  const tarBytes = await buildArchive('tar', 'tar.txt', 'tar data');
  const tarReader = await openArchive(tarBytes);
  assert.ok(tarReader.detection);
  assertJsonSafe('detection report (tar)', tarReader.detection);
  assertDetectionShape(tarReader.detection);

  const tarAudit = await tarReader.audit();
  assertJsonSafe('tar audit report', tarAudit);
  assertAuditShape(tarAudit);

  assert.ok(tarReader.normalizeToWritable, 'tar normalizeToWritable missing');
  const tarNormReport = await normalize(tarReader);
  assertJsonSafe('tar normalize report', tarNormReport);
  assertNormalizeShape(tarNormReport);

  const caps = getCompressionCapabilities();
  assertJsonSafe('compression capabilities report', caps);
  assertCapabilitiesShape(caps);
});

async function buildArchive(format: 'zip' | 'tar', name: string, contents: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter(format, writable);
  await writer.add(name, encoder.encode(contents));
  await writer.close();
  return concatChunks(chunks);
}

async function normalize(reader: {
  normalizeToWritable?: (writable: WritableStream<Uint8Array>, options?: { isDeterministic?: boolean }) => Promise<unknown>;
}): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const normalizeToWritable = reader.normalizeToWritable?.bind(reader);
  if (!normalizeToWritable) throw new Error('normalizeToWritable missing');
  return normalizeToWritable(writable, { isDeterministic: true });
}

function assertJsonSafe(label: string, value: unknown): void {
  assert.equal(containsBigInt(value), false, `${label} contains bigint values before stringify`);
  let json = '';
  assert.doesNotThrow(() => {
    json = JSON.stringify(value);
  }, `${label} failed to stringify`);
  const parsed = JSON.parse(json) as unknown;
  assert.equal(containsBigInt(parsed), false, `${label} contains bigint values after stringify`);
}

function assertSchemaVersion(label: string, value: unknown): void {
  const obj = value as { schemaVersion?: string } | null | undefined;
  assert.ok(obj && typeof obj === 'object', `${label} is not an object`);
  assert.equal(obj.schemaVersion, BYTEFOLD_REPORT_SCHEMA_VERSION, `${label} schemaVersion mismatch`);
}

function assertDetectionShape(value: unknown): void {
  assertSchemaVersion('detection report', value);
  const report = value as {
    inputKind?: string;
    detected?: { layers?: string[]; container?: string; compression?: string };
    confidence?: string;
    notes?: string[];
  };
  assert.ok(report.inputKind, 'detection report missing inputKind');
  assert.ok(report.detected, 'detection report missing detected');
  assert.ok(Array.isArray(report.detected?.layers), 'detection report missing detected.layers');
  assert.ok(report.confidence, 'detection report missing confidence');
  assert.ok(Array.isArray(report.notes), 'detection report missing notes');
}

function assertAuditShape(value: unknown): void {
  assertSchemaVersion('audit report', value);
  const report = value as {
    ok?: boolean;
    summary?: { entries?: number; warnings?: number; errors?: number };
    issues?: unknown[];
  };
  assert.equal(typeof report.ok, 'boolean', 'audit report missing ok');
  assert.equal(typeof report.summary?.entries, 'number', 'audit report missing summary.entries');
  assert.equal(typeof report.summary?.warnings, 'number', 'audit report missing summary.warnings');
  assert.equal(typeof report.summary?.errors, 'number', 'audit report missing summary.errors');
  assert.ok(Array.isArray(report.issues), 'audit report missing issues');
}

function assertNormalizeShape(value: unknown): void {
  assertSchemaVersion('normalize report', value);
  const report = value as {
    ok?: boolean;
    summary?: {
      entries?: number;
      outputEntries?: number;
      droppedEntries?: number;
      renamedEntries?: number;
      warnings?: number;
      errors?: number;
    };
    issues?: unknown[];
  };
  assert.equal(typeof report.ok, 'boolean', 'normalize report missing ok');
  assert.equal(typeof report.summary?.entries, 'number', 'normalize report missing summary.entries');
  assert.equal(typeof report.summary?.outputEntries, 'number', 'normalize report missing summary.outputEntries');
  assert.equal(typeof report.summary?.droppedEntries, 'number', 'normalize report missing summary.droppedEntries');
  assert.equal(typeof report.summary?.renamedEntries, 'number', 'normalize report missing summary.renamedEntries');
  assert.equal(typeof report.summary?.warnings, 'number', 'normalize report missing summary.warnings');
  assert.equal(typeof report.summary?.errors, 'number', 'normalize report missing summary.errors');
  assert.ok(Array.isArray(report.issues), 'normalize report missing issues');
}

function assertCapabilitiesShape(value: unknown): void {
  assertSchemaVersion('capabilities report', value);
  const report = value as {
    runtime?: string;
    algorithms?: Record<string, { compress?: boolean; decompress?: boolean; backend?: string }>;
    notes?: string[];
  };
  assert.ok(report.runtime, 'capabilities report missing runtime');
  assert.ok(report.algorithms && typeof report.algorithms === 'object', 'capabilities report missing algorithms');
  assert.ok(Array.isArray(report.notes), 'capabilities report missing notes');
}

function containsBigInt(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'bigint') return true;
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsBigInt(item, seen));
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (containsBigInt(item, seen)) return true;
  }
  return false;
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
