import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArchiveError, createArchiveWriter, openArchive } from '@ismail-elkorchi/bytefold';
import { CompressionError, getCompressionCapabilities } from '@ismail-elkorchi/bytefold/compress';
import { ZipError } from '@ismail-elkorchi/bytefold/zip';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const encoder = new TextEncoder();

test('audit and normalize reports match JSON schemas', async () => {
  const auditSchema = (await loadSchema('audit-report.schema.json')) as JsonSchema;
  const detectionSchema = (await loadSchema('detection-report.schema.json')) as JsonSchema;
  const normalizeSchema = (await loadSchema('normalize-report.schema.json')) as JsonSchema;
  const capabilitiesSchema = (await loadSchema('capabilities-report.schema.json')) as JsonSchema;

  const zipBytes = await buildArchive('zip', 'file.txt', 'content');
  const zipReader = await openArchive(zipBytes);
  assert.ok(zipReader.detection);
  const detection = toJson(zipReader.detection);
  const detectionResult = validateSchema(detectionSchema, detection);
  assert.ok(detectionResult.ok, detectionResult.errors.join('\n'));

  const blobReader = await openArchive(new Blob([blobPartFromBytes(zipBytes)], { type: 'application/zip' }));
  const blobDetection = toJson(blobReader.detection);
  const blobDetectionResult = validateSchema(detectionSchema, blobDetection);
  assert.ok(blobDetectionResult.ok, blobDetectionResult.errors.join('\n'));

  const audit = toJson(await zipReader.audit());
  const auditResult = validateSchema(auditSchema, audit);
  assert.ok(auditResult.ok, auditResult.errors.join('\n'));

  assert.ok(zipReader.normalizeToWritable, 'normalizeToWritable missing');
  const normalize = toJson(await normalizeArchive(zipReader));
  const normalizeResult = validateSchema(normalizeSchema, normalize);
  assert.ok(normalizeResult.ok, normalizeResult.errors.join('\n'));

  const caps = toJson(getCompressionCapabilities());
  const capsResult = validateSchema(capabilitiesSchema, caps);
  assert.ok(capsResult.ok, capsResult.errors.join('\n'));
});

test('error JSON matches error schema', async () => {
  const errorSchema = (await loadSchema('error.schema.json')) as JsonSchema;
  const errors = [
    new ZipError('ZIP_BAD_CRC', 'CRC mismatch', { entryName: 'file.txt', method: 8, offset: 42n }),
    new ArchiveError('ARCHIVE_BAD_HEADER', 'Bad header', { entryName: 'file.txt', offset: 12n }),
    new CompressionError('COMPRESSION_XZ_BAD_DATA', 'XZ data error', { algorithm: 'xz' })
  ];

  for (const err of errors) {
    const json = toJson(err);
    const result = validateSchema(errorSchema, json);
    assert.ok(result.ok, result.errors.join('\n'));
  }
});

async function loadSchema(name: string): Promise<unknown> {
  const url = new URL(`../schemas/${name}`, import.meta.url);
  const text = await readFile(url, 'utf8');
  return JSON.parse(text) as unknown;
}

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

async function normalizeArchive(reader: {
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

function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
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

function blobPartFromBytes(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return owned.buffer;
}
