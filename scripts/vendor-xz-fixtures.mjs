import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REV = 'c5775646357692a949127d6b8240ec645fdcd4b2';
const BASE = `https://chromium.googlesource.com/chromium/deps/xz/+/${REV}/`;

const fixtures = [
  // Good
  'tests/files/good-0-empty.xz',
  'tests/files/good-0pad-empty.xz',
  'tests/files/good-0cat-empty.xz',
  'tests/files/good-0catpad-empty.xz',
  'tests/files/good-1-check-none.xz',
  'tests/files/good-1-check-crc32.xz',
  'tests/files/good-1-check-crc64.xz',
  'tests/files/good-1-check-sha256.xz',
  'tests/files/good-1-delta-lzma2.tiff.xz',
  'tests/files/good-1-x86-lzma2.xz',
  'tests/files/good-2-lzma2.xz',
  // Bad
  'tests/files/bad-0-header_magic.xz',
  'tests/files/bad-0-footer_magic.xz',
  'tests/files/bad-1-check-crc32.xz',
  'tests/files/bad-1-check-crc64.xz',
  'tests/files/bad-1-check-sha256.xz',
  // Unsupported
  'tests/files/unsupported-check.xz',
  'tests/files/unsupported-filter_flags-1.xz',
  'tests/files/unsupported-filter_flags-2.xz',
  'tests/files/unsupported-filter_flags-3.xz',
  // Expected outputs
  'tests/compress_prepared_bcj_x86',
  'tests/compress_prepared_bcj_sparc'
];

const targetRoot = new URL('../test/fixtures/xz-utils/', import.meta.url).pathname;

const fetchBase64 = async (url) => {
  const res = await fetch(`${url}?format=TEXT`);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status}`);
  }
  const text = await res.text();
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
};

const run = async () => {
  await mkdir(targetRoot, { recursive: true });
  for (const file of fixtures) {
    const url = `${BASE}${file}`;
    const data = await fetchBase64(url);
    const filename = path.basename(file);
    const dest = path.join(targetRoot, filename);
    await writeFile(dest, data);
    process.stdout.write(`Downloaded ${filename}\n`);
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
