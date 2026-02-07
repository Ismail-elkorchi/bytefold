---
role: policy
audience: maintainers, agents, users
source_of_truth: SECURITY.md
update_triggers:
  - new threat mitigations
  - new formats or codecs
  - changes to extraction behavior
---

# SECURITY

## Threat model
- Inputs are untrusted: archives may be malformed, malicious, or crafted for resource exhaustion.
- Common risks: zip bombs, oversized entries, path traversal, symlinks, corrupt headers, and CRC/check mismatches.
- Agent usage: treat external inputs as hostile and prefer audit/normalize before extract.

## Mitigations
- Size and ratio limits for decompression and extraction.
- Audit and `assertSafe` checks for structural issues and unsafe entries.
- Typed errors for corruption and unsupported features.
- Atomic extraction for XZ-backed single-file paths to prevent partial outputs.

## Reporting vulnerabilities
- Prefer private disclosure via GitHub Security Advisories.
- Include a minimal reproducer, affected version, and expected vs. actual behavior.
