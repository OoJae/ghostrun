// Rivals from stored runs (a "Race me" link, a best-times entry): fetched, replayed into a ghost on
// this device by the replay worker, and checked against the time they claim. A label says exactly
// what was checked and where; nothing shows as verified that this device didn't replay to that tick.
import type { WorldBundle } from "@ghostrun/ir";
import type { Ghost } from "@ghostrun/proof/light";
import type { Replayed } from "@ghostrun/proof";
import { loadShare, type ShareRecord } from "./share";

export type Check =
  /** Replayed here from its inputs, and it wins on the tick it claims (any win, when it claims none). */
  | { status: "verified"; ghost: Ghost; winTick: number }
  /** Replayed here, and it doesn't win there: the claim is wrong (or the run is). */
  | { status: "mismatch"; winTick: number | null }
  /** A run of another world or another version: this device can't replay it exactly. */
  | { status: "elsewhere" }
  | { status: "missing" }
  | { status: "error"; message: string };

type Urls = { rapier: string; recast: string };

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (r: Replayed) => void; reject: (e: Error) => void }>();

/** One stored run replayed headless in the replay worker (one at a time, in order). */
export function replayOnDevice(bundle: WorldBundle, run: Pick<ShareRecord, "inputs" | "minds">, urls: Urls): Promise<Replayed> {
  if (!worker) {
    worker = new Worker(new URL("./replay.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; replayed?: Replayed; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.replayed) w.resolve(e.data.replayed);
      else w.reject(new Error(e.data.error ?? "replay failed"));
    };
  }
  const id = ++seq;
  const w = worker;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, bundle, inputs: run.inputs, minds: run.minds ?? [], urls });
  });
}

/** What a replay says about a claim: verified only when it wins on exactly that tick. */
export function verdict(r: Replayed, claimed: number | null): Check {
  if (r.winTick === null || !r.ghost || (claimed !== null && r.winTick !== claimed)) return { status: "mismatch", winTick: r.winTick };
  return { status: "verified", ghost: r.ghost, winTick: r.winTick };
}

const checks = new Map<string, Promise<Check>>();

/**
 * Fetch a stored run and replay it on this device in this world (its spec hash must match the
 * run's), checking that it wins on `claimed`. Remembered per run and claim for the page's life.
 */
export function checkRun(id: string, bundle: WorldBundle, specHash: string, claimed: number | null, urls: Urls): Promise<Check> {
  const key = `${id}:${specHash}:${claimed}`;
  let c = checks.get(key);
  if (!c) {
    c = (async (): Promise<Check> => {
      const shared = await loadShare(id);
      if (!shared) return { status: "missing" };
      if (!shared.exact || shared.record.specHash !== specHash) return { status: "elsewhere" };
      try {
        return verdict(await replayOnDevice(bundle, shared.record, urls), claimed);
      } catch (e) {
        return { status: "error", message: e instanceof Error ? e.message : String(e) };
      }
    })();
    checks.set(key, c);
  }
  return c;
}

/** How the board labels a check (the honest-label rule: the method and the place, always). */
export function checkLabel(c: Check | undefined): string {
  if (!c) return "replaying on this device…";
  switch (c.status) {
    case "verified":
      return "✓ verified by replay on this device";
    case "mismatch":
      return c.winTick === null ? "✗ its run doesn't win when replayed here" : "✗ its run doesn't replay to that time here";
    case "elsewhere":
      return "– another version's run: not checkable here";
    case "missing":
      return "– its run is gone: not checkable";
    case "error":
      return "– couldn't replay it here";
  }
}
