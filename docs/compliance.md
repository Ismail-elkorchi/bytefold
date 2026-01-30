# ZIP compliance matrix

This library implements the ZIP structures and behaviors based on the local specification files in `./specs/`.

## Feature matrix

| Feature | Read | Write | Spec refs |
| --- | --- | --- | --- |
| Local File Header (LFH) | ✅ | ✅ | APPNOTE 6.3.10 §4.3.7 |
| Central Directory File Header (CDFH) | ✅ | ✅ | APPNOTE 6.3.10 §4.3.12 |
| End of Central Directory (EOCD) | ✅ | ✅ | APPNOTE 6.3.10 §4.3.16 |
| ZIP64 EOCD + Locator | ✅ | ✅ | APPNOTE 6.3.10 §4.3.14–4.3.15 |
| Data Descriptor (w/ signature) | ✅ | ✅ | APPNOTE 6.3.10 §4.3.9 |
| Data Descriptor (no signature) | ✅ | N/A | APPNOTE 6.3.10 §4.3.9.3 |
| UTF-8 filenames (flag 11) | ✅ | ✅ | APPNOTE 6.3.10 §4.4.4 |
| CP437 decoding when UTF-8 not set | ✅ | N/A | APPNOTE 6.3.10 §4.4.4 |
| ZIP64 extra field (0x0001) | ✅ | ✅ | APPNOTE 6.3.10 §4.5.3 |
| Extended timestamp (0x5455) | ✅ | ✅ | appnote_iz.txt (Info-ZIP) |
| Unicode Path/Comment extra fields (0x7075/0x6375) | ✅ | N/A | appnote_iz.txt (Info-ZIP) |
| Store (method 0) | ✅ | ✅ | APPNOTE 6.3.10 §4.4.5 |
| Deflate (method 8) | ✅ | ✅ | RFC 1951 |
| Deflate64 (method 9) | ✅ | ❌ | appnote_iz.txt §X |
| Zstandard (method 93) | ✅ | ✅ | zstd_compression_format.md |
| Traditional PKWARE encryption (ZipCrypto) | ✅ | ✅ | APPNOTE 6.3.10 §6.1 + appnote_iz.txt |
| WinZip AES (AE-1/AE-2) | ✅ | ✅ | winzip_aes.md + APPNOTE 6.3.10 Appendix E |
| Seekable local header patch (no data descriptor) | N/A | ✅ | APPNOTE 6.3.10 §4.3.9 |
| HTTP Range random access | ✅ | N/A | Library feature (non-ZIP) |
| Streaming central directory iteration | ✅ | N/A | Library feature (non-ZIP) |

## Parsed but not supported

The following features are parsed for metadata but extraction is rejected with explicit errors:

- Unsupported encryption methods (`ZIP_UNSUPPORTED_ENCRYPTION`)
- Unsupported compression methods (`ZIP_UNSUPPORTED_METHOD`, includes method id)
- Multi-disk archives (`ZIP_UNSUPPORTED_FEATURE`)

## Notes

- EOCD search follows APPNOTE guidance by scanning backwards within the last 64KiB + minimum EOCD length.
- ZIP64 is used when sizes/offsets exceed classic limits, or when forced.
- Central directory parsing can be streamed via `ZipReader.iterEntries()` to avoid large buffers.
