declare const Deno: {
  test: (name: string, fn: () => void | Promise<void>) => void;
  version?: { deno?: string };
  makeTempDir: (...args: unknown[]) => Promise<string>;
  readFile: (path: string | URL) => Promise<Uint8Array>;
  writeFile: (path: string | URL, data: Uint8Array) => Promise<void>;
  listen: (options: { hostname: string; port: number }) => {
    addr: Deno.NetAddr;
    close: () => void;
    [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
  };
  serveHttp: (conn: unknown) => {
    [Symbol.asyncIterator]: () => AsyncIterator<{
      request: Request;
      respondWith: (response: Response) => Promise<void>;
    }>;
  };
  open: (
    path: string | URL,
    options?: Record<string, unknown>
  ) => Promise<{ writable: WritableStream<Uint8Array>; close: () => void }>;
  SeekMode: { Start: number };
};

declare namespace Deno {
  export type NetAddr = { hostname: string; port: number };
}

declare const Bun: {
  version?: string;
  write: (path: string, data: Uint8Array) => Promise<void>;
  file: (path: string) => { arrayBuffer: () => Promise<ArrayBuffer>; size?: number; slice?: (start: number, end?: number) => unknown };
  serve: (options: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }) => { port: number; stop: () => void };
};

declare module 'bun:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(value: unknown): {
    toBe: (expected: unknown) => void;
    toEqual: (expected: unknown) => void;
  };
}
