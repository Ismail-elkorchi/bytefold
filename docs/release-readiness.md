# Release readiness inventory

Date: 2026-02-01
Repo: @ismail-elkorchi/bytefold

## Public entrypoints (npm exports map)

From `package.json` exports:

- `.` → `./dist/index.js`
- `./zip` → `./dist/zip/index.js`
- `./tar` → `./dist/tar/index.js`
- `./compress` → `./dist/compress/index.js`
- `./archive` → `./dist/archive/index.js`
- `./node` → `./dist/node/index.js`
- `./node/zip` → `./dist/node/zip/index.js`
- `./node/external` → `./dist/node/external/index.js`
- `./deno` → `./dist/deno/index.js`
- `./bun` → `./dist/bun/index.js`

## Intended JSR entrypoints

From `jsr.json` exports:

- `.` → `./mod.ts`
- `./archive` → `./archive/mod.ts`
- `./compress` → `./compress/mod.ts`
- `./zip` → `./zip/mod.ts`
- `./tar` → `./tar/mod.ts`
- `./deno` → `./deno/mod.ts`
- `./bun` → `./bun/mod.ts`

Node-only modules are intentionally **not** exported via JSR to avoid runtime mismatch.

## Universal vs runtime-specific modules

Universal (Node + Deno + Bun):
- `.` (default), `./archive`, `./zip`, `./tar`, `./compress`

Runtime-specific:
- Node-only: `./node`, `./node/zip`, `./node/external`
- Deno adapters: `./deno`
- Bun adapters: `./bun`

## JSON reports and JSON-safety

Public JSON reports (all include `schemaVersion` and contain no `bigint` values):

- Detection: `ArchiveDetectionReport` (`reader.detection`)
- Audit: `ZipAuditReport`, `TarAuditReport`, `ArchiveAuditReport`
- Normalize: `ZipNormalizeReport`, `TarNormalizeReport`, `ArchiveNormalizeReport`
- Capabilities: `CompressionCapabilities` (`getCompressionCapabilities()`)

Reports are JSON-safe by construction (no `bigint` fields and `JSON.stringify` is safe).

## Stable contract for agent pipelines (fields that will never disappear)

All reports include `schemaVersion: "2026-01"`.

Detection report:
- `schemaVersion`
- `inputKind`
- `detected` (object with `layers`, optional `container`, optional `compression`)
- `confidence`
- `notes`

Audit report (ZIP/TAR/Archive):
- `schemaVersion`
- `ok`
- `summary.entries`
- `summary.warnings`
- `summary.errors`
- `summary.totalBytes` (optional)
- `issues[]` with `code`, `severity`, `message`, optional `entryName`, optional `offset`, optional `details`

Normalize report (ZIP/TAR/Archive):
- `schemaVersion`
- `ok`
- `summary.entries`
- `summary.outputEntries`
- `summary.droppedEntries`
- `summary.renamedEntries`
- `summary.warnings`
- `summary.errors`
- `issues[]` with `code`, `severity`, `message`, optional `entryName`, optional `offset`, optional `details`

Compression capabilities:
- `schemaVersion`
- `runtime`
- `algorithms` (per-algorithm `compress`, `decompress`, `backend`)
- `notes`
