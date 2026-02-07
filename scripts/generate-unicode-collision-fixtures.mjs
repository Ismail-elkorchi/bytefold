import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchiveWriter } from '../dist/index.js';

const encoder = new TextEncoder();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(repoRoot, 'test', 'fixtures', 'ambiguous');

await mkdir(fixtureRoot, { recursive: true });

const writeBytes = (name, bytes) => writeFile(path.join(fixtureRoot, name), bytes);

const nfc = 'caf\u00e9.txt';
const nfd = 'cafe\u0301.txt';

const tarBytes = await writeArchive(
  'tar',
  [
    { name: nfc, data: encoder.encode('nfc') },
    { name: nfd, data: encoder.encode('nfd') }
  ],
  { tar: { deterministic: true } }
);
await writeBytes('tar-unicode-collision.tar', tarBytes);

const zipBytes = await writeArchive(
  'zip',
  [
    { name: nfc, data: encoder.encode('nfc'), options: { mtime: new Date(0) } },
    { name: nfd, data: encoder.encode('nfd'), options: { mtime: new Date(0) } }
  ],
  { zip: { defaultMethod: 0 } }
);
await writeBytes('zip-unicode-collision.zip', zipBytes);

async function writeArchive(format, entries, options) {
  const chunks = [];
  const writable = new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter(format, writable, options);
  for (const entry of entries) {
    await writer.add(entry.name, entry.data, entry.options);
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
