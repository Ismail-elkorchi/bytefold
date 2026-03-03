# bytefold

Multi-format archive reader and writer with safety profiles for Node 24+, Deno, Bun, and Web.

## What it is

`bytefold` opens archives, audits safety conditions, and streams entry data with typed error/report contracts.

## Install

```sh
npm install @ismail-elkorchi/bytefold
deno add jsr:@ismail-elkorchi/bytefold
```

## Quickstart

```ts
import { readFile } from "node:fs/promises";
import { openArchive } from "@ismail-elkorchi/bytefold";

const input = await readFile("./archive.zip");
const reader = await openArchive(input, { profile: "agent" });
const report = await reader.audit({ profile: "agent" });
if (!report.ok) throw new Error("archive audit failed");

await reader.assertSafe({ profile: "agent" });
for await (const entry of reader.entries()) {
  if (entry.isDirectory || entry.isSymlink) continue;
  const data = await new Response(await entry.open()).arrayBuffer();
  console.log(entry.name, data.byteLength);
}
```

## Options reference

- [Options reference](https://github.com/Ismail-elkorchi/bytefold/blob/main/docs/reference/options.md)

## When not to use

- You only need a platform-specific native wrapper.
- You need CommonJS entrypoints.
- You need interactive archive browsing UI features.

## When to use

- You need a single API across runtimes for ZIP/TAR and layered compression formats.
- You need explicit safety profiles for untrusted inputs.
- You need deterministic audits and normalization.

## Compatibility

- Module system: ESM-only.
- Runtimes: Node `>=24`, current Deno, current Bun, modern browsers (web entrypoint).
- Web entrypoint means `@ismail-elkorchi/bytefold/web` (browser runtime with `Uint8Array`/`Blob`/`ReadableStream`/HTTPS URL inputs).
- The quickstart snippet above is Node-oriented; Deno/Bun can pass `Uint8Array` from their runtime file APIs.

## Links

- [Docs index](https://github.com/Ismail-elkorchi/bytefold/blob/main/docs/index.md)
- Reference:
  - [SPEC](https://github.com/Ismail-elkorchi/bytefold/blob/main/SPEC.md)
  - [Security policy](https://github.com/Ismail-elkorchi/bytefold/blob/main/SECURITY.md)
  - [Reference index](https://github.com/Ismail-elkorchi/bytefold/blob/main/docs/reference/index.md)
- How-to:
  - [How-to index](https://github.com/Ismail-elkorchi/bytefold/blob/main/docs/how-to/index.md)
  - [Audit before extract](https://github.com/Ismail-elkorchi/bytefold/blob/main/docs/how-to/audit-before-extract.md)
  - [Contributing](https://github.com/Ismail-elkorchi/bytefold/blob/main/CONTRIBUTING.md)
- Explanation: [ARCHITECTURE](https://github.com/Ismail-elkorchi/bytefold/blob/main/ARCHITECTURE.md)

## Verification

```sh
npm run examples:run
npm run check:fast
npm run check
```
