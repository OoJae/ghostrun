// Device proof lane (fallback until the edge proof service is deployed): runs T0–T3 on the placed
// world in a Web Worker and streams each chip back as it lands. Same pinned wasm, same code as the
// edge, so the chips are identical (docs/gates.md, S0c).
import type { WorldBundle } from "@ghostrun/ir";
import { initNav } from "@ghostrun/nav";
import { caught, chipLine, plants, prove } from "@ghostrun/proof";
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
}

let ready: Promise<Rapier> | undefined;

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, bundle, engine, urls, runs, fool } = e.data;
  try {
    ready ??= (async () => {
      const [rm, nm] = await Promise.all([WebAssembly.compileStreaming(fetch(urls.rapier)), WebAssembly.compileStreaming(fetch(urls.recast))]);
      await initNav(nm);
      return initRapier(rm);
    })();
    const R = await ready;
    if (fool) {
      const ps = plants(bundle, fool.parS);
      const p = ps[fool.k % Math.max(1, ps.length)];
      if (!p) return void self.postMessage({ id, fooled: null });
      const receipt = await prove(R, p.bundle, { engine, host: "device", ...(runs ? { runs } : {}) });
      const c = caught(receipt);
      self.postMessage({ id, fooled: { id: p.id, text: p.text, at: p.at, of: ps.length, caught: c.caught, by: c.by ? chipLine(c.by) : null } });
      return;
    }
    const receipt = await prove(R, bundle, { engine, host: "device", ...(runs ? { runs } : {}), onChip: (chip) => self.postMessage({ id, chip }) });
    self.postMessage({ id, receipt });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
