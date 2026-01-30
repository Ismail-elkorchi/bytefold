export interface Sink {
  position: bigint;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface SeekableSink extends Sink {
  writeAt(offset: bigint, chunk: Uint8Array): Promise<void>;
}

class BaseSink implements Sink {
  position: bigint = 0n;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(private readonly stream: WritableStream<Uint8Array>) {
    this.writer = stream.getWriter();
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    await this.writer.write(chunk);
    this.position += BigInt(chunk.length);
  }

  async close(): Promise<void> {
    await this.writer.close();
  }
}

export class WebWritableSink extends BaseSink {
  constructor(stream: WritableStream<Uint8Array>) {
    super(stream);
  }
}
