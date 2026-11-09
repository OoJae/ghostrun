// The cloud proof beside the device's: the same ladder, on the same pinned engine, run at the edge
// (POST /v1/proof, apps/edge-api/src/proof.ts) while the proof worker runs it here. Whichever
// receipt is out first fills the receipt; once both are in (the playtests too) they are compared
// to the bit, timings aside. The same: the receipt says so, which is the determinism made visible.
// Different (it never should be): it says so, keeps this device's, and logs both hashes (the
// console, the probe and a "This is wrong" capture). No edge (offline, switched off, another proof
// version): this device proves alone, as before. Every word shown comes from labels.ts.
import { receiptHash, type Chip, type CrossCheck, type Playtest, type Receipt } from "@ghostrun/proof/light";
import { PROOF_VERSION } from "@ghostrun/world";
import { api } from "./api";
import type { ProofState } from "./hud/Proof";
import { ENGINE_HASH, hashWorld, type World } from "./pipeline";
import { probe } from "./probe";
import { reportWrong } from "./share";

let offered: Promise<boolean> | null = null;

/** Does the edge offer the cloud proof? Asked once a page (/v1/health); a refusal of it as off says no from then on. */
export function cloudOffered(): Promise<boolean> {
  offered ??= fetch("/v1/health", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<{ proof?: unknown }>) : null))
    .then((h) => h?.proof === true)
    .catch(() => false);
  return offered;
}

export interface CloudHooks {
  receipt(r: Receipt): void;
  playtest(p: Playtest | null): void;
}

/** Server-sent events off a response, one at a time. */
async function* events(res: Response): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data) yield { event, data: JSON.parse(data) as unknown };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Ask the edge to prove this world: its receipt as soon as it is out, then its playtest. True once
 * both came; false when there is no cloud proof to be had (the device's then stands alone). A
 * receipt counts only for this very world, on this engine, from this proof version.
 */
export async function proveInCloud(world: World, on: CloudHooks, signal?: AbortSignal): Promise<boolean> {
  try {
    if (!(await cloudOffered())) return false;
    const spec = await hashWorld(world.bundle);
    const res = await api("/v1/proof", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ v: 1, fill: world.fill, seed: world.seed, pack: world.bundle.pack.id, mode: world.bundle.mode, engine: ENGINE_HASH, spec, version: PROOF_VERSION }),
      ...(signal ? { signal } : {}),
    });
    if (res.status === 503 && ((await res.clone().json().catch(() => ({}))) as { retryable?: unknown }).retryable === false) offered = Promise.resolve(false);
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return false;
    let got = false;
    for await (const { event, data } of events(res)) {
      const d = data as { receipt?: Receipt; version?: string; playtest?: Playtest | null };
      if (event === "receipt") {
        const r = d.receipt;
        if (!r || r.v !== 1 || r.spec !== spec || r.engine !== ENGINE_HASH || d.version !== PROOF_VERSION || !Array.isArray(r.chips)) return false;
        got = true;
        on.receipt(r);
      }
      if (event === "playtest" && got) on.playtest(d.playtest ?? null);
      if (event === "error") return false;
      if (event === "done") return got;
    }
    return false;
  } catch {
    return false;
  }
}

export interface DualProof {
  /** The device's proof (proof.worker.ts): chips as they land, the receipt, then its playtest. */
  device(onChip: (c: Chip) => void, onPlaytest: (p: Playtest | null) => void): Promise<Receipt>;
  /** The cloud's (proveInCloud), or null to prove on the device alone. */
  cloud: ((on: CloudHooks, signal: AbortSignal) => Promise<boolean>) | null;
  set(f: (p: ProofState) => ProofState): void;
  /** The first receipt out, from either: what the repair, the race and the Director's cut go on. */
  landed(r: Receipt): void;
  /** This world is still the one on screen. */
  live(): boolean;
  spec: string | (() => Promise<string>);
}

let asking: AbortController | null = null;

/** Prove a world on this device and in the cloud at once (see the top of this file). */
export function dualProof(o: DualProof): void {
  asking?.abort();
  const ask = new AbortController();
  asking = ask;
  const dev: { receipt?: Receipt; playtest?: Playtest | null; failed?: string } = {};
  const cld: { state: CrossCheck["cloud"]; receipt?: Receipt; playtest?: Playtest | null } = { state: o.cloud ? "asked" : "off" };
  let shown: Receipt["host"] | null = null;
  let hashes: CrossCheck["hashes"];
  const cross = (): CrossCheck => ({ shown: shown ?? "device", cloud: cld.state, device: dev.failed !== undefined ? "failed" : dev.receipt ? "done" : "proving", ...(hashes ? { hashes } : {}) });
  const set = (f: (p: ProofState) => ProofState) => o.live() && o.set((p) => ({ ...f(p), cross: cross() }));
  const withPlaytest = (r: Receipt, pt: Playtest | null | undefined): Receipt => (pt ? { ...r, playtest: pt } : r);
  const show = (r: Receipt, from: Receipt["host"]) => {
    shown = from;
    set((p) => ({ ...p, status: "done", receipt: r, chips: r.chips, playing: true }));
    if (o.live()) o.landed(r);
  };

  const compare = async () => {
    if (!dev.receipt || !cld.receipt || dev.playtest === undefined || cld.playtest === undefined || cld.state === "same" || cld.state === "different") return;
    // a playtest one side lost (a worker that failed after the receipt, a stream cut short) is left out of the comparison
    const both = Boolean(dev.playtest && cld.playtest);
    const [d, c] = await Promise.all([receiptHash(withPlaytest(dev.receipt, both ? dev.playtest : null)), receiptHash(withPlaytest(cld.receipt, both ? cld.playtest : null))]);
    hashes = { device: d, cloud: c };
    cld.state = d === c ? "same" : "different";
    probe().cloud = { verdict: cld.state, device: d, cloud: c };
    if (d === c) return set((p) => p);
    // never expected: the simulation is bit-exact everywhere. Say so, keep this device's, and log both
    const spec = typeof o.spec === "string" ? o.spec : await o.spec();
    console.warn(`cloud proof differs from this device's: spec ${spec}, device receipt ${d}, cloud receipt ${c}`);
    void reportWrong(spec, `cloud proof differs: device ${d}, cloud ${c} (proof ${PROOF_VERSION.slice(0, 16)})`, "cloud-proof", []);
    const mine = withPlaytest(dev.receipt, dev.playtest ?? cld.playtest);
    shown = "device";
    set((p) => ({ ...p, receipt: mine, chips: mine.chips, playing: false }));
  };

  const failedBoth = () => dev.failed !== undefined && !shown && (cld.state === "off" || cld.state === "failed");
  const fail = () => failedBoth() && set((p) => ({ ...p, status: "error", ...(dev.failed ? { error: dev.failed } : {}) }));

  o.device(
    (chip) => set((p) => (p.receipt ? p : { ...p, chips: [...p.chips, chip] })),
    (pt) => {
      dev.playtest = pt;
      if (shown === "device" || (shown === "edge" && cld.playtest === undefined)) set((p) => ({ ...p, playing: false, ...(pt && p.receipt ? { receipt: { ...p.receipt, playtest: pt } } : {}) }));
      else set((p) => p);
      void compare();
      probe().deviceReceipt = dev.receipt ? withPlaytest(dev.receipt, pt) : undefined;
    },
  )
    .then((r) => {
      dev.receipt = r;
      if (!shown) show(r, "device");
      else set((p) => p);
      void compare();
    })
    .catch((e: Error) => {
      dev.failed = e.message;
      if (!shown && !failedBoth()) return set((p) => p); // the cloud may still answer
      fail();
      set((p) => p);
    });

  if (!o.cloud) return;
  void o
    .cloud(
      {
        receipt: (r) => {
          cld.receipt = r;
          if (!shown) show(r, "edge");
          else set((p) => p);
        },
        playtest: (pt) => {
          cld.playtest = pt;
          // the cloud's playtest fills in for one this device hasn't finished yet
          if ((shown === "edge" || dev.playtest === undefined) && pt) set((p) => (p.receipt && !p.receipt.playtest ? { ...p, playing: false, receipt: { ...p.receipt, playtest: pt } } : p));
          void compare();
        },
      },
      ask.signal,
    )
    .then((ok) => {
      if (ok) return;
      // the receipt came and the playtest didn't: the receipts are still compared
      if (cld.receipt) {
        cld.playtest ??= null;
        return void compare();
      }
      cld.state = "failed";
      fail();
      set((p) => p);
    });
}
