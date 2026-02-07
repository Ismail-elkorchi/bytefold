import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const MANIFEST = new URL('../repo.manifest.yaml', import.meta.url);
const SPEC = new URL('../SPEC.md', import.meta.url);

test('manifest invariants have test links in SPEC', async () => {
  const manifestText = await readFile(MANIFEST, 'utf8');
  const invariants = extractManifestInvariants(manifestText);
  assert.ok(invariants.length > 0, 'no invariants found in repo.manifest.yaml');

  const specText = await readFile(SPEC, 'utf8');
  const invariantSection = extractInvariantSection(specText).map((line) => normalizeLine(line));

  for (const invariant of invariants) {
    const normalizedInvariant = normalizeLine(invariant);
    const line = invariantSection.find((entry) => entry.includes(normalizedInvariant));
    assert.ok(line, `SPEC.md missing invariant: ${invariant}`);
    assert.ok(line?.includes('tests:'), `Invariant missing test link: ${invariant}`);
  }
});

function extractManifestInvariants(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const invariants: string[] = [];
  let inSection = false;
  let sectionIndent = 0;
  for (const line of lines) {
    if (!inSection) {
      const match = line.match(/^(\s*)invariants:\s*$/);
      if (match) {
        inSection = true;
        sectionIndent = match[1]?.length ?? 0;
      }
      continue;
    }
    if (!line.trim()) continue;
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent <= sectionIndent && !line.trim().startsWith('-')) break;
    const itemMatch = line.match(/^\s*-\s*(.+)$/);
    const raw = itemMatch?.[1];
    if (raw) {
      invariants.push(stripQuotes(raw.trim()));
    }
  }
  return invariants;
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function extractInvariantSection(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.startsWith('## Invariants'));
  if (start === -1) return [];
  const section: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('## ')) break;
    if (line.trim()) section.push(line);
  }
  return section;
}

function normalizeLine(value: string): string {
  return value.replace(/`/g, '');
}
