---
role: reference
audience: maintainers
source_of_truth: upstream
update_triggers:
  - RFC 9110 updates
  - HTTP content-coding policy changes
---

# RFC 9110: Accept-Encoding (Section 12.5.3)

RFC URL: https://www.rfc-editor.org/rfc/rfc9110.html

Quoted excerpt (RFC 9110 §12.5.3):
> "The \"Accept-Encoding\" header field can be used to indicate preferences regarding content codings."
> "An \"identity\" token is used as a synonym for \"no encoding\" in order to communicate when no encoding is preferred."

Bytefold interpretation (paraphrase):
- Seekable HTTP range sessions must operate on byte-identical representations.
- Bytefold sends `Accept-Encoding: identity` and rejects any response with a non-identity `Content-Encoding`.

Tests:
- `test/zip-url-seekable-budget.test.ts`
- `test/deno.smoke.ts`
- `test/bun.smoke.ts`
