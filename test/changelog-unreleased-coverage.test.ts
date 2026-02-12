import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const CHANGELOG = new URL('../CHANGELOG.md', import.meta.url);
const PACKAGE_JSON = new URL('../package.json', import.meta.url);

type ThemeRule = {
  name: string;
  patterns: RegExp[];
};

const REQUIRED_UNRELEASED_THEMES: ThemeRule[] = [
  {
    name: 'web URL hardening (https-only + maxInputBytes abort)',
    patterns: [/web adapter url/i, /non-https|https/i, /maxinputbytes/i]
  },
  {
    name: 'security simulation corpus',
    patterns: [/security simulation corpus|security-audit-simulation/i]
  },
  {
    name: 'real browser smoke beyond chromium',
    patterns: [/browser smoke/i, /chromium/i, /firefox/i, /webkit/i]
  },
  {
    name: 'zip64 boundary and writer structural proofs',
    patterns: [/zip64 boundary/i, /zip64 writer structural/i]
  },
  {
    name: 'fixture hash manifest enforcement',
    patterns: [/fixture integrity manifest|fixtures:hashes:check|security-fixture-hashes/i]
  },
  {
    name: 'deterministic property-based parser boundaries',
    patterns: [/property-based parser boundary|fuzz-property-boundaries/i]
  },
  {
    name: 'unicode trojan source guard',
    patterns: [/unicode trojan source|unicode:check|bidi override/i]
  }
];

test('changelog release-truth guard covers core post-0.5.0 themes', async () => {
  const changelog = await readFile(CHANGELOG, 'utf8');
  const packageJson = JSON.parse(await readFile(PACKAGE_JSON, 'utf8')) as { version: string };
  const unreleased = extractSection(changelog, 'Unreleased');
  const targetSection = isNoEntriesPlaceholder(unreleased) ? extractSection(changelog, packageJson.version) : unreleased;

  const missing: string[] = [];
  for (const theme of REQUIRED_UNRELEASED_THEMES) {
    const ok = theme.patterns.every((pattern) => pattern.test(targetSection));
    if (!ok) {
      missing.push(theme.name);
    }
  }

  assert.deepEqual(missing, [], `changelog section missing required themes: ${missing.join(', ')}`);
});

function extractSection(changelog: string, header: string): string {
  const marker = `## ${header}`;
  const start = changelog.indexOf(marker);
  assert.ok(start >= 0, `CHANGELOG.md must contain section: ${marker}`);

  const afterMarker = changelog.slice(start + marker.length);
  const nextHeaderMatch = /\n##\s+/.exec(afterMarker);
  if (!nextHeaderMatch) {
    return afterMarker;
  }
  return afterMarker.slice(0, nextHeaderMatch.index);
}

function isNoEntriesPlaceholder(section: string): boolean {
  return /no entries yet/i.test(section);
}
