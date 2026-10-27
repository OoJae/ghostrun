import { useCallback, useEffect, useRef, useState } from "react";
import type { Chip, Receipt } from "@ghostrun/proof";
import { Engine, type LoadResult } from "./engine";
import { KeyHint } from "./hud/Corner";
import { IntentCard } from "./hud/IntentCard";
import { PromptBar } from "./hud/PromptBar";
import { ProofBadge, ReceiptPanel, type ProofState } from "./hud/Proof";
import { liveAvailable, liveBuild } from "./live";
import { BRIEF, buildWorld, ENGINE_HASH, hashWorld, worldFromFill, type Intent, type World } from "./pipeline";
import { probe } from "./probe";
import { loadNav, loadRapier, WASM_URLS } from "./sim/boot";
import { RapierSim } from "./sim/rapier";

const HINT_MS = 6000;

type Status = "booting" | "building" | "playing" | "error";
type Mode = "checking" | "live" | "fixture";

const SOURCE: Record<Mode, { label: string; title: string }> = {
  checking: { label: "…", title: "checking the live AI lane" },
  live: { label: "live AI", title: "Intent and fill are generated live (Cerebras), streamed line by line" },
  fixture: { label: "fixture", title: "Live AI unavailable: showing the recorded CTF fixture world" },
};

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const worker = useRef<Worker | null>(null);
  const runId = useRef(0);
  const [prompt, setPrompt] = useState(BRIEF);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [specHash, setSpecHash] = useState<string>();
  const [timing, setTiming] = useState<LoadResult | null>(null);
  const [status, setStatus] = useState<Status>("booting");
  const [mode, setMode] = useState<Mode>("checking");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  const [hint, setHint] = useState(false);
  const [proof, setProof] = useState<ProofState>({ status: "idle", chips: [], receipt: null });
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [score, setScore] = useState<{ red: number; blue: number; result: string | null }>({ red: 0, blue: 0, result: null });

  /** Prove the world on the device worker (until the edge proof service is deployed). */
  const startProof = useCallback((world: World, id: number) => {
    worker.current ??= new Worker(new URL("./proof.worker.ts", import.meta.url), { type: "module" });
    const w = worker.current;
    setProof({ status: "proving", chips: [], receipt: null });
    w.onmessage = (e: MessageEvent<{ id: number; chip?: Chip; receipt?: Receipt; error?: string }>) => {
      if (e.data.id !== id) return;
      if (e.data.chip) setProof((p) => ({ ...p, chips: [...p.chips, e.data.chip!] }));
      if (e.data.receipt) {
        setProof((p) => ({ ...p, status: "done", receipt: e.data.receipt! }));
        probe().proof = { headline: e.data.receipt.headline?.status ?? "none", chips: e.data.receipt.chips.length };
      }
      if (e.data.error) setProof((p) => ({ ...p, status: "error", error: e.data.error! }));
    };
    w.postMessage({ id, bundle: world.bundle, engine: ENGINE_HASH, urls: WASM_URLS });
  }, []);

  const show = useCallback(
    async (world: World, id: number, startedAt: number, extra: LoadResult["splits"]) => {
      const e = engine.current;
      if (!e) return;
      setIntent(world.intent);
      setScore({ red: 0, blue: 0, result: null });
      const result = await e.load(world, startedAt);
      if (id !== runId.current) return;
      setTiming({ ttffMs: result.ttffMs, splits: [...extra, ...result.splits] });
      setStatus("playing");
      setHint(true);
      const sim = e.rapierSim;
      if (sim) {
        sim.onEvents = (evs) => {
          for (const ev of evs) {
            if (ev.k === "score") setScore((s) => ({ ...s, [ev.a === "team:blue" ? "blue" : "red"]: Number(ev.v) }));
            if (ev.k === "win" || ev.k === "lose") setScore((s) => ({ ...s, result: ev.k }));
          }
        };
      }
      startProof(world, id);
      const h = await hashWorld(world.bundle);
      if (id !== runId.current) return;
      setSpecHash(h);
      probe().specHash = h;
    },
    [startProof],
  );

  const run = useCallback(
    async (text: string, startedAt: number, extraSplits: LoadResult["splits"] = [], useLive = false) => {
      const id = ++runId.current;
      setStatus("building");
      setNotice(undefined);
      setSpecHash(undefined);
      setProof({ status: "idle", chips: [], receipt: null });
      delete probe().specHash;
      if (useLive) {
        const r = await liveBuild(text, (i, ms) => {
          if (id !== runId.current) return;
          setNotice(`${i.genre} · ${i.setting.slice(0, 80)} (${ms} ms)`);
        });
        if (id !== runId.current) return;
        if (r.kind === "world") {
          const world = worldFromFill(r.fill, r.seed, { genre: r.intent.genre, setting: r.intent.setting, goal: r.intent.goal, fail: r.intent.fail, role: r.intent.role });
          setNotice(undefined);
          await show(world, id, startedAt, [...extraSplits, { label: "intent", ms: r.intentMs }, { label: "fill", ms: r.gameplayMs - r.intentMs }]);
          return;
        }
        if (r.kind === "refused") {
          setNotice(r.message);
          setStatus("playing");
          return;
        }
        setNotice(`Live AI unavailable (${r.reason.slice(0, 60)}): showing the fixture world instead.`);
        setMode("fixture");
      }
      await show(buildWorld(text), id, startedAt, extraSplits);
    },
    [show],
  );

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let disposed = false;
    const params = new URLSearchParams(window.location.search);
    const num = (k: string) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : undefined);
    const dpr = num("dpr");
    const msaa = num("msaa");
    void liveAvailable().then((ok) => !disposed && setMode(ok && params.get("live") !== "0" ? "live" : "fixture"));
    Engine.create(el, {
      forceWebGL: params.get("gl") === "webgl2",
      bloom: params.get("fx") !== "0",
      ...(dpr !== undefined && { pixelRatio: Math.min(3, Math.max(0.5, dpr)) }),
      ...(msaa !== undefined && { msaa: msaa > 0 ? 4 : 0 }),
    })
      .then(async (e) => {
        if (disposed) {
          e.dispose();
          return;
        }
        engine.current = e;
        e.onInput = () => setCollapsed(true);
        probe().sim = "stub";
        if (params.get("sim") !== "stub") {
          try {
            const [R, bots] = await Promise.all([loadRapier(), loadNav()]);
            e.simFactory = (b) => new RapierSim(R, b, bots);
            probe().sim = "rapier";
          } catch (err) {
            console.warn("Rapier unavailable, using the stub simulation", err);
            probe().sim = "stub";
          }
        }
        // First load: the recorded world appears instantly; Enter builds live.
        return run(BRIEF, 0, [{ label: "gpu init", ms: e.initMs }]);
      })
      .catch((err: unknown) => {
        console.error(err);
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code === "KeyP" && !(ev.target instanceof HTMLInputElement)) setReceiptOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      worker.current?.terminate();
      engine.current?.dispose();
      engine.current = null;
    };
  }, [run]);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(t);
  }, [hint, timing]);

  const submit = (text: string) => {
    setCollapsed(false);
    run(text, performance.now(), [], mode === "live").catch((err: unknown) => {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    });
  };

  return (
    <>
      <canvas ref={canvas} className="stage" data-testid="stage" />
      <div className="hud">
        <div className="top">
          <PromptBar
            prompt={prompt}
            onPrompt={setPrompt}
            onSubmit={submit}
            collapsed={collapsed}
            onExpand={() => setCollapsed(false)}
            onCollapse={() => setCollapsed(true)}
            timing={timing}
            busy={status === "building" || status === "booting"}
            source={SOURCE[mode]}
          />
        </div>
        {notice && <div className="glass notice" role="status">{notice}</div>}
        {!collapsed && intent && <IntentCard intent={intent} specHash={specHash} />}
        {(score.red > 0 || score.blue > 0 || score.result) && (
          <div className={`glass scoreline ${score.result ?? ""}`} data-testid="score">
            <span className="red">RED {score.red}</span> – <span className="blue">{score.blue} BLUE</span>
            {score.result && <strong>{score.result === "win" ? " · You win!" : " · You lose"}</strong>}
          </div>
        )}
        <ProofBadge proof={proof} onOpen={() => setReceiptOpen((o) => !o)} />
        {receiptOpen && <ReceiptPanel proof={proof} onClose={() => setReceiptOpen(false)} />}
        <KeyHint visible={hint && status === "playing"} />
        {status === "booting" && <div className="boot">building world…</div>}
        {status === "building" && <div className="boot">building world…</div>}
        {status === "error" && (
          <div className="glass fatal" role="alert">
            <strong>Renderer failed to start</strong>
            <p>{error}</p>
          </div>
        )}
      </div>
    </>
  );
}
