import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SPEC = new URL('../SPEC.md', import.meta.url);
const ARCHIVE_TYPES = new URL('../src/archive/types.ts', import.meta.url);

const REQUIRED_OPERATIONS = ['detect', 'list', 'audit', 'extract', 'normalize', 'write'];
const REQUIRED_RUNTIMES = ['node', 'deno', 'bun'];

test('support matrix block matches ArchiveFormat union', async () => {
  const specText = await readFile(SPEC, 'utf8');
  const matrix = extractSupportMatrix(specText);
  assert.ok(Array.isArray(matrix.formats), 'support matrix formats missing');
  assert.ok(Array.isArray(matrix.operations), 'support matrix operations missing');
  assert.ok(Array.isArray(matrix.runtimes), 'support matrix runtimes missing');

  const typesText = await readFile(ARCHIVE_TYPES, 'utf8');
  const archiveFormats = new Set(extractArchiveFormats(typesText));
  const matrixFormats = new Set(matrix.formats as string[]);

  assert.deepEqual(new Set(matrix.operations), new Set(REQUIRED_OPERATIONS));
  assert.deepEqual(new Set(matrix.runtimes), new Set(REQUIRED_RUNTIMES));
  assert.deepEqual(matrixFormats, archiveFormats);
});

function extractSupportMatrix(text: string): Record<string, unknown> {
  const match = text.match(/```json support-matrix\s*\n([\s\S]*?)```/);
  if (!match) throw new Error('Support matrix JSON block not found in SPEC.md');
  return JSON.parse(match[1] ?? '{}') as Record<string, unknown>;
}

function extractArchiveFormats(text: string): string[] {
  const match = text.match(/export type ArchiveFormat =([\s\S]*?);/);
  if (!match) throw new Error('ArchiveFormat union not found');
  const section = match[1] ?? '';
  const values = [...section.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (values.length === 0) throw new Error('ArchiveFormat union appears empty');
  return values;
}
