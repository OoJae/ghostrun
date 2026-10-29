// Share links, abuse reports and "This is wrong" captures, kept in R2 (binding SHARES) behind
// BlobStore. A share is content-addressed: id = base32(sha256(canonical record))[:16], so a run
// always gets the same link and a stored record is never overwritten. Input frames are stored
// run-length + delta encoded: a key held for two seconds is one run, not 120 frames.
// A remix's share also says where it came from: remixOf (a share id, or g:<slug> for a gallery
// world), the original at the top of its line (prompt and spec), and the newest changes on the way.
import { jcs, nickname } from "@ghostrun/ir";
import type { InputFrame } from "@ghostrun/sim";
import * as v from "valibot";
import type { R2Bucket } from "./cf";
import { base32, type Caller } from "./gate";
import { json, readJson } from "./http";

export const MAX_FILL_BYTES = 64 * 1024;
export const MAX_FRAMES = 36_000;
export const MAX_SHARE_BODY = 2 * 1024 * 1024;
const MAX_REPORT_BODY = 8 * 1024;
const MAX_TICK = 2 ** 24;
export const SHARE_ID = /^[a-z2-7]{16}$/;
/** The changes a remix's share keeps (the newest), and how long a prompt or a change may be. */
export const MAX_LINEAGE = 8;
export const MAX_REMIX_TEXT = 300;

const enc = new TextEncoder();
const Hex64 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const int = (min: number, max: number) => v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max));
const Text500 = v.pipe(v.string(), v.maxLength(500));
const Frame = v.strictObject({ tick: int(0, MAX_TICK), wx: int(-127, 127), wz: int(-127, 127), btn: int(0, 255) });
/** Sparse frames are fine (a frame may hold until the next); ticks must strictly increase. */
const Frames = v.pipe(
  v.array(Frame),
  v.maxLength(MAX_FRAMES),
  v.check((fs) => fs.every((f, i) => i === 0 || f.tick > fs[i - 1]!.tick), "ticks must strictly increase"),
);

/** NPC mind choices, applied at their ticks (so a run with live minds still replays exactly). */
const Minds = v.pipe(
  v.array(v.strictObject({ tick: int(0, MAX_TICK), npc: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,31}$/)), option: v.pipe(v.string(), v.regex(/^[\w.:-]{1,48}$/)) })),
  v.maxLength(500),
);

/** A world a remix came from: a share, or a gallery world by its slug. */
const Ref = v.pipe(v.string(), v.regex(/^(?:[a-z2-7]{16}|g:[a-z0-9-]{1,64})$/));
/** A prompt or a change as the person wrote it: one line, not blank, not long. */
const Said = (min: number) =>
  v.pipe(
    v.string(),
    v.maxLength(MAX_REMIX_TEXT),
    v.check((s) => !/[\u0000-\u001f\u007f]/.test(s), "no control characters"),
    v.check((s) => s.trim().length >= min, "blank"),
  );
/** One change in a remix's line: the world it was made on, who made it (a board-safe nickname), and what they asked. */
const Step = v.strictObject({
  id: Ref,
  change: Said(1),
  name: v.optional(
    v.pipe(
      v.string(),
      v.check((n) => {
        const k = nickname(n);
        return k.ok && k.name === n;
      }, "not a nickname"),
    ),
  ),
});

export const ShareIn = v.pipe(
  v.strictObject({
    v: v.literal(1),
    engine: Hex64,
    specHash: Hex64,
    seed: int(-(2 ** 31), 2 ** 32 - 1),
    fill: v.pipe(v.string(), v.check((s) => enc.encode(s).length <= MAX_FILL_BYTES, "fill over 64 KB")),
    inputs: Frames,
    minds: v.optional(Minds),
    /** The prompt the world was built from (a remix of it shows it). */
    prompt: v.optional(Said(0)),
    remixOf: v.optional(Ref),
    /** The world at the top of the line: what was asked for, and its spec (what its own receipt proved). */
    origin: v.optional(v.strictObject({ id: Ref, prompt: Said(0), spec: Hex64 })),
    /** The newest changes, oldest first; `changes` counts every one since the original. */
    lineage: v.optional(v.pipe(v.array(Step), v.minLength(1), v.maxLength(MAX_LINEAGE))),
    changes: v.optional(int(1, 9999)),
  }),
  v.check((s) => {
    const parts = [s.remixOf, s.origin, s.lineage, s.changes].filter((x) => x !== undefined).length;
    if (parts === 0) return true;
    // all four together, the newest change made on the world it says it remixed, and a count that covers the list
    const steps = s.lineage ?? [];
    const n = s.changes ?? 0;
    return parts === 4 && steps.at(-1)?.id === s.remixOf && n >= steps.length && (n > steps.length || steps[0]?.id === s.origin?.id);
  }, "a remix needs remixOf, origin, lineage and changes, and they must agree"),
);
export type ShareIn = v.InferOutput<typeof ShareIn>;

export const ReportIn = v.pipe(
  v.strictObject({
    shareId: v.optional(v.pipe(v.string(), v.regex(SHARE_ID))),
    specHash: v.optional(Hex64),
    reason: v.picklist(["offensive", "unsafe", "broken", "copyright", "spam", "other"]),
    text: v.optional(Text500, ""),
  }),
  v.check((r) => r.shareId !== undefined || r.specHash !== undefined, "shareId or specHash required"),
);

export const WrongIn = v.strictObject({
  specHash: Hex64,
  chipId: v.optional(v.pipe(v.string(), v.regex(/^[\w.:-]{1,64}$/))),
  note: v.optional(Text500, ""),
  inputs: v.optional(Frames),
});

function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Runs of identical input on consecutive ticks → [Δtick varint][wx i8][wz i8][btn u8][more frames varint]. */
export function packFrames(fs: readonly InputFrame[]): string {
  const out: number[] = [];
  const varint = (n: number) => {
    for (; n > 127; n = Math.floor(n / 128)) out.push((n & 127) | 128);
    out.push(n);
  };
  let prev = -1;
  for (let i = 0; i < fs.length; ) {
    const f = fs[i]!;
    let j = i + 1;
    while (j < fs.length && fs[j]!.tick === fs[j - 1]!.tick + 1 && fs[j]!.wx === f.wx && fs[j]!.wz === f.wz && fs[j]!.btn === f.btn) j++;
    varint(f.tick - prev);
    out.push(f.wx & 255, f.wz & 255, f.btn);
    varint(j - i - 1);
    prev = fs[j - 1]!.tick;
    i = j;
  }
  return b64(new Uint8Array(out));
}

export function unpackFrames(s: string): InputFrame[] {
  const b = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const fs: InputFrame[] = [];
  let p = 0;
  const byte = () => {
    const x = b[p++];
    if (x === undefined) throw new Error("truncated frames");
    return x;
  };
  const varint = () => {
    let n = 0;
    for (let mul = 1, x = byte(); mul < 2 ** 35; mul *= 128, x = byte()) {
      n += (x & 127) * mul;
      if (!(x & 128)) return n;
    }
    throw new Error("bad varint");
  };
  let tick = -1;
  while (p < b.length) {
    tick += varint();
    const wx = (byte() << 24) >> 24;
    const wz = (byte() << 24) >> 24;
    const btn = byte();
    const more = varint();
    if (fs.length + more >= MAX_FRAMES) throw new Error("too many frames");
    for (let k = 0; k <= more; k++) fs.push({ tick: tick + k, wx, wz, btn });
    tick += more;
  }
  return fs;
}

/** The stored (canonical) form of a share and its content address. */
export async function shareRecord(s: ShareIn): Promise<{ id: string; text: string }> {
  // minds, the prompt and a remix's line only when present, so runs without them keep the ids they always had
  const remix = s.lineage ? { remixOf: s.remixOf, origin: s.origin, lineage: s.lineage, changes: s.changes } : {};
  const text = jcs({ v: 1, engine: s.engine, specHash: s.specHash, seed: s.seed, fill: s.fill, enc: "rle1", inputs: packFrames(s.inputs), ...(s.minds?.length ? { minds: s.minds } : {}), ...(s.prompt ? { prompt: s.prompt } : {}), ...remix });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return { id: base32(digest.subarray(0, 10)), text };
}

export interface BlobStore {
  get(key: string): Promise<string | null>;
  has(key: string): Promise<boolean>;
  /** `meta` rides along as small string metadata a listing returns without reading the body. */
  put(key: string, body: string, meta?: Record<string, string>): Promise<void>;
  /** Up to `limit` keys under a prefix, in key order, with their metadata. */
  list(prefix: string, limit: number): Promise<{ key: string; meta: Record<string, string> }[]>;
}

export function r2Blobs(bucket: R2Bucket): BlobStore {
  return {
    async get(key) {
      const o = await bucket.get(key);
      return o ? o.text() : null;
    },
    async has(key) {
      return (await bucket.head(key)) !== null;
    },
    async put(key, body, meta) {
      await bucket.put(key, body, { httpMetadata: { contentType: "application/json" }, ...(meta ? { customMetadata: meta } : {}) });
    },
    async list(prefix, limit) {
      const r = await bucket.list({ prefix, limit, include: ["customMetadata"] });
      return r.objects.map((o) => ({ key: o.key, meta: o.customMetadata ?? {} }));
    },
  };
}

export function memoryBlobs(): BlobStore & { keys(): string[] } {
  const m = new Map<string, { body: string; meta: Record<string, string> }>();
  return {
    get: async (k) => m.get(k)?.body ?? null,
    has: async (k) => m.has(k),
    put: async (k, body, meta = {}) => void m.set(k, { body, meta }),
    list: async (prefix, limit) =>
      [...m.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((key) => ({ key, meta: m.get(key)!.meta })),
    keys: () => [...m.keys()],
  };
}

export interface ShareCtx {
  store: BlobStore;
  caller: Caller;
  /** Keyed hash of the client IP. */
  ip: string;
  notify(title: string, body: string): void;
}

const issues = (is: readonly v.BaseIssue<unknown>[]) => is.slice(0, 5).map((i) => `${v.getDotPath(i) ?? "body"}: ${i.message}`);
const stamp = () => `${new Date().toISOString().slice(0, 10)}/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
export const who = (c: ShareCtx) => ({ at: new Date().toISOString(), pool: c.caller.pool, via: c.caller.via, ...(c.caller.session ? { session: c.caller.session } : {}), ip: c.ip });

export async function postShare(req: Request, c: ShareCtx): Promise<Response> {
  const body = await readJson(req, MAX_SHARE_BODY);
  if (!body.ok) return json({ error: body.error }, body.status);
  const r = v.safeParse(ShareIn, body.value);
  if (!r.success) return json({ error: "invalid share", issues: issues(r.issues) }, 400);
  const { id, text } = await shareRecord(r.output);
  const key = `shares/${id}.json`;
  const created = !(await c.store.has(key));
  if (created) await c.store.put(key, text);
  return json({ id, created }, created ? 201 : 200);
}

export async function getShare(id: string, c: ShareCtx): Promise<Response> {
  const text = await c.store.get(`shares/${id}.json`);
  if (text === null) return json({ error: "not found" }, 404);
  const s = JSON.parse(text) as Omit<ShareIn, "inputs"> & { inputs: string };
  const remix = s.lineage ? { remixOf: s.remixOf, origin: s.origin, lineage: s.lineage, changes: s.changes } : {};
  const record = { id, v: s.v, engine: s.engine, specHash: s.specHash, seed: s.seed, fill: s.fill, inputs: unpackFrames(s.inputs), minds: s.minds ?? [], ...(s.prompt ? { prompt: s.prompt } : {}), ...remix };
  return json(record, 200, { "cache-control": "private, max-age=31536000, immutable" });
}

export async function postReport(req: Request, c: ShareCtx): Promise<Response> {
  const body = await readJson(req, MAX_REPORT_BODY);
  if (!body.ok) return json({ error: body.error }, body.status);
  const r = v.safeParse(ReportIn, body.value);
  if (!r.success) return json({ error: "invalid report", issues: issues(r.issues) }, 400);
  const id = stamp();
  await c.store.put(`reports/${id}.json`, jcs({ ...r.output, ...who(c) }));
  const target = r.output.shareId ? `share ${r.output.shareId}` : `spec ${r.output.specHash!.slice(0, 12)}`;
  c.notify(`GHOSTRUN report: ${r.output.reason}`, `${target}: ${r.output.text.slice(0, 200)}`);
  return json({ ok: true, id }, 201);
}

export async function postWrong(req: Request, c: ShareCtx): Promise<Response> {
  const body = await readJson(req, MAX_SHARE_BODY);
  if (!body.ok) return json({ error: body.error }, body.status);
  const r = v.safeParse(WrongIn, body.value);
  if (!r.success) return json({ error: "invalid capture", issues: issues(r.issues) }, 400);
  const { inputs, ...rest } = r.output;
  const id = stamp();
  await c.store.put(`wrong/${id}.json`, jcs({ ...rest, ...(inputs ? { enc: "rle1", inputs: packFrames(inputs) } : {}), ...who(c) }));
  return json({ ok: true, id }, 201);
}
