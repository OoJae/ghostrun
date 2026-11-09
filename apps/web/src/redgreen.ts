// Red/green on the same seed: when a change (an edit, a design note applied, the Director's cut, a
// repair) moves a check between holding and failing, the same AI runner's run before and after it,
// side by side: green where the check held, red where it fails, and where they part named. The
// runs are the proof's own runners replayed exactly in a worker (pairRuns), never new ones.
import type { WorldBundle } from "@ghostrun/ir";
import { failRunLine, pairLine, partLine, parting, placeOf, type Chip, type FailRun, type Ghost, type KeptRun, type Pair, type PairAsk, type Parting, type Receipt } from "@ghostrun/proof/light";
import { words } from "./i18n/words";
import { ENGINE_HASH } from "./pipeline";

export interface PairPlan {
  ask: PairAsk;
  /** Which world's run is green: the one where the check held. */
  green: "before" | "after";
  /** The chips the pair shows (they hold on one side and fail on the other). */
  chips: string[];
}

/** The par runner's place among the receipt's runs (−1 when no runner won). */
export function parRunner(r: Receipt): number {
  const g = r.ghost;
  return g ? (r.trails ?? []).findIndex((t) => t.won && t.ticks === g.ticks) : -1;
}

const statusOf = (r: Receipt, id: string) => r.chips.find((c) => c.id === id)?.status;
const fails = (r: Receipt, id: string) => statusOf(r, id) === "counterexample";
/** A "requires jumps" claim's physics witness (T3's own jump attempts). */
const jumpClaim = (c: Chip) => c.tier === "T3" && c.method.startsWith("physics jump witness");

/**
 * Which runs show a change best, or null when no check moved between holding and failing. A jump
 * claim the headline makes comes first (that is the promise the person sees), then the AI runners'
 * wins (a runner that won on one side and not on the other: the par runner if it did), then any
 * other jump claim.
 */
export function planPair(before: Receipt, after: Receipt): PairPlan | null {
  const jumps = [...new Set([...before.chips, ...after.chips].filter(jumpClaim).map((c) => c.id))].filter((id) => fails(before, id) !== fails(after, id));
  const head = (before.headline ?? after.headline)?.expect;
  const jumpPlan = (id: string): PairPlan => ({ ask: { kind: "jump", expect: id.slice(3) }, green: fails(after, id) ? "before" : "after", chips: [id, ...(head && `T3:${head}` === id ? [`T1:${head}`] : [])] });
  const headJump = jumps.find((id) => head && id === `T3:${head}`);
  if (headJump) return jumpPlan(headJump);
  const [wa, wb] = [before.chips.find((c) => c.id === "T3:win"), after.chips.find((c) => c.id === "T3:win")];
  if (wa && wb && wa.k !== wb.k) {
    const green = wb.k > wa.k ? "after" : "before";
    const [g, r] = green === "before" ? [before, after] : [after, before];
    const n = Math.min(g.trails?.length ?? 0, r.trails?.length ?? 0);
    const won = (x: Receipt, i: number) => x.trails?.[i]?.won === true;
    const run = [parRunner(g), ...Array.from({ length: n }, (_, i) => i)].find((i) => i >= 0 && i < n && won(g, i) && !won(r, i));
    if (run !== undefined) return { ask: { kind: "win", run }, green, chips: ["T3:win"] };
  }
  return jumps[0] ? jumpPlan(jumps[0]) : null;
}

/** A pair ready to play: green and red, where they part, and what the caption says before and after. */
export interface RedGreen {
  green: Ghost | null;
  red: Ghost;
  parting: Parting | null;
  caption: { before: string; parted: string };
  /** The chips it shows. */
  chips: string[];
}

/** The pair as it plays, from the worker's two runs (a: before, b: after). Null when they never part. */
export function redGreenOf(pair: Pair, plan: PairPlan, b: WorldBundle): RedGreen | null {
  const [green, red]: [KeptRun, KeptRun] = plan.green === "before" ? [pair.a, pair.b] : [pair.b, pair.a];
  const p = parting(green.ghost, red.ghost);
  if (!p) return null;
  const near = placeOf(b, p.at[0], p.at[2]);
  return { green: green.ghost, red: red.ghost, parting: p, caption: { before: pairLine(plan.green, words), parted: partLine(p, 1, near, red.end?.why ?? "", words) }, chips: plan.chips };
}

/** A receipt's own failing run, alone (no other version of the world to set it beside). */
export function failingOnly(f: FailRun, runs: number): RedGreen {
  const line = failRunLine(f, runs, words);
  return { green: null, red: f.ghost, parting: null, caption: { before: line, parted: line }, chips: ["T3:win"] };
}

/**
 * The two runs, played in a worker of their own (the world's proof worker may still be busy with
 * its playtest): `a` before the change, `b` after it. Null if the worker couldn't pair them.
 */
export function pairInWorker(a: WorldBundle, b: WorldBundle, ask: PairAsk, urls: { rapier: string; recast: string }): Promise<Pair | null> {
  return new Promise((resolve) => {
    const wk = new Worker(new URL("./proof.worker.ts", import.meta.url), { type: "module" });
    const done = (p: Pair | null) => (wk.terminate(), resolve(p));
    wk.onmessage = (e: MessageEvent<{ pair?: Pair | null; error?: string }>) => {
      if ("pair" in e.data) done(e.data.pair ?? null);
      else if (e.data.error) done(null);
    };
    wk.onerror = () => done(null);
    wk.postMessage({ id: 1, bundle: a, engine: ENGINE_HASH, urls, pair: { other: b, ask } });
  });
}
