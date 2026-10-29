// Best times per world, keyed by its spec hash, kept beside the shares in R2. An entry is a stored
// run (a share) plus the tick it claims to win on and an optional nickname. Its key sorts by time
// (boards/<spec>/<ticks, 6 digits>-<share id>), so the board is one listing, never a read-modify-
// write two posts could race. The edge checks what it can without a simulation: the run exists, is
// of this world, and its inputs end on the claimed tick. Whether it really wins there is checked
// by replaying it, on the device that shows the board, and labelled as such (apps/web/src/rivals.ts).
import { jcs, nickname } from "@ghostrun/ir";
import * as v from "valibot";
import { json, readJson } from "./http";
import { MAX_FRAMES, SHARE_ID, unpackFrames, who, type BlobStore, type ShareCtx } from "./share";

/** The ten fastest are shown. */
export const BOARD_SIZE = 10;
const MAX_BOARD_BODY = 1024;

export const BoardIn = v.strictObject({
  specHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  shareId: v.pipe(v.string(), v.regex(SHARE_ID)),
  ticks: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_FRAMES)),
  name: v.optional(v.pipe(v.string(), v.maxLength(64))),
});

export interface BoardEntry {
  shareId: string;
  ticks: number;
  name: string;
}

const keyOf = (spec: string, ticks: number, id: string) => `boards/${spec}/${String(ticks).padStart(6, "0")}-${id}`;
const ENTRY = /\/(\d{6})-([a-z2-7]{16})$/;

export async function readBoard(spec: string, store: BlobStore): Promise<BoardEntry[]> {
  const rows = await store.list(`boards/${spec}/`, BOARD_SIZE);
  return rows.flatMap((r) => {
    const m = ENTRY.exec(r.key);
    return m ? [{ shareId: m[2]!, ticks: Number(m[1]), name: r.meta.name ?? "" }] : [];
  });
}

export async function getBoard(spec: string, c: ShareCtx): Promise<Response> {
  return json({ entries: await readBoard(spec, c.store) });
}

export async function postBoard(req: Request, c: ShareCtx): Promise<Response> {
  const body = await readJson(req, MAX_BOARD_BODY);
  if (!body.ok) return json({ error: body.error }, body.status);
  const r = v.safeParse(BoardIn, body.value);
  if (!r.success) return json({ error: "invalid entry" }, 400);
  const { specHash, shareId, ticks } = r.output;
  let name = "";
  if (r.output.name?.trim()) {
    const n = nickname(r.output.name);
    if (!n.ok) return json({ error: "name", why: n.why }, 400);
    name = n.name;
  }
  const text = await c.store.get(`shares/${shareId}.json`);
  if (text === null) return json({ error: "no such run" }, 404);
  const s = JSON.parse(text) as { specHash: string; inputs: string };
  if (s.specHash !== specHash) return json({ error: "that run is of another world" }, 400);
  // the run must stop on the tick it claims: the client keeps a winning run's inputs up to its win
  if (unpackFrames(s.inputs).at(-1)?.tick !== ticks) return json({ error: "the run doesn't end at that time" }, 400);
  const key = keyOf(specHash, ticks, shareId);
  // first post wins the name: posting someone else's run again can't rename it
  const created = !(await c.store.has(key));
  if (created) await c.store.put(key, jcs({ specHash, shareId, ticks, name, ...who(c) }), { name });
  return json({ ok: true, created, entries: await readBoard(specHash, c.store) }, created ? 201 : 200);
}
