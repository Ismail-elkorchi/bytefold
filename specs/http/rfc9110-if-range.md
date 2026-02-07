---
role: reference
audience: maintainers
source_of_truth: upstream
update_triggers:
  - RFC 9110 updates
  - HTTP range/session policy changes
---

# RFC 9110: If-Range (Section 13.1.5)

RFC URL: https://www.rfc-editor.org/rfc/rfc9110.html

Quoted excerpt (RFC 9110 §13.1.5):
> "A client MUST NOT generate an If-Range header field containing an entity tag that is marked as weak."
> "A recipient of an If-Range header field MUST ignore the Range header field if the If-Range condition evaluates to false."

Bytefold interpretation (paraphrase):
- Only strong ETags are eligible for If-Range.
- If a range request with If-Range yields a full representation (e.g., 200 OK), Bytefold treats it as a resource-change condition and aborts the seekable session.

Tests:
- `test/zip-url-seekable-budget.test.ts`
- `test/deno.smoke.ts`
- `test/bun.smoke.ts`
