# Third-party XZ fixtures

Origin (XZ Utils test suite via Chromium mirror, commit `c5775646357692a949127d6b8240ec645fdcd4b2`):
- `good-1-x86-lzma2.xz` from `tests/files/good-1-x86-lzma2.xz`
- `good-1-check-sha256.xz` from `tests/files/good-1-check-sha256.xz`

Reference URLs:
- https://chromium.googlesource.com/chromium/deps/xz/+/c5775646357692a949127d6b8240ec645fdcd4b2/tests/files/good-1-x86-lzma2.xz
- https://chromium.googlesource.com/chromium/deps/xz/+/c5775646357692a949127d6b8240ec645fdcd4b2/tests/files/good-1-check-sha256.xz
- https://chromium.googlesource.com/chromium/deps/xz/+/c5775646357692a949127d6b8240ec645fdcd4b2/tests/compress_prepared_bcj_x86

`good-1-check-sha256.bin` is the decoded payload produced by XZ Utils (`xz -dc`) from the upstream `.xz` sample above.

For `good-1-x86-lzma2.xz`, the expected decoded payload is pinned as digest metadata instead of a committed ELF binary:
- expected bytes: `1388`
- expected sha256: `dee7bc599bfc07147a302f44d1e994140bc812029baa4394d703e73e29117113`

License:
- XZ Utils sources carry SPDX `0BSD` headers; these test fixtures ship with XZ Utils under the same terms.

Why included:
- Real-world `.xz` samples that exercise BCJ (x86) and SHA-256 checks without relying on external tools at test time.

Size control:
- This directory contains only two `.xz` samples and their expected outputs.
- Package size is tracked by `npm run pack:check`; changes to fixture counts or sizes are reviewed.
