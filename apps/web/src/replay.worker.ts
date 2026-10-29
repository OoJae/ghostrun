// Stored runs replayed headless (a "Race me" link, a best-times entry): the same pinned wasm and the
// same simulation as the game, so the ghost it records is the run exactly as it was played, and the
// tick it wins on is what a claimed time is checked against. Its own worker, so a check never
// waits behind a proof.
import type { WorldBundle } from "@ghostrun/ir";
import { initNav } from "@ghostrun/nav";
import { replayRun } from "@ghostrun/proof";
import { initRapier, type InputFrame, type Rapier } from "@ghostrun/sim";

interface Job {
  id: number;
  bundle: WorldBundle;
  inputs: InputFrame[];
  minds: { tick: number; npc: string; option: string }[];
  urls: { rapier: string; recast: string };
}

let ready: Promise<Rapier> | undefined;

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, bundle, inputs, minds, urls } = e.data;
  try {
    ready ??= (async () => {
      const [rm, nm] = await Promise.all([WebAssembly.compileStreaming(fetch(urls.rapier)), WebAssembly.compileStreaming(fetch(urls.recast))]);
      await initNav(nm);
      return initRapier(rm);
    })();
    self.postMessage({ id, replayed: replayRun(await ready, bundle, inputs, minds) });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
