---
role: overview
audience: users
source_of_truth: README.md
update_triggers:
  - public API changes
  - supported formats or codecs
---

# bytefold

Multi-format archive reader/writer for Node 24+, Deno, and Bun (runtime smoke tests: `test/deno.smoke.ts`, `test/bun.smoke.ts`). ESM-only, TypeScript strict, no runtime dependencies (tests: `test/repo-invariants.test.ts`).

## Install

```sh
npm install @ismail-elkorchi/bytefold
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

## Verification
`npm run check`

## Docs
- `SPEC.md` (invariants, API entrypoints, error/report model)
- `ARCHITECTURE.md` (module map and data flow)
- `SECURITY.md` (threat model and reporting)
- `CONTRIBUTING.md`, `CHANGELOG.md`
