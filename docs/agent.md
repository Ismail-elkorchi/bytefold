# Agent workflow

`zip-next` provides audit-first extraction designed for autonomous agents.

## Safe pipeline

```js
import { ZipReader } from 'zip-next';

const reader = await ZipReader.fromUrl('https://example.com/archive.zip', {
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
```

You can do the same with a stream source:

```js
import { ZipReader } from 'zip-next';

const res = await fetch('https://example.com/archive.zip');
const reader = await ZipReader.fromStream(res.body!, { profile: 'agent' });

const report = await reader.audit({ profile: 'agent' });
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
  - trailing bytes after EOCD are rejected in audits
  - symlink entries are errors in audits

`assertSafe({ profile: 'agent' })` treats *any* audit warning as an error.

## Audit report JSON

`ZipAuditReport` includes bigint offsets internally, but the report object has a `toJSON` method so
`JSON.stringify(report)` is safe and converts bigints to strings in the output.

## Normalization for agents

For untrusted uploads, normalize the ZIP into a deterministic, single-interpretation archive:

```js
const reader = await ZipReader.fromFile('/tmp/upload.zip', { profile: 'agent' });
const report = await reader.normalizeToFile('/tmp/normalized.zip', {
  mode: 'safe',
  deterministic: true,
  onDuplicate: 'rename',
  onCaseCollision: 'rename'
});

console.log(JSON.stringify(report));
```
