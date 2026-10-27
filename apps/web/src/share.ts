// Share links: a run is the world's fill, its seed and the exact int8 input log, so a link replays
// bit-exactly on any device (the spec hash is checked on the way back in). "This is wrong" sends
// the spec hash, the chip the judge disputes, a note and the inputs that led there.
import type { InputFrame } from "@ghostrun/sim";
import { api } from "./api";
import { ENGINE_HASH, hashWorld, worldFromFill, type World } from "./pipeline";

export interface ShareRecord {
  id: string;
  engine: string;
  specHash: string;
  seed: number;
  fill: string;
  inputs: InputFrame[];
}

/** The last ten minutes of input at most, ticks strictly increasing (what the store accepts). */
const clip = (inputs: readonly InputFrame[]) => inputs.slice(-36_000);

export async function createShare(world: World, specHash: string, inputs: readonly InputFrame[]): Promise<string | null> {
  try {
    const r = await api("/v1/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, engine: ENGINE_HASH, specHash, seed: world.seed, fill: world.fill, inputs: clip(inputs) }),
    });
    if (!r.ok) return null;
    const { id } = (await r.json()) as { id: string };
    return `${window.location.origin}${window.location.pathname}?s=${id}`;
  } catch {
    return null;
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
