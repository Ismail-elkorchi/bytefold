import { readUint32LE, writeUint32LE } from '../binary.js';
import { CompressionError } from '../compress/errors.js';

export type ByteSink = {
  writeByte(value: number): void;
  flush(): void;
};

export type FilterSpec = {
  id: bigint;
  props: Uint8Array;
};

export const LZMA2_FILTER_ID = 0x21n;
const DELTA_FILTER_ID = 0x03n;
const X86_FILTER_ID = 0x04n;
const POWERPC_FILTER_ID = 0x05n;
const IA64_FILTER_ID = 0x06n;
const ARM_FILTER_ID = 0x07n;
const ARMTHUMB_FILTER_ID = 0x08n;
const SPARC_FILTER_ID = 0x09n;
const ARM64_FILTER_ID = 0x0an;
const RISCV_FILTER_ID = 0x0bn;

const FILTER_BUFFER_SIZE = 64;

type FilterKind = 'lzma2' | 'delta' | 'bcj';

type FilterInfo = {
  id: bigint;
  name: string;
  kind: FilterKind;
  allowAsLast: boolean;
  allowAsNonLast: boolean;
  changesSize: boolean;
  alignment?: number;
};

const FILTER_INFO: FilterInfo[] = [
  {
    id: DELTA_FILTER_ID,
    name: 'delta',
    kind: 'delta',
    allowAsLast: false,
    allowAsNonLast: true,
    changesSize: false
  },
  {
    id: X86_FILTER_ID,
    name: 'x86',
    kind: 'bcj',
    allowAsLast: false,
    allowAsNonLast: true,
    changesSize: false,
    alignment: 1
  },
  {
    id: POWERPC_FILTER_ID,
    name: 'powerpc',
    kind: 'bcj',
    allowAsLast: false,
    allowAsNonLast: true,
    changesSize: false,
    alignment: 4
  },
  {
    id: IA64_FILTER_ID,
    name: 'ia64',
    kind: 'bcj',
    allowAsLast: false,
    allowAsNonLast: true,
    changesSize: false,
    alignment: 16
  },
  {
    id: ARM_FILTER_ID,
    name: 'arm',
    kind: 'bcj',
    allowAsLast: false,
    allowAsNonLast: true,
    changesSize: false,
    alignment: 4
  },
  {
    id: ARMTHUMB_FILTER_ID,
    name: 'armthumb',
    kind: 'bcj',
    allowAsLast: false,
    allowAsNonLast: true,
    changesSize: false,
    alignment: 2
  },
  {
    id: SPARC_FILTER_ID,
    name: 'sparc',
    kind: 'bcj',
    allowAsLast: false,
    allowAsNonLast: true,
    changesSize: false,
    alignment: 4
  },
  {
    id: ARM64_FILTER_ID,
    name: 'arm64',
    kind: 'bcj',
    allowAsLast: false,
    allowAsNonLast: true,
    changesSize: false,
    alignment: 4
  },
  {
    id: RISCV_FILTER_ID,
    name: 'riscv',
    kind: 'bcj',
    allowAsLast: false,
    allowAsNonLast: true,
    changesSize: false,
    alignment: 2
  },
  {
    id: LZMA2_FILTER_ID,
    name: 'lzma2',
    kind: 'lzma2',
    allowAsLast: true,
    allowAsNonLast: false,
    changesSize: true
  }
];

const FILTER_LOOKUP = new Map<bigint, FilterInfo>(FILTER_INFO.map((info) => [info.id, info]));
const SUPPORTED_FILTERS = FILTER_INFO.map((info) => `${formatFilterId(info.id)} (${info.name})`).join(', ');

export function validateFilterChain(filters: FilterSpec[]): { lzma2Props: number } {
  if (filters.length === 0) {
    throw xzBadData('XZ filter chain is empty');
  }
  if (filters.length > 4) {
    throw xzBadData('Invalid XZ filter count');
  }
  const chain = filters.map((filter) => formatFilterId(filter.id)).join(', ');
  const lastIndex = filters.length - 1;
  let lzma2Props: number | null = null;

  for (let i = 0; i < filters.length; i += 1) {
    const filter = filters[i]!;
    const info = FILTER_LOOKUP.get(filter.id);
    if (!info) {
      throw unsupportedFilter(filter.id, i, chain);
    }
    const isLast = i === lastIndex;
    if (isLast) {
      if (!info.allowAsLast) {
        throw unsupportedFilterChain(`XZ filter ${formatFilterId(filter.id)} cannot be last`, {
          filterId: formatFilterId(filter.id),
          filterIndex: String(i),
          rule: 'non-last-only',
          filterChain: chain
        });
      }
    } else {
      if (!info.allowAsNonLast) {
        throw unsupportedFilterChain(`XZ filter ${formatFilterId(filter.id)} cannot be non-last`, {
          filterId: formatFilterId(filter.id),
          filterIndex: String(i),
          rule: 'last-only',
          filterChain: chain
        });
      }
      if (info.changesSize) {
        throw unsupportedFilterChain(`XZ filter ${formatFilterId(filter.id)} changes size and cannot be non-last`, {
          filterId: formatFilterId(filter.id),
          filterIndex: String(i),
          rule: 'non-last-no-size-change',
          filterChain: chain
        });
      }
    }

    if (info.kind === 'lzma2') {
      if (!isLast) {
        throw xzBadData(`XZ filter ${formatFilterId(filter.id)} must be last`, {
          filterId: formatFilterId(filter.id),
          filterIndex: String(i),
          rule: 'last-only',
          filterChain: chain
        });
      }
      if (filter.props.length !== 1) {
        throw xzBadData('Invalid LZMA2 filter properties');
      }
      lzma2Props = filter.props[0]!;
    } else if (info.kind === 'delta') {
      parseDeltaDistance(filter.props);
    } else if (info.kind === 'bcj') {
      parseBcjStartOffset(filter.id, filter.props);
    }
  }

  if (lzma2Props === null) {
    throw new CompressionError('COMPRESSION_XZ_UNSUPPORTED_FILTER', 'XZ filter chain missing LZMA2', {
      algorithm: 'xz',
      context: {
        filterChain: chain,
        requiredLastFilter: formatFilterId(LZMA2_FILTER_ID),
        supportedFilters: SUPPORTED_FILTERS
      }
    });
  }

  return { lzma2Props };
}

export function createFilterChain(filters: FilterSpec[], output: ByteSink): ByteSink {
  let sink: ByteSink = output;
  for (let i = 0; i < filters.length; i += 1) {
    const filter = filters[i]!;
    if (filter.id === DELTA_FILTER_ID) {
      const distance = parseDeltaDistance(filter.props);
      sink = new DeltaFilter(sink, distance);
      continue;
    }
    if (filter.id === X86_FILTER_ID) {
      const startOffset = parseBcjStartOffset(filter.id, filter.props);
      sink = new X86Filter(sink, startOffset);
      continue;
    }
    if (filter.id === POWERPC_FILTER_ID) {
      const startOffset = parseBcjStartOffset(filter.id, filter.props);
      sink = new SimpleBcjFilter(sink, startOffset, bcjPowerpc);
      continue;
    }
    if (filter.id === IA64_FILTER_ID) {
      const startOffset = parseBcjStartOffset(filter.id, filter.props);
      sink = new SimpleBcjFilter(sink, startOffset, bcjIa64);
      continue;
    }
    if (filter.id === ARM_FILTER_ID) {
      const startOffset = parseBcjStartOffset(filter.id, filter.props);
      sink = new SimpleBcjFilter(sink, startOffset, bcjArm);
      continue;
    }
    if (filter.id === ARMTHUMB_FILTER_ID) {
      const startOffset = parseBcjStartOffset(filter.id, filter.props);
      sink = new SimpleBcjFilter(sink, startOffset, bcjArmThumb);
      continue;
    }
    if (filter.id === SPARC_FILTER_ID) {
      const startOffset = parseBcjStartOffset(filter.id, filter.props);
      sink = new SimpleBcjFilter(sink, startOffset, bcjSparc);
      continue;
    }
    if (filter.id === ARM64_FILTER_ID) {
      const startOffset = parseBcjStartOffset(filter.id, filter.props);
      sink = new SimpleBcjFilter(sink, startOffset, bcjArm64);
      continue;
    }
    if (filter.id === RISCV_FILTER_ID) {
      const startOffset = parseBcjStartOffset(filter.id, filter.props);
      sink = new SimpleBcjFilter(sink, startOffset, bcjRiscv);
      continue;
    }
    throw new CompressionError('COMPRESSION_XZ_UNSUPPORTED_FILTER', `XZ filter ${filter.id.toString(16)} unsupported`, {
      algorithm: 'xz',
      context: {
        filterId: formatFilterId(filter.id),
        supportedFilters: SUPPORTED_FILTERS
      }
    });
  }
  return sink;
}

function parseDeltaDistance(props: Uint8Array): number {
  if (props.length !== 1) {
    throw xzBadData('Invalid delta filter properties');
  }
  const distance = props[0]! + 1;
  if (distance < 1 || distance > 256) {
    throw xzBadData('Invalid delta filter distance');
  }
  return distance;
}

function parseBcjStartOffset(filterId: bigint, props: Uint8Array): number {
  if (props.length === 0) return 0;
  if (props.length !== 4) {
    throw xzBadData('Invalid BCJ filter properties', {
      filterId: formatFilterId(filterId),
      propertyBytes: String(props.length),
      allowedPropertyBytes: '0,4'
    });
  }
  const startOffset = readUint32LE(props, 0) >>> 0;
  const alignment = bcjAlignment(filterId);
  if (!alignment) {
    throw unsupportedFilter(filterId, 0, formatFilterId(filterId));
  }
  if (startOffset % alignment !== 0) {
    throw xzBadData('XZ BCJ start offset must be aligned', {
      filterId: formatFilterId(filterId),
      requiredAlignment: String(alignment),
      startOffset: String(startOffset)
    });
  }
  return startOffset;
}

function bcjAlignment(filterId: bigint): number | null {
  const info = FILTER_LOOKUP.get(filterId);
  if (info?.kind !== 'bcj') return null;
  return info.alignment ?? null;
}

function formatFilterId(id: bigint): string {
  const hex = id.toString(16);
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  return `0x${padded}`;
}

function unsupportedFilter(filterId: bigint, index: number, chain: string): CompressionError {
  return new CompressionError('COMPRESSION_XZ_UNSUPPORTED_FILTER', `XZ filter ${formatFilterId(filterId)} unsupported`, {
    algorithm: 'xz',
    context: {
      filterId: formatFilterId(filterId),
      filterIndex: String(index),
      filterChain: chain,
      supportedFilters: SUPPORTED_FILTERS
    }
  });
}

function xzBadData(message: string, context?: Record<string, string>): CompressionError {
  return new CompressionError('COMPRESSION_XZ_BAD_DATA', message, { algorithm: 'xz', ...(context ? { context } : {}) });
}

function unsupportedFilterChain(message: string, context: Record<string, string>): CompressionError {
  return new CompressionError('COMPRESSION_XZ_UNSUPPORTED_FILTER', message, {
    algorithm: 'xz',
    context
  });
}

class DeltaFilter implements ByteSink {
  private readonly history = new Uint8Array(256);
  private pos = 0;

  constructor(
    private readonly downstream: ByteSink,
    private readonly distance: number
  ) {}

  writeByte(value: number): void {
    const index = (this.distance + this.pos) & 0xff;
    const out = (value + this.history[index]!) & 0xff;
    this.history[this.pos] = out;
    this.pos = (this.pos - 1) & 0xff;
    this.downstream.writeByte(out);
  }

  flush(): void {
    this.downstream.flush();
  }
}

class SimpleBcjFilter implements ByteSink {
  private buffer = new Uint8Array(0);
  private length = 0;
  private pos: number;

  constructor(
    private readonly downstream: ByteSink,
    startOffset: number,
    private readonly processFn: (buffer: Uint8Array, size: number, pos: number) => number
  ) {
    this.pos = startOffset >>> 0;
  }

  writeByte(value: number): void {
    this.ensureCapacity(this.length + 1);
    this.buffer[this.length++] = value;
    if (this.length >= FILTER_BUFFER_SIZE) {
      this.process(false);
    }
  }

  flush(): void {
    this.process(true);
    this.downstream.flush();
  }

  private ensureCapacity(target: number): void {
    if (this.buffer.length >= target) return;
    let size = this.buffer.length === 0 ? FILTER_BUFFER_SIZE : this.buffer.length;
    while (size < target) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  private process(final: boolean): void {
    if (this.length === 0) return;
    const processed = this.processFn(this.buffer, this.length, this.pos);
    if (processed > 0) {
      for (let i = 0; i < processed; i += 1) {
        this.downstream.writeByte(this.buffer[i]!);
      }
    }
    const remaining = this.length - processed;
    if (remaining > 0) {
      this.buffer.copyWithin(0, processed, this.length);
    }
    this.length = remaining;
    this.pos = (this.pos + processed) >>> 0;
    if (final && this.length > 0) {
      for (let i = 0; i < this.length; i += 1) {
        this.downstream.writeByte(this.buffer[i]!);
      }
      this.pos = (this.pos + this.length) >>> 0;
      this.length = 0;
    }
  }
}

const X86_ALLOWED_STATUS = [true, true, true, false, true, false, false, false];
const X86_MASK_TO_BIT = [0, 1, 2, 2, 3, 3, 3, 3];

class X86Filter implements ByteSink {
  private buffer = new Uint8Array(0);
  private length = 0;
  prevMask = 0;
  pos: number;

  constructor(
    private readonly downstream: ByteSink,
    startOffset: number
  ) {
    this.pos = startOffset >>> 0;
  }

  writeByte(value: number): void {
    this.ensureCapacity(this.length + 1);
    this.buffer[this.length++] = value;
    if (this.length >= FILTER_BUFFER_SIZE) {
      this.process(false);
    }
  }

  flush(): void {
    this.process(true);
    this.downstream.flush();
  }

  private ensureCapacity(target: number): void {
    if (this.buffer.length >= target) return;
    let size = this.buffer.length === 0 ? FILTER_BUFFER_SIZE : this.buffer.length;
    while (size < target) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  private process(final: boolean): void {
    if (this.length === 0) return;
    if (!final && this.length <= 4) return;
    const data = this.buffer.subarray(0, this.length);
    const processed = bcjX86(data, this.length, this);
    if (processed > 0) {
      for (let i = 0; i < processed; i += 1) {
        this.downstream.writeByte(data[i]!);
      }
    }
    const remaining = this.length - processed;
    if (remaining > 0) {
      this.buffer.copyWithin(0, processed, this.length);
    }
    this.length = remaining;
    if (final && this.length > 0) {
      for (let i = 0; i < this.length; i += 1) {
        this.downstream.writeByte(this.buffer[i]!);
      }
      this.pos = (this.pos + this.length) >>> 0;
      this.length = 0;
    }
  }
}

function bcjX86TestMsByte(byte: number): boolean {
  return byte === 0x00 || byte === 0xff;
}

function bcjX86(buffer: Uint8Array, size: number, state: X86Filter): number {
  if (size <= 4) return 0;
  const limit = size - 4;
  let i = 0;
  let prevPos = -1;
  let prevMask = state.prevMask >>> 0;
  for (i = 0; i < limit; i += 1) {
    if ((buffer[i]! & 0xfe) !== 0xe8) continue;
    const distance = i - prevPos;
    prevPos = distance;
    if (distance > 3) {
      prevMask = 0;
    } else {
      prevMask = (prevMask << (distance - 1)) & 7;
      if (prevMask !== 0) {
        const check = buffer[i + 4 - X86_MASK_TO_BIT[prevMask]!]!;
        if (!X86_ALLOWED_STATUS[prevMask]! || bcjX86TestMsByte(check)) {
          prevPos = i;
          prevMask = (prevMask << 1) | 1;
          continue;
        }
      }
    }
    prevPos = i;
    if (bcjX86TestMsByte(buffer[i + 4]!)) {
      let src = readUint32LE(buffer, i + 1);
      while (true) {
        let dest = (src - ((state.pos + i + 5) >>> 0)) >>> 0;
        if (prevMask === 0) {
          src = dest;
          break;
        }
        const j = X86_MASK_TO_BIT[prevMask]! * 8;
        const b = (dest >>> (24 - j)) & 0xff;
        if (!bcjX86TestMsByte(b)) {
          src = dest;
          break;
        }
        src = (dest ^ (((1 << (32 - j)) - 1) >>> 0)) >>> 0;
      }
      let dest = src >>> 0;
      dest &= 0x01ffffff;
      dest |= dest & 0x01000000 ? 0xff000000 : 0x00000000;
      writeUint32LE(buffer, i + 1, dest);
      i += 4;
    } else {
      prevMask = (prevMask << 1) | 1;
    }
  }
  const distance = i - prevPos;
  state.prevMask = distance > 3 ? 0 : (prevMask << (distance - 1)) & 0xff;
  state.pos = (state.pos + i) >>> 0;
  return i;
}

function bcjPowerpc(buffer: Uint8Array, size: number, pos: number): number {
  size &= ~3;
  for (let i = 0; i < size; i += 4) {
    if ((buffer[i]! >> 2) !== 0x12) continue;
    if ((buffer[i + 3]! & 0x03) !== 0x01) continue;
    const src =
      (((buffer[i]! & 0x03) << 24) |
        (buffer[i + 1]! << 16) |
        (buffer[i + 2]! << 8) |
        (buffer[i + 3]! & 0xfc)) >>>
      0;
    const dest = (src - ((pos + i) >>> 0)) >>> 0;
    buffer[i] = 0x48 | ((dest >>> 24) & 0x03);
    buffer[i + 1] = (dest >>> 16) & 0xff;
    buffer[i + 2] = (dest >>> 8) & 0xff;
    buffer[i + 3] = (buffer[i + 3]! & 0x03) | (dest & 0xfc);
  }
  return size;
}

function bcjArm(buffer: Uint8Array, size: number, pos: number): number {
  size &= ~3;
  for (let i = 0; i < size; i += 4) {
    if (buffer[i + 3] !== 0xeb) continue;
    let src = ((buffer[i + 2]! << 16) | (buffer[i + 1]! << 8) | buffer[i]!) >>> 0;
    src = (src << 2) >>> 0;
    let dest = (src - ((pos + i + 8) >>> 0)) >>> 0;
    dest = (dest >>> 2) >>> 0;
    buffer[i + 2] = (dest >>> 16) & 0xff;
    buffer[i + 1] = (dest >>> 8) & 0xff;
    buffer[i] = dest & 0xff;
  }
  return size;
}

function bcjArmThumb(buffer: Uint8Array, size: number, pos: number): number {
  if (size < 4) return 0;
  size -= 4;
  let i = 0;
  for (i = 0; i <= size; i += 2) {
    if ((buffer[i + 1]! & 0xf8) === 0xf0 && (buffer[i + 3]! & 0xf8) === 0xf8) {
      let src =
        (((buffer[i + 1]! & 0x07) << 19) |
          (buffer[i]! << 11) |
          ((buffer[i + 3]! & 0x07) << 8) |
          buffer[i + 2]!) >>>
        0;
      src = (src << 1) >>> 0;
      let dest = (src - ((pos + i + 4) >>> 0)) >>> 0;
      dest >>>= 1;
      buffer[i + 1] = 0xf0 | ((dest >>> 19) & 0x07);
      buffer[i] = (dest >>> 11) & 0xff;
      buffer[i + 3] = 0xf8 | ((dest >>> 8) & 0x07);
      buffer[i + 2] = dest & 0xff;
      i += 2;
    }
  }
  return i;
}

function bcjArm64(buffer: Uint8Array, size: number, pos: number): number {
  size &= ~3;
  for (let i = 0; i < size; i += 4) {
    const pc = (pos + i) >>> 0;
    let instr = read32le(buffer, i);
    if ((instr >>> 26) === 0x25) {
      const src = instr;
      instr = 0x94000000;
      let pcRel = pc >>> 2;
      pcRel = (0 - pcRel) >>> 0;
      instr |= (src + pcRel) & 0x03ffffff;
      write32le(buffer, i, instr >>> 0);
      continue;
    }
    if ((instr & 0x9f000000) === 0x90000000) {
      const src = ((instr >>> 29) & 3) | ((instr >>> 3) & 0x001ffffc);
      if ((src + 0x00020000) & 0x001c0000) continue;
      instr &= 0x9000001f;
      let pcRel = pc >>> 12;
      pcRel = (0 - pcRel) >>> 0;
      const dest = (src + pcRel) >>> 0;
      instr |= (dest & 3) << 29;
      instr |= (dest & 0x0003fffc) << 3;
      instr |= (0 - (dest & 0x00020000)) & 0x00e00000;
      write32le(buffer, i, instr >>> 0);
    }
  }
  return size;
}

function bcjRiscv(buffer: Uint8Array, size: number, pos: number): number {
  if (size < 8) return 0;
  size -= 8;
  let i = 0;
  for (i = 0; i <= size; i += 2) {
    let inst = buffer[i]!;
    if (inst === 0xef) {
      const b1 = buffer[i + 1]!;
      if ((b1 & 0x0d) !== 0) continue;
      const b2 = buffer[i + 2]!;
      const b3 = buffer[i + 3]!;
      const pc = (pos + i) >>> 0;
      let addr = ((b1 & 0xf0) << 13) | (b2 << 9) | (b3 << 1);
      addr = (addr - pc) >>> 0;
      buffer[i + 1] = (b1 & 0x0f) | ((addr >> 8) & 0xf0);
      buffer[i + 2] = ((addr >> 16) & 0x0f) | ((addr >> 7) & 0x10) | ((addr << 4) & 0xe0);
      buffer[i + 3] = ((addr >> 4) & 0x7f) | ((addr >> 13) & 0x80);
      i += 2;
      continue;
    }
    if ((inst & 0x7f) === 0x17) {
      inst |= buffer[i + 1]! << 8;
      inst |= buffer[i + 2]! << 16;
      inst |= buffer[i + 3]! << 24;
      let inst2: number;
      if (inst & 0x0e80) {
        inst2 = read32le(buffer, i + 4);
        if (notAuipcPair(inst, inst2)) {
          i += 4;
          continue;
        }
        let addr = inst & 0xfffff000;
        addr = (addr + (inst2 >>> 20)) >>> 0;
        inst = 0x17 | (2 << 7) | (inst2 << 12);
        inst2 = addr >>> 0;
      } else {
        const inst2Rs1 = inst >>> 27;
        if (notSpecialAuipc(inst, inst2Rs1)) {
          i += 2;
          continue;
        }
        let addr = read32be(buffer, i + 4);
        addr = (addr - ((pos + i) >>> 0)) >>> 0;
        inst2 = (inst >>> 12) | (addr << 20);
        inst = 0x17 | (inst2Rs1 << 7) | ((addr + 0x800) & 0xfffff000);
      }
      write32le(buffer, i, inst >>> 0);
      write32le(buffer, i + 4, inst2 >>> 0);
      i += 6;
    }
  }
  return i;
}

function bcjSparc(buffer: Uint8Array, size: number, pos: number): number {
  size &= ~3;
  for (let i = 0; i < size; i += 4) {
    const b0 = buffer[i]!;
    const b1 = buffer[i + 1]!;
    if ((b0 === 0x40 && (b1 & 0xc0) === 0x00) || (b0 === 0x7f && (b1 & 0xc0) === 0xc0)) {
      let src = ((b0 << 24) | (b1 << 16) | (buffer[i + 2]! << 8) | buffer[i + 3]!) >>> 0;
      src = (src << 2) >>> 0;
      let dest = (src - ((pos + i) >>> 0)) >>> 0;
      dest = (dest >>> 2) >>> 0;
      dest =
        (((0 - ((dest >>> 22) & 1)) << 22) & 0x3fffffff) | (dest & 0x3fffff) | 0x40000000;
      buffer[i] = (dest >>> 24) & 0xff;
      buffer[i + 1] = (dest >>> 16) & 0xff;
      buffer[i + 2] = (dest >>> 8) & 0xff;
      buffer[i + 3] = dest & 0xff;
    }
  }
  return size;
}

const IA64_BRANCH_TABLE = [
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  4, 4, 6, 6, 0, 0, 7, 7,
  4, 4, 0, 0, 4, 4, 0, 0
];

function bcjIa64(buffer: Uint8Array, size: number, pos: number): number {
  size &= ~15;
  for (let i = 0; i < size; i += 16) {
    const template = buffer[i]! & 0x1f;
    const mask = IA64_BRANCH_TABLE[template] ?? 0;
    let bitPos = 5;
    for (let slot = 0; slot < 3; slot += 1, bitPos += 41) {
      if (((mask >> slot) & 1) === 0) continue;
      const bytePos = bitPos >> 3;
      const bitRes = bitPos & 0x7;
      let instruction = 0n;
      for (let j = 0; j < 6; j += 1) {
        instruction |= BigInt(buffer[i + bytePos + j]!) << BigInt(8 * j);
      }
      let instNorm = instruction >> BigInt(bitRes);
      if (((instNorm >> 37n) & 0xfn) === 0x5n && ((instNorm >> 9n) & 0x7n) === 0n) {
        let src = Number((instNorm >> 13n) & 0xfffffn);
        src |= Number((instNorm >> 36n) & 0x1n) << 20;
        src = (src << 4) >>> 0;
        let dest = (src - ((pos + i) >>> 0)) >>> 0;
        dest >>>= 4;
        instNorm &= ~(0x8fffffn << 13n);
        instNorm |= BigInt(dest & 0xfffff) << 13n;
        instNorm |= BigInt(dest & 0x100000) << 16n;
        const lowMask = (1n << BigInt(bitRes)) - 1n;
        instruction &= lowMask;
        instruction |= instNorm << BigInt(bitRes);
        for (let j = 0; j < 6; j += 1) {
          buffer[i + bytePos + j] = Number((instruction >> BigInt(8 * j)) & 0xffn);
        }
      }
    }
  }
  return size;
}

function notAuipcPair(auipc: number, inst2: number): boolean {
  return (((auipc << 8) ^ ((inst2 - 3) >>> 0)) & 0xf8003) !== 0;
}

function notSpecialAuipc(auipc: number, inst2Rs1: number): boolean {
  const left = (((auipc - 0x3117) >>> 0) << 18) >>> 0;
  return left >= (inst2Rs1 & 0x1d);
}

function read32le(buffer: Uint8Array, offset: number): number {
  return (
    buffer[offset]! |
    (buffer[offset + 1]! << 8) |
    (buffer[offset + 2]! << 16) |
    (buffer[offset + 3]! << 24)
  ) >>> 0;
}

function read32be(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset]! << 24) |
    (buffer[offset + 1]! << 16) |
    (buffer[offset + 2]! << 8) |
    buffer[offset + 3]!
  ) >>> 0;
}

function write32le(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}
