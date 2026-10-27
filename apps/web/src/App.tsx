import { useCallback, useEffect, useRef, useState } from "react";
import { mergeFill } from "@ghostrun/ir";
import { better, issuesOf, statusWord, type Chip, type Receipt } from "@ghostrun/proof";
import { Engine, type LoadResult } from "./engine";
import { KeyHint } from "./hud/Corner";
import { IntentCard } from "./hud/IntentCard";
import { PromptBar } from "./hud/PromptBar";
import { ProofBadge, ReceiptPanel, RepairChip, type ProofState, type RepairState } from "./hud/Proof";
import { liveAvailable, liveBuild, liveRepair, type LiveIntent } from "./live";
import { BRIEF, buildWorld, ENGINE_HASH, FIXTURE_PROMPTS, FIXTURES, hashWorld, worldFromFill, type Intent, type World } from "./pipeline";
import { probe } from "./probe";
import { loadNav, loadRapier, WASM_URLS } from "./sim/boot";
import { RapierSim } from "./sim/rapier";

const HINT_MS = 6000;
const FIXTURE = new URLSearchParams(window.location.search).get("fixture") ?? "ctf";
const FIRST_PROMPT = FIXTURE_PROMPTS[FIXTURE] ?? BRIEF;

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
  const [prompt, setPrompt] = useState(FIRST_PROMPT);
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
  const [teams, setTeams] = useState(true);
  const [useHint, setUseHint] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const [repair, setRepair] = useState<RepairState>({ status: "idle", issues: 0 });
  const repaired = useRef<World | null>(null);
  const pending = useRef(new Map<number, { onChip?: (c: Chip) => void; resolve: (r: Receipt) => void; reject: (e: Error) => void }>());
  const modeRef = useRef<Mode>("checking");
  modeRef.current = mode;

  /** One proof on the device worker; several can be in flight (the world, and a repair of it). */
  const proveOnDevice = useCallback((world: World, id: number, onChip?: (c: Chip) => void): Promise<Receipt> => {
    if (!worker.current) {
      worker.current = new Worker(new URL("./proof.worker.ts", import.meta.url), { type: "module" });
      worker.current.onmessage = (e: MessageEvent<{ id: number; chip?: Chip; receipt?: Receipt; error?: string }>) => {
        const p = pending.current.get(e.data.id);
        if (!p) return;
        if (e.data.chip) p.onChip?.(e.data.chip);
        if (e.data.receipt) (pending.current.delete(e.data.id), p.resolve(e.data.receipt));
        if (e.data.error) (pending.current.delete(e.data.id), p.reject(new Error(e.data.error)));
      };
    }
    const w = worker.current;
    return new Promise((resolve, reject) => {
      pending.current.set(id, { ...(onChip ? { onChip } : {}), resolve, reject });
      w.postMessage({ id, bundle: world.bundle, engine: ENGINE_HASH, urls: WASM_URLS });
    });
  }, []);

  /**
   * Counterexample-guided repair for live worlds: the receipt's failures go to /v1/repair, the
   * patch is merged, re-placed and re-proved here, and offered only if its receipt is better.
   */
  const maybeRepair = useCallback(async (world: World, receipt: Receipt, id: number) => {
    const src = world.source;
    if (!src || modeRef.current !== "live") return;
    const issues = issuesOf(receipt, world.bundle);
    if (!issues.length) return;
    setRepair({ status: "working", issues: issues.length });
    const patch = await liveRepair(src.prompt, src.intent as LiveIntent, src.fill, issues, src.seed);
    if (id !== runId.current) return;
    if (!patch) return setRepair({ status: "failed", issues: issues.length });
    const merged = mergeFill(src.fill, patch).text;
    const w2 = worldFromFill(merged, src.seed, world.intent.live, src.pack);
    w2.source = { ...src, fill: merged };
    try {
      const r2 = await proveOnDevice(w2, -id);
      if (id !== runId.current) return;
      if (!better(r2, receipt)) return setRepair({ status: "failed", issues: issues.length });
      repaired.current = w2;
      const left = r2.chips.filter((c) => c.status === "counterexample").length;
      setRepair({ status: "offer", issues: issues.length, left, ...(r2.headline ? { headline: `${r2.headline.text} (${statusWord(r2.headline.status)})` } : {}) });
    } catch {
      setRepair({ status: "failed", issues: issues.length });
    }
  }, [proveOnDevice]);

  /** Prove the world on the device worker (until the edge proof service is deployed). */
  const startProof = useCallback((world: World, id: number) => {
    setProof({ status: "proving", chips: [], receipt: null });
    setRepair({ status: "idle", issues: 0 });
    proveOnDevice(world, id, (chip) => id === runId.current && setProof((p) => ({ ...p, chips: [...p.chips, chip] })))
      .then((receipt) => {
        if (id !== runId.current) return;
        setProof((p) => ({ ...p, status: "done", receipt }));
        probe().proof = { headline: receipt.headline?.status ?? "none", chips: receipt.chips.length };
        void maybeRepair(world, receipt, id);
      })
      .catch((err: Error) => id === runId.current && setProof((p) => ({ ...p, status: "error", error: err.message })));
  }, [proveOnDevice, maybeRepair]);

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
      setTeams(world.bundle.rules.some((r) => r.then.some((fx) => fx.target === "team:blue")));
      setUseHint(null);
      setToast(null);
      if (sim) {
        sim.onEvents = (evs) => {
          for (const ev of evs) {
            if (ev.k === "score") setScore((s) => ({ ...s, [ev.a === "team:blue" ? "blue" : "red"]: Number(ev.v) }));
            if (ev.k === "win" || ev.k === "lose") setScore((s) => ({ ...s, result: ev.k }));
            if (ev.k === "touch" && ev.a === "player" && ev.v) setToast(String(ev.v)); // an inspected exhibit's text
          }
        };
        sim.onHint = setUseHint;
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
          const world = worldFromFill(r.fill, r.seed, { genre: r.intent.genre, setting: r.intent.setting, goal: r.intent.goal, fail: r.intent.fail, role: r.intent.role }, r.intent.pack);
          world.source = { prompt: text, intent: r.intent, fill: r.fill, seed: r.seed, pack: r.intent.pack };
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
      await show(buildWorld(text, FIXTURE), id, startedAt, extraSplits);
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
        await run(FIRST_PROMPT, 0, [{ label: "gpu init", ms: e.initMs }]);
        // While the player reads and types: compile every look's and kit's shaders in the background.
        if (!disposed && params.get("prewarm") !== "0") {
          const samples = Object.keys(FIXTURES).map((k) => buildWorld("", k).bundle);
          const day = structuredClone(samples.find((b) => b.pack.id === "outdoor"));
          if (day) samples.push({ ...day, cosmetic: { ...day.cosmetic, look: "forest", timeOfDay: 12 } });
          setTimeout(() => void e.prewarm(samples).then((ms) => (probe().prewarmMs = Math.round(ms))), 1500);
        }
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
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (status !== "playing") return;
    const t = setInterval(() => setClock(engine.current?.rapierSim?.countdown ?? null), 250);
    return () => clearInterval(t);
  }, [status, timing]);

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
        {(score.red > 0 || score.blue > 0 || score.result || clock !== null) && (
          <div className={`glass scoreline ${score.result ?? ""}`} data-testid="score">
            {teams ? (
              <>
                <span className="red">RED {score.red}</span> – <span className="blue">{score.blue} BLUE</span>
              </>
            ) : (
              <span className="red">SCORE {score.red}</span>
            )}
            {clock !== null && !score.result && <span className="clock"> · {Math.floor(clock / 60)}:{String(Math.floor(clock % 60)).padStart(2, "0")}</span>}
            {score.result && <strong>{score.result === "win" ? " · You win!" : " · You lose"}</strong>}
          </div>
        )}
        {useHint && status === "playing" && (
          <div className="glass usehint" data-testid="use-hint">
            <kbd>F</kbd> {useHint}
          </div>
        )}
        {toast && <div className="glass toast" role="status">{toast}</div>}
        <ProofBadge proof={proof} onOpen={() => setReceiptOpen((o) => !o)} />
        <RepairChip
          repair={repair}
          onApply={() => {
            const w = repaired.current;
            if (!w) return;
            repaired.current = null;
            setRepair({ status: "idle", issues: 0 });
            void show(w, ++runId.current, performance.now(), []);
          }}
        />
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
