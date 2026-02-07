import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchiveWriter } from '../dist/index.js';

const encoder = new TextEncoder();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(repoRoot, 'test', 'fixtures', 'ambiguous');

await mkdir(fixtureRoot, { recursive: true });

const writeBytes = (name, bytes) => writeFile(path.join(fixtureRoot, name), bytes);

const FUSS = 'FUSS.txt';
const FUSS_SHARP = 'Fu\u00df.txt';
const SIGMA_UPPER = '\u039f\u03a3.txt';
const SIGMA_LOWER = '\u03bf\u03c2.txt';
const TURKIC_I = 'I.txt';
const TURKIC_DOTLESS = '\u0131.txt';

await writeBytes(
  'zip-casefold-fuss.zip',
  await writeZip([
    { name: FUSS, data: encoder.encode('upper') },
    { name: FUSS_SHARP, data: encoder.encode('sharp') }
  ])
);

await writeBytes(
  'zip-casefold-sigma.zip',
  await writeZip([
    { name: SIGMA_UPPER, data: encoder.encode('upper') },
    { name: SIGMA_LOWER, data: encoder.encode('lower') }
  ])
);

await writeBytes(
  'zip-casefold-turkic.zip',
  await writeZip([
    { name: TURKIC_I, data: encoder.encode('latin i') },
    { name: TURKIC_DOTLESS, data: encoder.encode('dotless') }
  ])
);

async function writeZip(entries) {
  const chunks = [];
  const writable = new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('zip', writable, { zip: { defaultMethod: 0 } });
  for (const entry of entries) {
    await writer.add(entry.name, entry.data, { mtime: new Date(0) });
  }
  await writer.close();
  return concatChunks(chunks);
}

function concatChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
