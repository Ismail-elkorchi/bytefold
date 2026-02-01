# No external tools policy

Bytefold is a pure JavaScript/TypeScript library. Runtime features must never rely on
external binaries, shelling out, or WebAssembly.

## Runtime guarantees

- No child process spawning for library functionality.
- No WebAssembly modules for archive or compression features.
- Only built-in runtime APIs are allowed (Node `node:*`, Web APIs, Deno/Bun standard globals).
- Zero runtime npm dependencies.

## Allowed in development only

Development scripts and optional interop checks may call external tools strictly for
verification (not for user-facing APIs). Examples:

- `scripts/interop.mjs` (optional interoperability checks when tools are present)
- Optional test cases that skip when tools are missing

These scripts must remain separate from runtime code and must not be exposed as public APIs.

## Fixtures

Test fixtures are checked in as static binary data (or base64-decoded at build time). Tests never
invoke external compression tools to generate fixtures.
