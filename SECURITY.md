# SECURITY

## Supported versions

| Version | Supported |
| --- | --- |
| `0.x` (ALPHA) | Yes |
| `<0.4.0` | No |

## Threat model
- Inputs are untrusted: archives may be malformed, malicious, or crafted for resource exhaustion.
- Common risks: zip bombs, oversized entries, path traversal, symlinks, corrupt headers, and CRC/check mismatches.
- Agent usage: treat external inputs as hostile and prefer audit/normalize before extract.

## Mitigations
- Size and ratio limits for decompression and extraction.
- Audit and `assertSafe` checks for structural issues and unsafe entries.
- Node ZIP extraction keeps symlink targets and follow-on writes contained under the destination root when symlink materialization is enabled.
- Node full-fetch non-ZIP file and URL inputs enforce raw input byte ceilings, and Node XZ single-file extraction sanitizes inferred output names to stay contained.
- Node ZIP and XZ extraction helpers fail closed on pre-existing destination files instead of replacing host files in place.
- Typed errors for corruption and unsupported features.
- Atomic extraction for XZ-backed single-file paths to prevent partial outputs.

## Reporting vulnerabilities
- Prefer private disclosure via GitHub Security Advisories:
  `https://github.com/Ismail-elkorchi/bytefold/security/advisories/new`
- If private advisories are unavailable, open a private security report via:
  `https://github.com/Ismail-elkorchi/bytefold/security`
- Include a minimal reproducer, affected version, and expected vs. actual behavior.
- Maintainers target an initial acknowledgement within 72 hours.
