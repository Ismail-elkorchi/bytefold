# bytefold

Multi-format archive reader/writer with safety profiles and deterministic normalization.

Supports Node, Deno, Bun, and browsers.

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

## Documentation

- [Docs index](https://github.com/Ismail-elkorchi/bytefold/blob/main/docs/index.md)
- [Tutorial: first safe archive read](https://github.com/Ismail-elkorchi/bytefold/blob/main/docs/tutorial/first-safe-read.md)
- [Reference: reader and writer options](https://github.com/Ismail-elkorchi/bytefold/blob/main/docs/reference/options.md)

## Verification

```sh
npm run examples:run
npm run check:fast
npm run check
```
