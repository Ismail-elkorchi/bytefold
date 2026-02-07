---
role: reference
audience: maintainers
source_of_truth: upstream
update_triggers:
  - filter id table changes
---

# XZ Filter IDs (Extended BCJ)

This file captures BCJ filter ID assignments that are documented outside the
XZ file format specification. It is a concise, local reference to avoid
overloading a single spec source.

Source of truth:
- XZ Utils `liblzma` API header `src/liblzma/api/lzma/filter.h`
  (SPDX-License-Identifier: 0BSD).
- Reference URL: https://github.com/tukaani-project/xz/blob/master/src/liblzma/api/lzma/filter.h

| Filter ID | Name   | Notes |
| --- | --- | --- |
| `0x0A` | ARM64 BCJ | 4-byte properties, alignment 4 |
| `0x0B` | RISC-V BCJ | 4-byte properties, alignment 2 |
