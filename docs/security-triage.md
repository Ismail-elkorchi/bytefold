---
role: policy
audience: maintainers, agents
source_of_truth: docs/security-triage.md
update_triggers:
  - security alert workflow changes
  - triage policy changes
---

# Security triage inventory

This file tracks security findings for `bytefold` and disposition state.

## Inventory schema

Each finding record uses:

```json
{
  "ruleId": "string",
  "severity": "error|warning|note|critical|high|medium|low",
  "state": "open|fixed|dismissed",
  "file": "string",
  "line": 0,
  "firstSeen": "ISO-8601",
  "lastSeen": "ISO-8601",
  "owner": "string"
}
```

## Source precedence

1. GitHub Security UI inventory.
2. GitHub API inventory once required token scopes are available.

Temporary UI-first fallback is recorded in private evidence logs (`tse-workbench`).
