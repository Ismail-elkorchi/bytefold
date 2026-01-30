# Agent workflow

`archive-shield` provides audit-first extraction designed for autonomous agents across ZIP, TAR, and GZIP.

## Safe pipeline (auto-detect)

```js
import { openArchive } from 'archive-shield';

const res = await fetch('https://example.com/archive.tgz');
const reader = await openArchive(res.body, {
  profile: 'agent',
  limits: {
    maxEntries: 2000,
    maxTotalUncompressedBytes: 512n * 1024n * 1024n
  }
});

const report = await reader.audit({ profile: 'agent' });
console.log(JSON.stringify(report)); // JSON-safe

await reader.assertSafe({ profile: 'agent' });
// now extract selected entries
for await (const entry of reader.entries()) {
  if (entry.isDirectory) continue;
  const data = await new Response(await entry.open()).arrayBuffer();
  // write data to disk or process
}
```

## Node file adapters

```js
import { openArchive } from 'archive-shield/node';

const reader = await openArchive('/tmp/upload.zip', { profile: 'agent' });
await reader.assertSafe({ profile: 'agent' });
```

## Profiles

- `compat`: lenient parsing (`strict: false`), warnings surfaced instead of hard failures.
- `strict`: strict parsing (`strict: true`), default limits.
- `agent`: strict parsing + conservative defaults:
  - `maxEntries`: 5000
  - `maxUncompressedEntryBytes`: 256 MiB
  - `maxTotalUncompressedBytes`: 1 GiB
  - `maxCompressionRatio`: 200
  - trailing bytes after EOCD are rejected in ZIP audits
  - symlink entries are errors in ZIP/TAR audits

`assertSafe({ profile: 'agent' })` treats *any* audit warning as an error.

## Audit report JSON

Audit reports include bigint offsets internally, but each report has a `toJSON` method so
`JSON.stringify(report)` is safe and converts bigints to strings in the output.

## Normalization for agents

Normalize untrusted uploads into deterministic, single-interpretation archives.

```js
import { openArchive } from 'archive-shield';

const reader = await openArchive(fileBytes, { profile: 'agent' });
const chunks = [];
const writable = new WritableStream({
  write(chunk) {
    chunks.push(chunk);
  }
});

const report = await reader.normalizeToWritable(writable, {
  deterministic: true
});

console.log(JSON.stringify(report));
```
