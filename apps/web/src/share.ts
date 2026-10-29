// Share links: a run is the world's fill, its seed and the exact int8 input log, so a link replays
// bit-exactly on any device (the spec hash is checked on the way back in). "This is wrong" sends
// the spec hash, the chip the judge disputes, a note and the inputs that led there. A share also
// says the prompt it was built from, and a remix's share its line (see remix.ts).
import type { InputFrame } from "@ghostrun/sim";
import { api } from "./api";
import { ENGINE_HASH, hashWorld, worldFromFill, type World } from "./pipeline";
import type { Lineage } from "./remix";
import type { MindChoice } from "./sim/rapier";

export interface ShareRecord {
  id: string;
  engine: string;
  specHash: string;
  seed: number;
  fill: string;
  inputs: InputFrame[];
  minds: MindChoice[];
  prompt?: string;
  remixOf?: string;
  origin?: Lineage["origin"];
  lineage?: Lineage["lineage"];
  changes?: number;
}

/** What a share says besides the run: the world's prompt, and a remix's line. */
export type ShareAbout = { prompt?: string; line?: Lineage | null };

/** The last ten minutes of input at most, ticks strictly increasing (what the store accepts). */
const clip = (inputs: readonly InputFrame[]) => inputs.slice(-36_000);

/** Store a run; its share id, or null when the share service isn't reachable. */
export async function storeRun(world: World, specHash: string, inputs: readonly InputFrame[], minds: readonly MindChoice[] = [], about: ShareAbout = {}): Promise<string | null> {
  const prompt = about.prompt?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
  try {
    const r = await api("/v1/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, engine: ENGINE_HASH, specHash, seed: world.seed, fill: world.fill, inputs: clip(inputs), ...(minds.length ? { minds: minds.slice(-500) } : {}), ...(prompt ? { prompt } : {}), ...(about.line ?? {}) }),
    });
    if (!r.ok) return null;
    return ((await r.json()) as { id: string }).id;
  } catch {
    return null;
  }
}

export async function createShare(world: World, specHash: string, inputs: readonly InputFrame[], minds: readonly MindChoice[] = [], about: ShareAbout = {}): Promise<string | null> {
  const id = await storeRun(world, specHash, inputs, minds, about);
  return id && `${window.location.origin}${window.location.pathname}?s=${id}`;
}

/** The longest run the store keeps whole (ten minutes): a race link must replay from the first tick. */
export const MAX_RACE_TICKS = 36_000;

/** A winning run up to the tick it won on: what a race link and a best time stand on. */
export const upToWin = (inputs: readonly InputFrame[], minds: readonly MindChoice[], tick: number) => ({ inputs: inputs.filter((f) => f.tick <= tick), minds: minds.filter((m) => m.tick <= tick) });

/** Opens the same world with this run as the ghost to beat (the name is what the sender typed). */
export const raceLink = (id: string, name = "") => `${window.location.origin}${window.location.pathname}?race=${id}${name ? `&by=${encodeURIComponent(name)}` : ""}`;

export interface BoardEntry {
  shareId: string;
  ticks: number;
  name: string;
}

/** A world's ten best times as the edge holds them (claims until this device replays them). */
export async function loadBoard(specHash: string): Promise<BoardEntry[] | null> {
  try {
    const r = await api(`/v1/board/${specHash}`);
    return r.ok ? ((await r.json()) as { entries: BoardEntry[] }).entries : null;
  } catch {
    return null;
  }
}

export async function postBest(specHash: string, shareId: string, ticks: number, name: string): Promise<{ ok: true; entries: BoardEntry[] } | { ok: false; why: string }> {
  try {
    const r = await api("/v1/board", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ specHash, shareId, ticks, ...(name.trim() ? { name } : {}) }) });
    const body = (await r.json().catch(() => ({}))) as { entries?: BoardEntry[]; error?: string; why?: string };
    if (r.ok && body.entries) return { ok: true, entries: body.entries };
    return { ok: false, why: body.why ?? body.error ?? "the board isn't reachable" };
  } catch {
    return { ok: false, why: "the board isn't reachable" };
  }
}

/** A shared run: its world rebuilt from the fill, and whether it still matches what was shared. */
export async function loadShare(id: string): Promise<{ world: World; record: ShareRecord; exact: boolean } | null> {
  try {
    const r = await api(`/v1/share/${id}`);
    if (!r.ok) return null;
    const record = (await r.json()) as ShareRecord;
    const pack = (JSON.parse(record.fill.split("\n", 1)[0] ?? "{}") as { pack?: string }).pack;
    const world = worldFromFill(record.fill, record.seed, undefined, pack);
    const exact = record.engine === ENGINE_HASH && (await hashWorld(world.bundle)) === record.specHash;
    return { world, record, exact };
  } catch {
    return null;
  }
}

export async function reportWrong(specHash: string, note: string, chipId: string | undefined, inputs: readonly InputFrame[]): Promise<boolean> {
  try {
    const r = await api("/v1/wrong", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specHash, note: note.slice(0, 500), ...(chipId ? { chipId } : {}), inputs: clip(inputs) }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
