# Agent workflow

`bytefold` provides audit-first extraction designed for autonomous agents across ZIP, TAR, GZIP, Zstandard, and Brotli layers.

## Safe pipeline (capabilities → auto-detect → audit → normalize → extract)

```js
import { openArchive } from '@ismail-elkorchi/bytefold';
import { getCompressionCapabilities } from '@ismail-elkorchi/bytefold/compress';

const caps = getCompressionCapabilities();
console.log(JSON.stringify(caps));

const res = await fetch('https://example.com/archive.tgz');
const reader = await openArchive(res.body, {
  profile: 'agent',
  limits: {
    maxEntries: 2000,
    maxTotalUncompressedBytes: 512n * 1024n * 1024n
  }
});

console.log(JSON.stringify(reader.detection));

const report = await reader.audit({ profile: 'agent' });
console.log(JSON.stringify(report)); // JSON-safe (no bigint)

await reader.assertSafe({ profile: 'agent' });

const normalizedChunks = [];
const normalizedWritable = new WritableStream({
  write(chunk) {
    normalizedChunks.push(chunk);
  }
});
await reader.normalizeToWritable?.(normalizedWritable, { deterministic: true });

// extract selected entries
for await (const entry of reader.entries()) {
  if (entry.isDirectory) continue;
  const data = await new Response(await entry.open()).arrayBuffer();
  // write data to disk or process
}
```

## Node file adapters

```js
import { openArchive } from '@ismail-elkorchi/bytefold/node';

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

## Detection report

`openArchive()` exposes a JSON-safe detection report on `reader.detection`:

```js
{
  schemaVersion: "2026-01",
  inputKind: "stream",
  detected: { container: "tar", compression: "gzip", layers: ["gzip", "tar"] },
  confidence: "high",
  notes: ["Format inferred from magic bytes"]
}
```

Use `confidence` + `notes` to decide when to require human review or explicit format hints.
`schemaVersion` is the stable contract key for agent pipelines.

## Normalization for agents

Normalize untrusted uploads into deterministic, single-interpretation archives.

```js
import { openArchive } from '@ismail-elkorchi/bytefold';

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
