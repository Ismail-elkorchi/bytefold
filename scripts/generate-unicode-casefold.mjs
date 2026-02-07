import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specPath = path.join(repoRoot, 'specs', 'unicode', 'CaseFolding-17.0.0.txt');
const outputPath = path.join(repoRoot, 'src', 'generated', 'unicodeCaseFolding.ts');

export async function generateCaseFoldingSource() {
  const text = await readFile(specPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const versionLine = lines.find((line) => line.startsWith('# CaseFolding-')) ?? '# CaseFolding-unknown';
  const entries = [];

  for (const line of lines) {
    const content = line.split('#')[0]?.trim();
    if (!content) continue;
    const parts = content.split(';').map((part) => part.trim());
    if (parts.length < 3) continue;
    const code = parts[0];
    const status = parts[1];
    const mapping = parts[2];
    if (status !== 'C' && status !== 'F') continue;
    const codePoint = Number.parseInt(code, 16);
    if (!Number.isFinite(codePoint)) continue;
    const mapped = mapping
      .split(' ')
      .filter(Boolean)
      .map((hex) => `\\u{${hex.toUpperCase()}}`)
      .join('');
    entries.push({ codePoint, mapped });
  }

  entries.sort((a, b) => a.codePoint - b.codePoint);

  const header = [
    '/* @generated */',
    `// Source: ${path.relative(repoRoot, specPath).replace(/\\/g, '/')}`,
    `// ${versionLine}`,
    '// Policy: include statuses C and F; exclude T (Turkic).',
    ''
  ].join('\n');

  const body = entries
    .map((entry) => `  [0x${entry.codePoint.toString(16).toUpperCase()}, "${entry.mapped}"],`)
    .join('\n');

  const source = `${header}
export const CASE_FOLDING_VERSION = "17.0.0" as const;
export const CASE_FOLDING_SOURCE = "${path
    .relative(repoRoot, specPath)
    .replace(/\\/g, '/')}" as const;
export const CASE_FOLDING_MAP: ReadonlyMap<number, string> = new Map([\n${body}\n]);\n`;

  return source;
}

async function main() {
  const check = process.argv.includes('--check');
  const source = await generateCaseFoldingSource();
  if (check) {
    try {
      const existing = await readFile(outputPath, 'utf8');
      if (existing !== source) {
        throw new Error('Generated case folding table is out of date. Run scripts/generate-unicode-casefold.mjs');
      }
      return;
    } catch (err) {
      throw new Error('Generated case folding table is missing or out of date. Run scripts/generate-unicode-casefold.mjs');
    }
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source, 'utf8');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
