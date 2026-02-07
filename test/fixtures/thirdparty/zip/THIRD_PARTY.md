# Third-party ZIP fixtures

Origin (CPython test data, commit `9d0c7432ea40ab3f73af5ab9fb6ae1fc7100fe8e`):
- `zip_cp437_header.zip` from `Lib/test/archivetestdata/zip_cp437_header.zip`
- `zipdir_backslash.zip` from `Lib/test/archivetestdata/zipdir_backslash.zip`

Reference URLs:
- `https://raw.githubusercontent.com/python/cpython/9d0c7432ea40ab3f73af5ab9fb6ae1fc7100fe8e/Lib/test/archivetestdata/zip_cp437_header.zip`
- `https://raw.githubusercontent.com/python/cpython/9d0c7432ea40ab3f73af5ab9fb6ae1fc7100fe8e/Lib/test/archivetestdata/zipdir_backslash.zip`

License:
- SPDX `PSF-2.0` (CPython license).

Why included:
- Exercise non-Bytefold ZIP producers and path encoding edge cases (CP437 header, backslash paths).

Origin (Go standard library test data, commit `1179cfc9b490ce5a8c3adaccea84c79e69f711d7`):
- `zip64.zip` from `src/archive/zip/testdata/zip64.zip`

Reference URL:
- `https://raw.githubusercontent.com/golang/go/1179cfc9b490ce5a8c3adaccea84c79e69f711d7/src/archive/zip/testdata/zip64.zip`

License:
- SPDX `BSD-3-Clause` (Go project license).

Why included:
- Exercise ZIP64 EOCD structures from a non-Bytefold toolchain.
