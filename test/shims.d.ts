declare const Deno: {
  test: (name: string, fn: () => void | Promise<void>) => void;
  makeTempDir: (...args: unknown[]) => Promise<string>;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  open: (path: string, options?: Record<string, unknown>) => Promise<{ writable: WritableStream<Uint8Array>; close: () => void }>;
};

declare const Bun: {
  write: (path: string, data: Uint8Array) => Promise<void>;
  file: (path: string) => { arrayBuffer: () => Promise<ArrayBuffer> };
};

declare module 'bun:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(value: unknown): {
    toBe: (expected: unknown) => void;
    toEqual: (expected: unknown) => void;
  };
}
