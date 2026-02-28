# bytefold

Multi-format archive reader/writer for Node 24+, Deno, Bun, and Web (Browser). ESM-only, TypeScript strict, no runtime dependencies (tests: `test/repo-invariants.test.ts`).

## Install

```sh
npm install @ismail-elkorchi/bytefold
# or
deno add jsr:@ismail-elkorchi/bytefold
```

## Quickstart (auto-detect)

```js
import { openArchive } from '@ismail-elkorchi/bytefold';

const reader = await openArchive(bytesOrStream, { profile: 'agent' });
const report = await reader.audit({ profile: 'agent' });
console.log(JSON.stringify(report));

await reader.assertSafe({ profile: 'agent' });
for await (const entry of reader.entries()) {
  if (entry.isDirectory) continue;
  const data = await new Response(await entry.open()).arrayBuffer();
  console.log(entry.name, data.byteLength);
}
```

Support matrix: see `SPEC.md` (Support matrix section).
Machine-readable support entrypoint: `@ismail-elkorchi/bytefold/support`.

Web runtime entrypoint: `@ismail-elkorchi/bytefold/web` (HTTPS URL input only; full-fetch by design; no seekable HTTP range sessions in web adapter).

## Common recipes

### 1) Validate untrusted archives before extraction

```js
import { openArchive } from '@ismail-elkorchi/bytefold';

const reader = await openArchive(input, { profile: 'agent' });
const report = await reader.audit({ profile: 'agent' });
await reader.assertSafe({ profile: 'agent' });
```

### 2) Extract safely with strict limits

```js
import { openArchive } from '@ismail-elkorchi/bytefold';

const reader = await openArchive(input, {
  profile: 'strict',
  limits: { maxTotalExtractedBytes: 512 * 1024 * 1024 }
});
await reader.extractAll('./out', { profile: 'strict' });
```

## Troubleshooting

- `ARCHIVE_UNSUPPORTED_FEATURE`: format/operation is intentionally unsupported; verify format hints and runtime support matrix in `SPEC.md`.
- `COMPRESSION_UNSUPPORTED_ALGORITHM`: runtime lacks codec support (common on some Deno/Web paths); check `@ismail-elkorchi/bytefold/support`.
- `ZIP_HTTP_*` errors: remote ZIP seekable reads require compliant HTTP range behavior.

## Verification
`npm run check`

## Docs
- `SPEC.md` (invariants, API entrypoints, error/report model)
- `ARCHITECTURE.md` (module map and data flow)
- `SECURITY.md` (threat model and reporting)
- `CONTRIBUTING.md`, `CHANGELOG.md`
- `CODE_OF_CONDUCT.md`, `SUPPORT.md`
