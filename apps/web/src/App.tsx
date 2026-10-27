import { useCallback, useEffect, useRef, useState } from "react";
import { mergeFill } from "@ghostrun/ir";
import { better, issuesOf, statusWord, type Chip, type Receipt } from "@ghostrun/proof/light";
// the engine stack (three, physics, navmesh, bots) is a second chunk, fetched as the shell paints
import type { Engine, LoadResult } from "./engine";
import { KeyHint } from "./hud/Corner";
import { TouchControls } from "./hud/Touch";
import { XRay } from "./hud/XRay";
import { ResultCard, type RunResult } from "./hud/Result";
import { IntentCard } from "./hud/IntentCard";
import { PromptBar } from "./hud/PromptBar";
import { ProofBadge, ReceiptPanel, RepairChip, type ProofState, type RepairState } from "./hud/Proof";
import { liveAvailable, liveBuild, liveRepair, type LiveIntent } from "./live";
import { createShare, loadShare, reportWrong } from "./share";
import { Minds } from "./minds";
import { propose, twistWorld } from "./director";
import { BRIEF, buildWorld, ENGINE_HASH, FIXTURE_PROMPTS, FIXTURES, hashWorld, worldFromFill, type Intent, type World } from "./pipeline";
import { probe } from "./probe";

const HINT_MS = 6000;
const FIXTURE = new URLSearchParams(window.location.search).get("fixture") ?? "ctf";
const FIRST_PROMPT = FIXTURE_PROMPTS[FIXTURE] ?? BRIEF;
const params0 = new URLSearchParams(window.location.search);
const TOUCH_PARAM = params0.get("touch");

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
  const wasmUrls = useRef<{ rapier: string; recast: string } | null>(null);
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
  const [xray, setXray] = useState(false);
  const [vrOk, setVrOk] = useState(false);
  const [inVr, setInVr] = useState(false);
  const [score, setScore] = useState<{ red: number; blue: number; result: string | null }>({ red: 0, blue: 0, result: null });
  const [teams, setTeams] = useState(true);
  const [useHint, setUseHint] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const [repair, setRepair] = useState<RepairState>({ status: "idle", issues: 0 });
  // phones and tablets (or ?touch=1): on-screen stick and buttons; a first touch also turns them on
  const [touch, setTouch] = useState(() => TOUCH_PARAM === "1" || (TOUCH_PARAM !== "0" && window.matchMedia?.("(pointer: coarse)").matches));
  useEffect(() => {
    if (touch || TOUCH_PARAM === "0") return;
    const on = (e: PointerEvent) => e.pointerType === "touch" && setTouch(true);
    window.addEventListener("pointerdown", on);
    return () => window.removeEventListener("pointerdown", on);
  }, [touch]);
  const repaired = useRef<World | null>(null);
  const current = useRef<World | null>(null);
  const minds = useRef<Minds | null>(null);
  const [bark, setBark] = useState<{ name: string; line: string; at: number } | null>(null);
  const [talking, setTalking] = useState<{ npc: string; name: string } | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [director, setDirector] = useState<{ line: string; label: string; status: "proving" | "ready"; world?: World } | null>(null);
  const [said, setSaid] = useState("");
  const [reported, setReported] = useState<string>();
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
      w.postMessage({ id, bundle: world.bundle, engine: ENGINE_HASH, urls: wasmUrls.current });
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
      current.current = world;
      setReported(undefined);
      setResult(null);
      setDirector(null);
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
        minds.current?.stop();
        minds.current = modeRef.current === "live" ? new Minds(world, sim, (_npc, name, line) => setBark({ name, line, at: Date.now() })) : null;
        sim.onEvents = (evs) => {
          minds.current?.observe(evs);
          for (const ev of evs) {
            if (ev.k === "score") setScore((s) => ({ ...s, [ev.a === "team:blue" ? "blue" : "red"]: Number(ev.v) }));
            if (ev.k === "win" || ev.k === "lose") {
              setScore((s) => ({ ...s, result: ev.k }));
              const res: RunResult = { k: ev.k, tick: ev.tick, rule: ev.rule };
              setResult(res);
              void directorFor(world, sim.trail, res, id);
            }
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
          const world = worldFromFill(r.fill, r.seed, { genre: r.intent.genre, setting: r.intent.setting, goal: r.intent.goal, fail: r.intent.fail, role: r.intent.role }, r.intent.pack, r.intent.mode);
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
    import("./engine")
      .then(({ Engine }) =>
        Engine.create(el, {
          forceWebGL: params.get("gl") === "webgl2",
          bloom: params.get("fx") !== "0",
          ...(dpr !== undefined && { pixelRatio: Math.min(3, Math.max(0.5, dpr)) }),
          ...(msaa !== undefined && { msaa: msaa > 0 ? 4 : 0 }),
        }),
      )
      .then(async (e) => {
        if (disposed) {
          e.dispose();
          return;
        }
        engine.current = e;
        e.onInput = () => setCollapsed(true);
        void e.vrSupported().then((ok) => !disposed && setVrOk(ok));
        probe().sim = "stub";
        if (params.get("sim") !== "stub") {
          try {
            const [{ loadRapier, loadNav, WASM_URLS }, { RapierSim }] = await Promise.all([import("./sim/boot"), import("./sim/rapier")]);
            wasmUrls.current = WASM_URLS;
            const [R, bots] = await Promise.all([loadRapier(), loadNav()]);
            e.simFactory = (b) => new RapierSim(R, b, bots);
            probe().sim = "rapier";
          } catch (err) {
            console.warn("Rapier unavailable, using the stub simulation", err);
            probe().sim = "stub";
          }
        }
        // A share link opens that run (rebuilt from its fill, replayed frame for frame); otherwise
        // the recorded world appears instantly and Enter builds live.
        const shared = params.get("s") ? await loadShare(params.get("s")!) : null;
        if (shared && !disposed) {
          setPrompt("Shared run");
          await show(shared.world, ++runId.current, 0, [{ label: "gpu init", ms: e.initMs }]);
          const sim = e.rapierSim;
          if (sim) {
            sim.replay(shared.record.inputs, shared.record.minds ?? []);
            sim.onReplayEnd = () => setNotice(undefined);
          }
          setNotice(shared.exact ? "Shared run: replaying exactly as played. Press any key to take over." : "Shared run from another version: the world rebuilt, but the replay may drift.");
        } else {
          if (params.get("s")) setNotice("That share link wasn't found.");
          await run(FIRST_PROMPT, 0, [{ label: "gpu init", ms: e.initMs }]);
        }
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
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
      if (ev.code === "KeyP") setReceiptOpen((o) => !o);
      if (ev.code === "KeyX") setXray((o) => !o);
      if (ev.code === "KeyR") againRef.current();
      if (ev.code === "KeyT") {
        const npc = minds.current?.nearby();
        if (npc) {
          ev.preventDefault();
          setTalking({ npc, name: minds.current!.name(npc) });
        }
      }
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

  // the first world appears before the live check answers: give it minds once the service is up
  useEffect(() => {
    if (mode !== "live" || minds.current) return;
    const sim = engine.current?.rapierSim;
    const w = current.current;
    if (sim && w) minds.current = new Minds(w, sim, (_npc, name, line) => setBark({ name, line, at: Date.now() }));
  }, [mode, status]);

  useEffect(() => {
    if (!bark) return;
    const t = setTimeout(() => setBark(null), 5500);
    return () => clearTimeout(t);
  }, [bark]);

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

  const shareRun = async () => {
    const w = current.current;
    const sim = engine.current?.rapierSim;
    if (!w || !sim || !specHash) return setToast("Nothing to share yet.");
    const url = await createShare(w, specHash, sim.inputs, sim.minds);
    if (!url) return setToast("Sharing needs the live service, which isn't reachable.");
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    setToast(`Link copied: ${url}`);
  };

  /** Between attempts: one observation, one twist, re-proved on the device before it is offered. */
  const directorFor = async (world: World, trail: readonly [number, number, number][], res: RunResult, id: number) => {
    const p = propose(world, trail, res);
    if (!p) return;
    setDirector({ line: p.line, label: p.label, status: "proving" });
    const w2 = twistWorld(world, p.fill);
    try {
      const r2 = await proveOnDevice(w2, -1_000_000 - id);
      const win = r2.chips.find((c) => c.id === "T3:win");
      if (id !== runId.current || !win || win.k === 0 || r2.chips.some((c) => c.status === "counterexample" && c.id !== "T3:too_easy")) return setDirector(null);
      setDirector({ line: p.line, label: p.label, status: "ready", world: w2 });
    } catch {
      setDirector(null);
    }
  };

  /** The same world from the top: a fresh run (and a fresh proof of the same spec). */
  const again = () => {
    const w = current.current;
    if (!w) return;
    setResult(null);
    void show(w, ++runId.current, performance.now(), []);
  };
  const againRef = useRef(again);
  againRef.current = again;

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
      <div className={`hud${touch ? " touch-mode" : ""}`}>
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
        {useHint && status === "playing" && !touch && (
          <div className="glass usehint" data-testid="use-hint">
            <kbd>F</kbd> {useHint}
          </div>
        )}
        {toast && <div className="glass toast" role="status">{toast}</div>}
        {result && current.current && (
          <ResultCard
            result={result}
            bundle={current.current.bundle}
            par={proof.receipt?.par?.goldS ?? null}
            onAgain={again}
            onShare={() => void shareRun()}
            director={director}
            onTwist={() => {
              const w = director?.world;
              if (!w) return;
              setResult(null);
              void show(w, ++runId.current, performance.now(), []);
            }}
          />
        )}
        {bark && (
          <div className="glass bark" data-testid="bark">
            <b>{bark.name}:</b> {bark.line}
          </div>
        )}
        {talking && (
          <form
            className="glass talk"
            onSubmit={(e) => {
              e.preventDefault();
              if (said.trim()) minds.current?.talk(talking.npc, said.trim());
              setTalking(null);
              setSaid("");
            }}
          >
            <input autoFocus value={said} maxLength={200} placeholder={`Say something to the ${talking.name}…`} onChange={(e) => setSaid(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setTalking(null)} />
          </form>
        )}
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
        {vrOk && status === "playing" && !inVr && (
          <button
            type="button"
            className={`glass vrbtn${params0.get("vr") === "1" ? " ready" : ""}`}
            data-testid="enter-vr"
            onClick={async () => {
              const e = engine.current;
              if (!e) return;
              const r = await e.enterVR();
              if (r === "reload") {
                const u = new URL(window.location.href);
                u.searchParams.set("gl", "webgl2");
                u.searchParams.set("vr", "1");
                window.location.href = u.toString();
              } else if (r === "started") {
                setInVr(true);
                const check = setInterval(() => {
                  if (engine.current?.presenting) return;
                  setInVr(false);
                  clearInterval(check);
                }, 500);
              } else setToast("Couldn't start VR on this device.");
            }}
          >
            {params0.get("vr") === "1" ? "Tap to enter VR" : "Enter VR"}
          </button>
        )}
        {xray && current.current && (
          <XRay
            bundle={current.current.bundle}
            chips={proof.chips}
            onFocus={(id) => engine.current?.highlight(id)}
            onClose={() => {
              setXray(false);
              engine.current?.highlight(null);
            }}
          />
        )}
        {receiptOpen && (
          <ReceiptPanel
            proof={proof}
            onClose={() => setReceiptOpen(false)}
            reported={reported}
            onShare={shareRun}
            onExport={async () => {
              const w = current.current;
              if (!w || !specHash) return setToast("Nothing to export yet.");
              const { exportWorld } = await import("./export"); // loaded on demand: the exporter is a separate three build
              await exportWorld(w.bundle, specHash, proof.receipt, prompt);
              setToast("Exported: the scene (.glb), its logic (.logic.json) and the playtest report (.html).");
            }}
            onWrong={async (note) => {
              const sim = engine.current?.rapierSim;
              if (!specHash) return;
              const ok = await reportWrong(specHash, note, undefined, sim?.inputs ?? []);
              setReported(note);
              setToast(ok ? "Thanks: reported with your run attached." : "Couldn't send the report (the live service isn't reachable).");
            }}
          />
        )}
        {!touch && <KeyHint visible={hint && status === "playing"} />}
        {touch && status === "playing" && (
          <TouchControls
            onStick={(x, y) => engine.current?.touchStick(x, y)}
            onButton={(bit, down) => engine.current?.touchButton(bit, down)}
            useLabel={useHint}
          />
        )}
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
