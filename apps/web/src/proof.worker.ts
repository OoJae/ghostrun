// Device proof lane (fallback until the edge proof service is deployed): runs T0–T3 on the placed
// world in a Web Worker and streams each chip back as it lands. Same pinned wasm, same code as the
// edge, so the chips are identical (docs/gates.md, S0c).
import type { WorldBundle } from "@ghostrun/ir";
import { initNav } from "@ghostrun/nav";
import { buildNav } from "@ghostrun/nav";
import { caught, chipLine, pairRuns, plants, prove, screen as screenT4, t0, type PairAsk } from "@ghostrun/proof";
import { initRapier, type Rapier } from "@ghostrun/sim";

interface Job {
  id: number;
  bundle: WorldBundle;
  engine: string;
  urls: { rapier: string; recast: string };
  /** AI runners for T3 (a candidate race proves with fewer; the world itself gets the default). */
  runs?: number;
  /** "Try to fool it": plant the k-th bug that applies to this world (its AI par decides some), prove that. */
  fool?: { k: number; parS: number | null };
  /**
   * Then the playtest (novice and average runners: the difficulty band, what the runners
   * revealed). The receipt is posted first, as soon as it is without them; the playtest follows
   * as a second message (null when there is none).
   */
  playtest?: boolean;
  /** Runners per lower level in the playtest (a candidate race bands with fewer). */
  skillRuns?: number;
  /** With the playtest: T3h (the player's controls and camera) and T4 (the route model), as the edge says (cloud.ts). */
  t3h?: boolean;
  t4?: boolean;
  /** Red/green: the same runner (or jump attempt) on this world and on `other`, each kept whole. */
  pair?: { other: WorldBundle; ask: PairAsk };
  /** T4's screen of a candidate: `n` modelled runs at each level on the anchors of the world it came from (no physics). */
  screen?: { anchor: { scale: number; risk: number }; n: number };
}

let ready: Promise<Rapier> | undefined;

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, bundle, engine, urls, runs, fool, playtest, skillRuns, pair, t3h, t4, screen } = e.data;
  let sent = false;
  try {
    ready ??= (async () => {
      const [rm, nm] = await Promise.all([WebAssembly.compileStreaming(fetch(urls.rapier)), WebAssembly.compileStreaming(fetch(urls.recast))]);
      await initNav(nm);
      return initRapier(rm);
    })();
    const R = await ready;
    if (pair) return void self.postMessage({ id, pair: pairRuns(R, bundle, pair.other, pair.ask) });
    if (screen) {
      const nav = buildNav(bundle);
      try {
        const chain = t0(bundle).chain;
        return void self.postMessage({ id, screened: chain ? screenT4(bundle, nav, chain, screen.anchor, screen.n) : null });
      } finally {
        nav.destroy();
      }
    }
    if (fool) {
      const ps = plants(bundle, fool.parS);
      const p = ps[fool.k % Math.max(1, ps.length)];
      if (!p) return void self.postMessage({ id, fooled: null });
      const receipt = await prove(R, p.bundle, { engine, host: "device", ...(runs ? { runs } : {}) });
      const c = caught(receipt);
      self.postMessage({ id, fooled: { id: p.id, text: p.text, at: p.at, of: ps.length, caught: c.caught, by: c.by ? chipLine(c.by) : null } });
      return;
    }
    const later = playtest ? { playtest: true, ...(skillRuns ? { skillRuns } : {}), ...(t3h ? { t3h } : {}), ...(t4 ? { t4 } : {}), onReceipt: (receipt: unknown) => ((sent = true), self.postMessage({ id, receipt })) } : {};
    const receipt = await prove(R, bundle, { engine, host: "device", ...(runs ? { runs } : {}), onChip: (chip) => self.postMessage({ id, chip }), ...later });
    if (playtest) self.postMessage({ id, playtest: receipt.playtest ?? null });
    else self.postMessage({ id, receipt });
  } catch (err) {
    // the receipt is out already: only the playtest is lost
    self.postMessage(sent ? { id, playtest: null } : { id, error: err instanceof Error ? err.message : String(err) });
  }
};
