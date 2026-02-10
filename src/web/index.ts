import type { ArchiveOpenOptions } from '../archive/types.js';
import { createArchiveWriter, openArchive as openArchiveCore, type ArchiveReader } from '../archive/index.js';
import { ArchiveError } from '../archive/errors.js';
import { readAllBytes } from '../streams/buffer.js';

export { ArchiveError } from '../archive/errors.js';
export type {
  ArchiveAuditReport,
  ArchiveDetectionReport,
  ArchiveEntry,
  ArchiveFormat,
  ArchiveInputKind,
  ArchiveIssue,
  ArchiveIssueSeverity,
  ArchiveLimits,
  ArchiveNormalizeReport,
  ArchiveOpenOptions,
  ArchiveProfile
} from '../archive/types.js';
export type { ArchiveReader, ArchiveWriter } from '../archive/index.js';
export { createArchiveWriter };

export * from '../zip/index.js';
export * from '../tar/index.js';

export type WebArchiveInput =
  | Uint8Array
  | ArrayBuffer
  | ReadableStream<Uint8Array>
  | Blob
  | string
  | URL;

export async function openArchive(input: WebArchiveInput, options?: ArchiveOpenOptions): Promise<ArchiveReader> {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return openArchiveCore(input, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: 'bytes' })
    });
  }
  if (isBlobInput(input)) {
    return openArchiveCore(input, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: 'blob' })
    });
  }
  if (typeof input === 'string' || input instanceof URL) {
    const url = resolveHttpsUrl(input);
    const response = await fetch(url, options?.signal ? { signal: options.signal } : undefined);
    if (!response.ok) {
      throw new ArchiveError('ARCHIVE_BAD_HEADER', `Unexpected HTTP status ${response.status}`);
    }
    const bytes = await readResponseBytes(response, options);
    const filename = options?.filename ?? inferFilenameFromUrl(url);
    return openArchiveCore(bytes, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: 'url' }),
      ...(options?.filename ? {} : { filename })
    });
  }
  return openArchiveCore(input, {
    ...options,
    ...(options?.inputKind ? {} : { inputKind: 'stream' })
  });
}

function resolveHttpsUrl(input: string | URL): URL {
  const url = input instanceof URL ? input : safeParseUrl(input);
  if (!url || url.protocol !== 'https:') {
    throw new ArchiveError('ARCHIVE_UNSUPPORTED_FEATURE', 'Web adapter supports only HTTPS URL inputs');
  }
  return url;
}

function safeParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function inferFilenameFromUrl(url: URL): string {
  return url.pathname || url.toString();
}

function isBlobInput(input: unknown): input is Blob {
  return typeof Blob !== 'undefined' && input instanceof Blob;
}

function resolveInputMaxBytes(options?: ArchiveOpenOptions): bigint | number | undefined {
  if (options?.limits?.maxInputBytes !== undefined) {
    return options.limits.maxInputBytes;
  }
  if (options?.limits?.maxTotalDecompressedBytes !== undefined) {
    return options.limits.maxTotalDecompressedBytes;
  }
  if (options?.limits?.maxTotalUncompressedBytes !== undefined) {
    return options.limits.maxTotalUncompressedBytes;
  }
  return undefined;
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

async function readResponseBytes(response: Response, options?: ArchiveOpenOptions): Promise<Uint8Array> {
  const maxBytes = resolveInputMaxBytes(options);
  if (maxBytes !== undefined) {
    const contentLength = response.headers.get('content-length');
    if (contentLength && /^\d+$/u.test(contentLength)) {
      if (BigInt(contentLength) > toBigInt(maxBytes)) {
        throw new RangeError('Stream exceeds maximum allowed size');
      }
    }
  }
  const body = response.body;
  if (!body) {
    return new Uint8Array(0);
  }
  return readAllBytes(body, {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {})
  });
}
