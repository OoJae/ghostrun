// WebM segments joined into one clip, in the browser. MediaRecorder writes each segment as a file
// of its own (two files back to back don't play as one), so each is read back to its blocks and
// they are written out again as a single file: laid end to end, started on a video keyframe (a
// decoder can start nowhere else) so that it holds the last `wantMs`, and with its duration set so
// players can seek it. Only what MediaRecorder writes is read: SimpleBlocks or BlockGroups in
// clusters of known or unknown size. No runtime imports: the unit tests run it in Node.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  SeekHead: 0x114d9b74,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
} as const;

/** What can follow a cluster in a segment: an unknown-size cluster ends where one of these starts. */
const TOP: ReadonlySet<number> = new Set([ID.Cluster, ID.Cues, ID.Tags, ID.Info, ID.Tracks, ID.SeekHead, ID.Chapters, ID.Attachments]);
const VIDEO = 1;
/** A new cluster at least this often (a block's time in its cluster is 16 bits of ticks). */
const CLUSTER_MS = 5000;

/** One coded frame: its track, its time in the segment (in the file's ticks), and its bytes after the flags. */
export interface Block {
  track: number;
  t: number;
  key: boolean;
  /** The SimpleBlock flags (lacing, invisible, discardable), the keyframe bit aside. */
  flags: number;
  payload: Uint8Array;
}

/** One segment, read back. */
export interface Segment {
  /** The EBML header, as written (its DocType is kept). */
  ebml: Uint8Array;
  /** Nanoseconds per tick (1 ms in what browsers write). */
  scale: number;
  /** The Tracks element, as written. */
  tracks: Uint8Array;
  /** Each track's number, type, codec and codec setup: segments join only when theirs match. */
  sig: string;
  video: number | null;
  blocks: Block[];
}

interface El {
  id: number;
  start: number;
  data: number;
  end: number;
  unknown: boolean;
  /** The file stops before the element does (a recording cut short). */
  short: boolean;
}

function readId(b: Uint8Array, at: number): [number, number] | null {
  const b0 = b[at];
  if (b0 === undefined || b0 === 0) return null;
  const len = Math.clz32(b0) - 23;
  if (len > 4 || at + len > b.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[at + i]!;
  return [v, len];
}

/** A size: its value (−1 for "unknown", as live recorders write) and how many bytes it took. */
function readSize(b: Uint8Array, at: number): [number, number] | null {
  const b0 = b[at];
  if (b0 === undefined || b0 === 0) return null;
  const len = Math.clz32(b0) - 23;
  if (at + len > b.length) return null;
  let v = b0 & (0xff >> len);
  let ones = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    const x = b[at + i]!;
    v = v * 256 + x;
    ones &&= x === 0xff;
  }
  return [ones ? -1 : v, len];
}

function head(b: Uint8Array, at: number, end: number): El | null {
  const id = readId(b, at);
  if (!id) return null;
  const size = readSize(b, at + id[1]);
  if (!size) return null;
  const data = at + id[1] + size[1];
  if (data > end) return null;
  const unknown = size[0] < 0;
  const stop = unknown ? end : data + size[0];
  return { id: id[0], start: at, data, end: Math.min(stop, end), unknown, short: stop > end };
}

function uintOf(b: Uint8Array, e: El): number {
  let v = 0;
  for (let i = e.data; i < e.end; i++) v = v * 256 + b[i]!;
  return v;
}

function children(b: Uint8Array, e: El): El[] {
  const out: El[] = [];
  for (let at = e.data; at < e.end; ) {
    const c = head(b, at, e.end);
    if (!c) break;
    out.push(c);
    at = c.end;
  }
  return out;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Read one segment's blocks (null when it isn't a WebM file at all). A cut-short tail is dropped. */
export function readWebm(b: Uint8Array): Segment | null {
  const ebml = head(b, 0, b.length);
  if (!ebml || ebml.id !== ID.EBML || ebml.short) return null;
  const seg = head(b, ebml.end, b.length);
  if (!seg || seg.id !== ID.Segment) return null;
  const out: Segment = { ebml: b.subarray(ebml.start, ebml.end), scale: 1_000_000, tracks: new Uint8Array(0), sig: "", video: null, blocks: [] };
  const types = new Map<number, number>();
  for (let at = seg.data; at < seg.end; ) {
    const e = head(b, at, seg.end);
    if (!e) break;
    if (e.id === ID.Cluster) {
      at = cluster(b, e, out, types);
      if (at < 0) break;
      continue;
    }
    if (e.short || e.unknown) break;
    if (e.id === ID.Info) {
      const s = children(b, e).find((c) => c.id === ID.TimecodeScale);
      if (s) out.scale = uintOf(b, s);
    } else if (e.id === ID.Tracks) {
      out.tracks = b.subarray(e.start, e.end);
      const sig: string[] = [];
      for (const t of children(b, e).filter((c) => c.id === ID.TrackEntry)) {
        const f = children(b, t);
        const num = f.find((c) => c.id === ID.TrackNumber);
        const type = f.find((c) => c.id === ID.TrackType);
        const codec = f.find((c) => c.id === ID.CodecID);
        const setup = f.find((c) => c.id === ID.CodecPrivate);
        const n = num ? uintOf(b, num) : 0;
        types.set(n, type ? uintOf(b, type) : 0);
        sig.push(`${n}:${types.get(n)}:${codec ? new TextDecoder().decode(b.subarray(codec.data, codec.end)) : ""}:${setup ? hex(b.subarray(setup.data, setup.end)) : ""}`);
      }
      out.sig = sig.join("|");
      out.video = [...types].find(([, t]) => t === VIDEO)?.[0] ?? null;
    }
    at = e.end;
  }
  return out.tracks.length ? out : null;
}

/** One cluster's blocks into `out`; returns where the next element starts (−1: the file ends here). */
function cluster(b: Uint8Array, e: El, out: Segment, types: Map<number, number>): number {
  let t0 = 0;
  let at = e.data;
  while (at < e.end) {
    const c = head(b, at, e.end);
    if (!c || c.short) return -1;
    if (e.unknown && TOP.has(c.id)) return at; // the next cluster (or the cues) begins
    if (c.id === ID.Timecode) t0 = uintOf(b, c);
    else if (c.id === ID.SimpleBlock) block(b, c.data, c.end, t0, null, out, types);
    else if (c.id === ID.BlockGroup) {
      const f = children(b, c);
      const inner = f.find((x) => x.id === ID.Block);
      if (inner) block(b, inner.data, inner.end, t0, !f.some((x) => x.id === ID.ReferenceBlock), out, types);
    }
    at = c.end;
  }
  return e.short ? -1 : at;
}

function block(b: Uint8Array, from: number, to: number, t0: number, key: boolean | null, out: Segment, types: Map<number, number>) {
  const tn = readSize(b, from);
  if (!tn || from + tn[1] + 3 > to) return;
  const at = from + tn[1];
  const rel = ((b[at]! << 8) | b[at + 1]!) << 16 >> 16; // signed
  const flags = b[at + 2]!;
  // a BlockGroup's frame is a keyframe when nothing references it; a video SimpleBlock says so in its flags
  const isKey = key ?? (types.get(tn[0]) === VIDEO ? (flags & 0x80) !== 0 : true);
  out.blocks.push({ track: tn[0], t: t0 + rel, key: isKey, flags: flags & 0x0f, payload: b.subarray(at + 3, to) });
}

// ---- writing --------------------------------------------------------------------------------

function idBytes(id: number): number[] {
  const a: number[] = [];
  for (let x = id; x > 0; x = Math.floor(x / 256)) a.unshift(x & 0xff);
  return a;
}

/** The shortest size that holds n (all ones is "unknown", so it is never used for a value). */
function sizeBytes(n: number): number[] {
  for (let len = 1; len <= 8; len++) {
    if (n >= 2 ** (7 * len) - 1) continue;
    const a: number[] = new Array<number>(len).fill(0);
    let x = n;
    for (let i = len - 1; i >= 0; i--) ((a[i] = x % 256), (x = Math.floor(x / 256)));
    a[0] = a[0]! | (0x80 >> (len - 1));
    return a;
  }
  throw new RangeError("element too large");
}

export function cat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

export function el(id: number, body: Uint8Array | readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const data = body instanceof Uint8Array ? body : cat(body);
  return cat([Uint8Array.from(idBytes(id)), Uint8Array.from(sizeBytes(data.length)), data]);
}

export function uint(id: number, v: number): Uint8Array {
  const a: number[] = [];
  for (let x = Math.max(0, Math.round(v)); a.length === 0 || x > 0; x = Math.floor(x / 256)) a.unshift(x % 256);
  return el(id, Uint8Array.from(a));
}

function float(id: number, v: number): Uint8Array {
  const d = new Uint8Array(8);
  new DataView(d.buffer).setFloat64(0, v);
  return el(id, d);
}

const str = (id: number, s: string) => el(id, new TextEncoder().encode(s));

export function simpleBlock(track: number, rel: number, flags: number, payload: Uint8Array): Uint8Array {
  const h = [...sizeBytes(track), (rel >> 8) & 0xff, rel & 0xff, flags];
  return el(ID.SimpleBlock, [Uint8Array.from(h), payload]);
}

export { ID as WEBM_ID };

/**
 * Join segments recorded one after another into one file holding the last `wantMs` (Infinity:
 * all of it). Only the newest run of segments whose tracks match is used (a segment recorded with
 * sound and one without can't share a file). Null when there is nothing to play.
 */
export function joinWebm(parts: readonly Segment[], wantMs: number, frameMs = 1000 / 30): { bytes: Uint8Array<ArrayBuffer>; ms: number } | null {
  let first = parts.length - 1;
  while (first > 0 && parts[first - 1]!.sig === parts[first]!.sig && parts[first - 1]!.scale === parts[first]!.scale) first--;
  const run = parts.slice(first).filter((p) => p.blocks.length > 0);
  const base = run[0];
  if (!base) return null;
  const perMs = 1_000_000 / base.scale;
  const gap = Math.max(1, Math.round(frameMs * perMs));
  // end to end: each segment starts a frame after the one before it ends
  const all: Block[] = [];
  let offset = 0;
  for (const p of run) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of p.blocks) ((lo = Math.min(lo, x.t)), (hi = Math.max(hi, x.t)));
    for (const x of p.blocks) all.push({ ...x, t: offset + x.t - lo });
    offset += hi - lo + gap;
  }
  const video = base.video;
  const end = all.reduce((m, x) => Math.max(m, x.t), 0);
  const keys = all.filter((x) => x.key && (video === null || x.track === video));
  const target = end - wantMs * perMs;
  const start = keys.filter((x) => x.t <= target).at(-1)?.t ?? keys[0]?.t ?? 0;
  const clusters: Uint8Array[] = [];
  let blocks: Uint8Array[] = [];
  let ct = 0;
  const flush = () => blocks.length && clusters.push(el(ID.Cluster, [uint(ID.Timecode, ct), ...blocks]));
  // each track's times only go forward: Chrome stamps a new recording's first two frames alike
  const last = new Map<number, number>();
  for (const x of all) {
    if (x.t < start) continue;
    const t = Math.max(x.t - start, (last.get(x.track) ?? -1) + 1);
    last.set(x.track, t);
    const fresh = !blocks.length || (x.key && x.track === video) || t - ct > CLUSTER_MS * perMs || t - ct < -30_000;
    if (fresh) (flush(), (blocks = []), (ct = Math.max(0, t)));
    blocks.push(simpleBlock(x.track, t - ct, x.flags | (x.key ? 0x80 : 0), x.payload));
  }
  flush();
  if (!clusters.length) return null;
  const ticks = Math.max(end - start, ...last.values()) + gap;
  const info = el(ID.Info, [uint(ID.TimecodeScale, base.scale), str(ID.MuxingApp, "ghostrun"), str(ID.WritingApp, "ghostrun clip"), float(ID.Duration, ticks)]);
  return { bytes: cat([base.ebml, el(ID.Segment, [info, base.tracks, ...clusters])]), ms: ticks / perMs };
}
