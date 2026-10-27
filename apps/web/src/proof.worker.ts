// Device proof lane (fallback until the edge proof service is deployed): runs T0–T3 on the placed
// world in a Web Worker and streams each chip back as it lands. Same pinned wasm, same code as the
// edge, so the chips are identical (docs/gates.md, S0c).
import type { WorldBundle } from "@ghostrun/ir";
import { initNav } from "@ghostrun/nav";
import { prove } from "@ghostrun/proof";
import { initRapier, type Rapier } from "@ghostrun/sim";

interface Job {
  id: number;
  bundle: WorldBundle;
  engine: string;
  urls: { rapier: string; recast: string };
}

let ready: Promise<Rapier> | undefined;

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, bundle, engine, urls } = e.data;
  try {
    ready ??= (async () => {
      const [rm, nm] = await Promise.all([WebAssembly.compileStreaming(fetch(urls.rapier)), WebAssembly.compileStreaming(fetch(urls.recast))]);
      await initNav(nm);
      return initRapier(rm);
    })();
    const R = await ready;
    const receipt = await prove(R, bundle, { engine, host: "device", onChip: (chip) => self.postMessage({ id, chip }) });
    self.postMessage({ id, receipt });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
