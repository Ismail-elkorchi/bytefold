import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runtimeSupport, supportMatrix } from '@ismail-elkorchi/bytefold/support';

const SPEC = new URL('../SPEC.md', import.meta.url);
const ARCHIVE_TYPES = new URL('../src/archive/types.ts', import.meta.url);

const REQUIRED_OPERATIONS = ['detect', 'list', 'audit', 'extract', 'normalize', 'write'];
const REQUIRED_RUNTIMES = ['node', 'deno', 'bun', 'web'];

type RuntimeOperationState = 'supported' | 'unsupported' | 'hint-required' | 'capability-gated';
type MatrixOperation = (typeof supportMatrix.operations)[number];

test('support matrix export matches SPEC block and ArchiveFormat union', async () => {
  const specText = await readFile(SPEC, 'utf8');
  const matrix = extractSupportMatrix(specText);
  assert.deepEqual(supportMatrix, matrix);

  const typesText = await readFile(ARCHIVE_TYPES, 'utf8');
  const archiveFormats = new Set(extractArchiveFormats(typesText));
  const matrixFormats = new Set(supportMatrix.formats);

  assert.deepEqual(new Set(supportMatrix.operations), new Set(REQUIRED_OPERATIONS));
  assert.deepEqual(new Set(supportMatrix.runtimes), new Set(REQUIRED_RUNTIMES));
  assert.deepEqual(matrixFormats, archiveFormats);
});

test('runtimeSupport(node) matches SPEC Node matrix table', async () => {
  const specText = await readFile(SPEC, 'utf8');
  const rows = extractRuntimeRows(specText, '### Node (>=24)');
  const nodeSupport = runtimeSupport('node');

  for (const row of rows) {
    for (const format of row.formats) {
      for (const operation of supportMatrix.operations) {
        const expected = row.operations[operation];
        const actual = nodeSupport[format][operation].state;
        assert.equal(
          actual,
          expected,
          `Node support mismatch for format=${format} operation=${operation}`
        );
      }
    }
  }
});

function extractSupportMatrix(text: string): typeof supportMatrix {
  const match = text.match(/```json support-matrix\s*\n([\s\S]*?)```/);
  if (!match) throw new Error('Support matrix JSON block not found in SPEC.md');
  return JSON.parse(match[1] ?? '{}') as typeof supportMatrix;
}

function extractArchiveFormats(text: string): string[] {
  const match = text.match(/export type ArchiveFormat =([\s\S]*?);/);
  if (!match) throw new Error('ArchiveFormat union not found');
  const section = match[1] ?? '';
  const values = [...section.matchAll(/'([^']+)'/g)].map((found) => found[1]!);
  if (values.length === 0) throw new Error('ArchiveFormat union appears empty');
  return values;
}

function extractRuntimeRows(specText: string, heading: string): Array<{
  formats: Array<(typeof supportMatrix.formats)[number]>;
  operations: Record<MatrixOperation, RuntimeOperationState>;
}> {
  const start = specText.indexOf(heading);
  if (start === -1) {
    throw new Error(`Runtime heading "${heading}" not found in SPEC.md`);
  }
  const nextHeading = specText.indexOf('\n### ', start + heading.length);
  const section = nextHeading === -1 ? specText.slice(start) : specText.slice(start, nextHeading);
  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));

  const dataLines = lines.slice(2).filter((line) => line !== '| --- | --- | --- | --- | --- | --- | --- |');
  if (dataLines.length === 0) {
    throw new Error(`No table rows found for runtime heading "${heading}"`);
  }

  return dataLines.map((line) => parseRuntimeRow(line));
}

function parseRuntimeRow(line: string): {
  formats: Array<(typeof supportMatrix.formats)[number]>;
  operations: Record<MatrixOperation, RuntimeOperationState>;
} {
  const columns = line
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
  if (columns.length !== 7) {
    throw new Error(`Unexpected support row shape: ${line}`);
  }
  const [formatLabel, detect, list, audit, extract, normalize, write] = columns;
  if (
    formatLabel === undefined
    || detect === undefined
    || list === undefined
    || audit === undefined
    || extract === undefined
    || normalize === undefined
    || write === undefined
  ) {
    throw new Error(`Incomplete support row: ${line}`);
  }
  const formats = parseFormatLabel(formatLabel);

  return {
    formats,
    operations: {
      detect: parseState(detect),
      list: parseState(list),
      audit: parseState(audit),
      extract: parseState(extract),
      normalize: parseState(normalize),
      write: parseState(write)
    }
  };
}

function parseFormatLabel(label: string): Array<(typeof supportMatrix.formats)[number]> {
  const normalized = label
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part === 'tgz') return 'tgz';
      if (part === 'tar.gz') return 'tar.gz';
      return part;
    });

  if (normalized.length === 0) {
    throw new Error(`Invalid format label "${label}"`);
  }

  return normalized.map((entry) => {
    if (!supportMatrix.formats.includes(entry as (typeof supportMatrix.formats)[number])) {
      throw new Error(`Unknown format "${entry}" in support matrix table`);
    }
    return entry as (typeof supportMatrix.formats)[number];
  });
}

function parseState(cell: string): RuntimeOperationState {
  if (cell.startsWith('✅')) return 'supported';
  if (cell.startsWith('❌')) return 'unsupported';
  if (cell.startsWith('⚠️') || cell.startsWith('⚠')) return 'hint-required';
  if (cell.startsWith('🟦')) return 'capability-gated';
  throw new Error(`Unknown support state token in cell "${cell}"`);
}
