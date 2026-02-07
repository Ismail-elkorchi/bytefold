---
role: policy
audience: maintainers, contributors, agents
source_of_truth: docs/NAMING.md
update_triggers:
  - public export additions or renames
  - options, error-code, or context-key naming changes
  - HTTP/archive boundary vocabulary changes
---

# Naming Guide

This project is in disciplined ALPHA: names are part of the contract surface and should optimize for safety, greppability, and agent reliability.

## Core rules

1. Use names as activation handles.
   - Prefer common dictionary lemmas that activate the right behavior cluster (`openArchive`, `createArchiveWriter`, `assertSafe`).
2. Ontology before instance.
   - PascalCase nouns for durable kinds (`ArchiveFormat`, `ZipErrorCode`), lower-camel for instances (`format`, `entryName`), verbs for processes (`detectFormat`, `enforceResourceLimits`).
3. Preserve cue -> act -> eval stages.
   - Cue: `detectFormat`, `resolveInputKind`
   - Act: `openArchive`, `extractAll`, `normalizeToWritable`
   - Eval: `audit`, `assertSafe`, `validatePack`
4. Domain first, then predicate, then qualifier.
   - Prefer domain-anchored names (`zipOptions.http.snapshotPolicy`) over inverted or vague forms.
5. Encode frame of reference explicitly.
   - Use directional/locus tokens (`mapHttpErrorToZipError`, `wrapRandomAccessForZip`, `toNodeReadable`, `toWebWritable`).
6. Booleans must read as propositions.
   - Prefer `is*`, `has*`, `can*`, `should*`, `did*`, `must*`.
   - Avoid negatives and double negation.
7. Encode modality and aspect when relevant.
   - Use status suffixes for lifecycle/epistemic state (`confidence`, `required*`, `supported*`, `preflightComplete`).
8. Do not over-promise in names.
   - Reserve evaluatives (`Safe`, `Valid`, `Canonical`) for paths that enforce them.
   - Use uncertainty markers when needed (`detected`, `notes`, `confidence`).
9. Keep compositional meaning tight.
   - Each token should add one constraint; avoid mixed metaphors and multi-level abstractions in one symbol.
10. Name roles, not containers.
   - Prefer semantic role names (`archiveContext`, `detectionReport`) over vessel names (`obj`, `list`, `data`).
11. Keep naming relevant to task domain.
   - Avoid null-head catch-alls (`helper`, `util`, `manager`, `service`) in new symbols.
12. Optimize for grep and log filters.
   - Keep stable prefixes (`ZIP_`, `ARCHIVE_`, `COMPRESSION_`, `HTTP_`), ASCII-only stems, and consistent log labels when introduced (`CUE:`, `ACT:`, `EVAL:`).
13. Align names with repository taxonomy.
   - Keep term families consistent across paths, docs, and schemas (`archive`, `zip`, `tar`, `compress`, `http`).
14. Use performative verbs for effects and constative verbs for queries.
   - Effects: `create`, `open`, `extract`, `register`, `emit`.
   - Queries/checks: `get`, `list`, `find`, `check`, `audit`, `detect`.
15. Prefer minimal length only when signal is preserved.
   - Short names are good when still unambiguous and grep-friendly.

## Concrete examples from Bytefold

1. Good: `openArchive` (`src/archive/index.ts`) is a clear activation handle for an effectful action.
2. Good: `mapHttpErrorToArchiveError` (`src/archive/httpArchiveErrors.ts`) encodes explicit boundary direction.
3. Good: `HTTP_ERROR_TO_ZIP_ERROR` (`src/reader/httpZipErrors.ts`) is grep-friendly and names both source and target ontologies.
4. Good internal improvement: `resolvedSizeBytes` (`src/reader/RandomAccess.ts`) is role-based and unit-explicit compared to `sizeValue`.
5. Good public names: `isStrict`, `shouldStoreEntries`, `isDeterministic`, and `shouldForceZip64` (`src/types.ts`, `src/archive/types.ts`, `src/tar/types.ts`) now read as truth-conditional propositions and reduce ambiguity at call sites.

## Scope and non-goals

- During ALPHA, internal renames that improve clarity are encouraged when behavior is unchanged.
- Public export, option-field, and error-schema renames require explicit break planning and should be batched intentionally before `1.0.0`.
