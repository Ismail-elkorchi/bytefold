import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const MANIFEST = new URL('../repo.manifest.yaml', import.meta.url);
const SNAPSHOT = new URL('../test/fixtures/export-surface.json', import.meta.url);

test('public export surface matches snapshot', async () => {
  const manifestText = await readFile(MANIFEST, 'utf8');
  const entrypoints = extractNpmEntrypoints(manifestText);
  const expected = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Record<string, Record<string, string>>;

  const actual: Record<string, Record<string, string>> = {};
  for (const entrypoint of entrypoints) {
    const specifier = toSpecifier(entrypoint);
    const mod = (await import(specifier)) as Record<string, unknown>;
    const keys = Object.keys(mod).sort();
    const shape: Record<string, string> = {};
    for (const key of keys) {
      shape[key] = typeof mod[key];
    }
    actual[specifier] = shape;
  }

  assert.deepEqual(actual, expected);
});

function extractNpmEntrypoints(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const entrypoints: string[] = [];
  let inNpm = false;
  let npmIndent = 0;

  for (const line of lines) {
    if (!inNpm) {
      const match = line.match(/^(\s*)npm:\s*$/);
      if (match) {
        inNpm = true;
        npmIndent = match[1]?.length ?? 0;
      }
      continue;
    }

    if (!line.trim()) continue;
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent <= npmIndent && !line.trim().startsWith('-')) break;

    const itemMatch = line.match(/^\s*-\s*(.+)$/);
    const item = itemMatch?.[1];
    if (item) {
      entrypoints.push(stripQuotes(item.trim()));
      continue;
    }

    if (indent <= npmIndent) break;
  }

  if (entrypoints.length === 0) {
    throw new Error('No npm entrypoints found in repo.manifest.yaml');
  }

  return entrypoints;
}

function toSpecifier(entrypoint: string): string {
  if (entrypoint === '.' || entrypoint === './') return '@ismail-elkorchi/bytefold';
  if (entrypoint.startsWith('./')) return `@ismail-elkorchi/bytefold/${entrypoint.slice(2)}`;
  return entrypoint;
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
