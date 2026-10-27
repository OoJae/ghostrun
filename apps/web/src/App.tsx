import { useCallback, useEffect, useRef, useState } from "react";
import { Engine, type LoadResult } from "./engine";
import { KeyHint, ProofBadge } from "./hud/Corner";
import { IntentCard } from "./hud/IntentCard";
import { PromptBar } from "./hud/PromptBar";
import { BRIEF, buildWorld, hashWorld, type Intent } from "./pipeline";
import { probe } from "./probe";

const HINT_MS = 6000;

type Status = "booting" | "building" | "playing" | "error";

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const runId = useRef(0);
  const [prompt, setPrompt] = useState(BRIEF);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [specHash, setSpecHash] = useState<string>();
  const [timing, setTiming] = useState<LoadResult | null>(null);
  const [status, setStatus] = useState<Status>("booting");
  const [error, setError] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  const [hint, setHint] = useState(false);

  const run = useCallback(async (text: string, startedAt: number, extraSplits: LoadResult["splits"] = []) => {
    const e = engine.current;
    if (!e) return;
    const id = ++runId.current;
    setStatus("building");
    setSpecHash(undefined);
    delete probe().specHash;
    const world = buildWorld(text);
    setIntent(world.intent);
    const result = await e.load(world, startedAt);
    if (id !== runId.current) return;
    setTiming({ ttffMs: result.ttffMs, splits: [...extraSplits, ...result.splits] });
    setStatus("playing");
    setHint(true);
    const h = await hashWorld(world.bundle);
    if (id !== runId.current) return;
    setSpecHash(h);
    probe().specHash = h;
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let disposed = false;
    const params = new URLSearchParams(window.location.search);
    const num = (k: string) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : undefined);
    const dpr = num("dpr");
    const msaa = num("msaa");
    Engine.create(el, {
      forceWebGL: params.get("gl") === "webgl2",
      bloom: params.get("fx") !== "0",
      ...(dpr !== undefined && { pixelRatio: Math.min(3, Math.max(0.5, dpr)) }),
      ...(msaa !== undefined && { msaa: msaa > 0 ? 4 : 0 }),
    })
      .then((e) => {
        if (disposed) {
          e.dispose();
          return;
        }
        engine.current = e;
        e.onInput = () => setCollapsed(true);
        // First load: the stopwatch runs from navigation start.
        return run(BRIEF, 0, [{ label: "gpu init", ms: e.initMs }]);
      })
      .catch((err: unknown) => {
        console.error(err);
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    return () => {
      disposed = true;
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
    run(text, performance.now()).catch((err: unknown) => {
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
          />
        </div>
        {!collapsed && intent && <IntentCard intent={intent} specHash={specHash} />}
        <ProofBadge />
        <KeyHint visible={hint && status === "playing"} />
        {status === "booting" && <div className="boot">building world…</div>}
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
