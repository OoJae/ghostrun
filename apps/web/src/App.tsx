import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeFill, pinLayout, splitObjects } from "@ghostrun/ir";
import { allRuns, better, insights, issuesOf, revealed, statusWord, type Chip, type Playtest, type Receipt } from "@ghostrun/proof/light";
// the engine stack (three, physics, navmesh, bots) is a second chunk, fetched as the shell paints
import type { Engine, LoadResult } from "./engine";
import { KeyHint } from "./hud/Corner";
import { ActsHud, type Asking } from "./hud/Acts";
import { HealthBar } from "./hud/Health";
import { LapBoard } from "./hud/Lap";
import { TouchControls } from "./hud/Touch";
import { XRay } from "./hud/XRay";
import { AskHost, ResultCard, type RunResult } from "./hud/Result";
import { IntentCard } from "./hud/IntentCard";
import { PromptBar } from "./hud/PromptBar";
import { EditBox, type EditState } from "./hud/Edit";
import { Gallery, GALLERY, type GalleryEntry } from "./hud/Gallery";
import { TrustPanel } from "./hud/Trust";
import { CutChip, ProofBadge, proofBadge, ReceiptPanel, RepairChip, type CutState, type Fooled, type ProofState, type RepairState } from "./hud/Proof";
import { liveBuild, liveDirector, liveEdit, liveHealth, liveRepair, type LiveCached, type LiveInspired, type LiveIntent } from "./live";
import type { Picture } from "./picture";
import { ANGLES, changeSummary, cutHolds, cutNotes, editedPrompt, HARDER, intentFor, newFailures, pickHarder, receiptDelta, suggestionsFor, SURPRISE } from "./edits";
import { controlsFor, lawChange, layoutChangeOf, rebuiltLine, restyled, WEATHER_WORD, type CardActions, type ShapePin } from "./card";
import { mergeEdit } from "./structure";
import { createShare, loadShare, reportWrong } from "./share";
import { Minds } from "./minds";
import { propose, twistWorld } from "./director";
import { fengShuiFor } from "./fengshui";
import { BRIEF, buildWorld, ENGINE_HASH, FIXTURE_PROMPTS, FIXTURES, hashWorld, worldFromFill, type Intent, type World } from "./pipeline";
import { probe } from "./probe";
import { LOOK_CHOICES, lookSamples, type LookPin } from "./render/pick";
import { askHost, clock as mmss, facts, story, type Fact } from "./host";
import { tourChips, tourFacts, whyFacts } from "./why";
import { useRedGreen } from "./useRedGreen";
import { useNotes } from "./useNotes";
import { designNotes } from "./notes";
import { NoteApply } from "./hud/Notes";
import { useSound } from "./audio/useSound";
import { useSpeech } from "./audio/useSpeech";
import { TalkBox } from "./hud/Talk";
import { LineagePanel } from "./hud/Lineage";
import { contextPrompt, galleryRef, lineageOf, receiptVersion, shareSource, yourChanges, type RemixSource } from "./remix";
import { MuteButton } from "./hud/Mute";
import { EXAMPLES, Landing, type Starter } from "./hud/Landing";
import { substitution } from "./substitutions";
import { RaceChip } from "./hud/Race";
import { BoardPanel } from "./hud/Board";
import { loadRace, RACE_PROMPT, useRace } from "./useRace";
import { useClip } from "./useClip";
import { clipName } from "./clip";
import { worldTitle } from "./race";
import { RecordStrip } from "./hud/RecordStrip";
import { scoreText, vrResult, type VrAction } from "./xr/model";

const HINT_MS = 6000;
/** A moment for the browser: a click returns and "changing the world…" paints before a world is rebuilt. */
const soon = () => new Promise<void>((r) => setTimeout(r, 0));
const FIXTURE = new URLSearchParams(window.location.search).get("fixture") ?? "ctf";
const FIRST_PROMPT = FIXTURE_PROMPTS[FIXTURE] ?? BRIEF;
const params0 = new URLSearchParams(window.location.search);
const TOUCH_PARAM = params0.get("touch");
/** ?record=1: a clean HUD and a caption strip, for screen-recording the demo. */
const RECORD = params0.get("record") === "1";

/** One-click prompts: the organizer's brief, the recorded worlds, and live-only stretches. */
const SUGGESTIONS: readonly { label: string; prompt: string; live?: true }[] = [
  { label: "The organizer's CTF brief", prompt: BRIEF },
  { label: "Museum heist", prompt: FIXTURE_PROMPTS.vault! },
  { label: "Glowing forest climb", prompt: FIXTURE_PROMPTS.forest! },
  { label: "Parkour time trial", prompt: FIXTURE_PROMPTS.parkour! },
  { label: "Coin rush, mind the lava", prompt: FIXTURE_PROMPTS["coin-rush"]! },
  { label: "Minimalist museum tour", prompt: "A minimalist white museum with five sculptures and a guide who explains each one.", live: true },
  { label: "Wizard duel", prompt: "A wizard duel on floating islands: knock your rival off the edge before they knock you off.", live: true },
  { label: "Bludiště s duchy (Czech)", prompt: "Bludiště s duchy: najdi klíč a uteč východem, než tě chytí.", live: true },
];

/** The landing's one-click starts: the brief, a surprise, and three recorded worlds (three looks, three packs). */
const STARTERS: readonly Starter[] = [
  { label: "The organizer's brief", prompt: BRIEF, kind: "brief" },
  { label: "Surprise me", prompt: null, kind: "surprise" },
  { label: "Museum heist", prompt: FIXTURE_PROMPTS.vault! },
  { label: "Forest climb", prompt: FIXTURE_PROMPTS.forest! },
  { label: "Coin rush", prompt: FIXTURE_PROMPTS["coin-rush"]! },
];

/** The gallery's worlds, fetched one at a time when opened. */
const GALLERY_WORLDS = import.meta.glob<{ prompt: string; intent: LiveIntent; fill: string }>("./gallery/worlds/*.json", { import: "default" });

type Status = "booting" | "building" | "playing" | "error";
type Mode = "checking" | "live" | "fixture";

const SOURCE: Record<Mode, { label: string; title: string }> = {
  checking: { label: "…", title: "checking the live AI lane" },
  live: { label: "live AI", title: "Intent and fill are generated live (Cerebras, with Claude Haiku as the fallback), streamed line by line" },
  fixture: { label: "fixture", title: "Live AI unavailable: showing the recorded CTF fixture world" },
};
/** A live world the fallback rung wrote: same proof, said plainly. */
const FELL_BACK = { label: "live AI · Haiku", title: "The fast lane was busy, so Claude Haiku (Anthropic) wrote this world. It is proved the same way." };
const MODEL_NAME: Record<string, string> = { "claude-haiku-5-5": "Claude Haiku", "claude-sonnet-5-5": "Claude Sonnet", "qwen-3.8-27b": "Qwen 3.8" };
const model = (id: string) => MODEL_NAME[id] ?? (id || "the live AI");
/** A world the edge replayed from its cache: never passed off as live, and one click from a fresh build. */
const fromCache = (c: LiveCached, fresh: () => void) => {
  const at = new Date(c.at);
  const day = at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const when = `${at.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
  return {
    label: `cached · built live ${day} by ${model(c.fillModel)}`,
    title: `Replayed from the cache, not built now: this prompt was built live on ${when} (intent by ${model(c.intentModel)}, world by ${model(c.fillModel)}), and it is proved again on your device. Build it fresh asks the AI for a new one.`,
    action: { label: "Build it fresh", run: fresh },
  };
};

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const wasmUrls = useRef<{ rapier: string; recast: string } | null>(null);
  const worker = useRef<Worker | null>(null);
  const runId = useRef(0);
  // empty: the bar shows rotating examples instead of a prompt to clear first
  const [prompt, setPrompt] = useState("");
  const [intent, setIntent] = useState<Intent | null>(null);
  /** First load, until the person builds, moves or opens the gallery: the landing line and starters. */
  const [fresh, setFresh] = useState(!params0.get("s") && !params0.get("g"));
  /** What the world does instead of a mechanic the prompt asked for (no vehicles yet, …). */
  const [note, setNote] = useState<string | null>(null);
  /** A photo or sketch the next build is inspired by, and the brief the edge read from the last one. */
  const [picture, setPicture] = useState<Picture | null>(null);
  const [inspired, setInspired] = useState<LiveInspired | null>(null);
  /** The live lane can read a picture (the edge has the Claude lane); the bar offers one only then. */
  const [canSee, setCanSee] = useState(false);
  const sound = useSound();
  const speech = useSpeech(sound);
  /** A shared or gallery world on screen: where it came from (its line, if a remix), and whether Remix made it your copy. */
  const [remixSrc, setRemixSrc] = useState<RemixSource | null>(null);
  const [copied, setCopied] = useState(false);
  const [editFocus, setEditFocus] = useState(0);
  const [specHash, setSpecHash] = useState<string>();
  const [timing, setTiming] = useState<LoadResult | null>(null);
  const [status, setStatus] = useState<Status>("booting");
  const [mode, setMode] = useState<Mode>("checking");
  const [fellBack, setFellBack] = useState(false);
  /** The live world came from the edge's cache: when and by whom it was built. */
  const [cachedFrom, setCachedFrom] = useState<LiveCached | null>(null);
  /** This live world was built with the edge's cache skipped ("Build it fresh"). */
  const [bypassed, setBypassed] = useState(false);
  /** Fill lines streamed so far while the world is built (its preview is on screen). */
  const [building, setBuilding] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  const [typing, setTyping] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [trusting, setTrusting] = useState(false);
  const [hint, setHint] = useState(false);
  const [proof, setProof] = useState<ProofState>({ status: "idle", chips: [], receipt: null });
  const [fooled, setFooled] = useState<Fooled | null>(null);
  const [routesOn, setRoutesOn] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [xray, setXray] = useState(false);
  const [vrOk, setVrOk] = useState(false);
  const [inVr, setInVr] = useState(false);
  const [score, setScore] = useState<{ red: number; blue: number; result: string | null }>({ red: 0, blue: 0, result: null });
  /** Secrets found / placed (bonus collectibles that count apart from the win). */
  const [secrets, setSecrets] = useState<{ found: number; of: number }>({ found: 0, of: 0 });
  const [teams, setTeams] = useState(true);
  const [useHint, setUseHint] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const [repair, setRepair] = useState<RepairState>({ status: "idle", issues: 0 });
  const [edit, setEdit] = useState<EditState>({ status: "idle" });
  const [cut, setCut] = useState<CutState>({ status: "idle" });
  /** The Director's cut on offer, and whether this session's first live world has had one. */
  const cutWorld = useRef<World | null>(null);
  const cutTried = useRef(false);
  const autoCut = useRef<(w: World, r: Receipt) => void>(() => undefined);
  /** Worlds before each edit, for Undo; cleared by a new prompt. */
  const history = useRef<World[]>([]);
  const builtPrompt = useRef(FIRST_PROMPT);
  /** Runs waiting on their receipt (an edit's before/after numbers). */
  const afterProof = useRef(new Map<number, (r: Receipt) => void>());
  const receiptRef = useRef<Receipt | null>(null);
  receiptRef.current = proof.receipt;
  const collapsedRef = useRef(false);
  collapsedRef.current = collapsed;
  // phones and tablets (or ?touch=1): on-screen stick and buttons; a first touch also turns them on
  const [touch, setTouch] = useState(() => TOUCH_PARAM === "1" || (TOUCH_PARAM !== "0" && window.matchMedia?.("(pointer: coarse)").matches));
  useEffect(() => {
    if (touch || TOUCH_PARAM === "0") return;
    const on = (e: PointerEvent) => e.pointerType === "touch" && setTouch(true);
    window.addEventListener("pointerdown", on);
    return () => window.removeEventListener("pointerdown", on);
  }, [touch]);
  const repaired = useRef<World | null>(null);
  /** And its receipt (a counterexample chip's red/green sets this world beside it). */
  const repairedReceipt = useRef<Receipt | null>(null);
  const current = useRef<World | null>(null);
  const minds = useRef<Minds | null>(null);
  const [bark, setBark] = useState<{ npc: string; name: string; line: string; at: number } | null>(null);
  const [talking, setTalking] = useState<{ npc: string; name: string } | null>(null);
  /** An NPC's line: the subtitle, and said out loud in its own voice. */
  const barked = (npc: string, name: string, line: string, reply: boolean) => {
    setBark({ npc, name, line, at: Date.now() });
    speech.npc(npc, line, reply);
  };
  // a speech act that spends money or books a time waits for the player's yes (hud/Acts.tsx)
  const [asking, setAsking] = useState<Asking | null>(null);
  const actHooks = { onConfirm: (npc: string, name: string, act: Asking["act"]) => setAsking({ npc, name, act }), onNote: (t: string) => setToast(t) };
  const [result, setResult] = useState<RunResult | null>(null);
  const [director, setDirector] = useState<{ line: string; label: string; status: "proving" | "ready"; world?: World } | null>(null);
  const [reported, setReported] = useState<string>();
  const pending = useRef(new Map<number, { onChip?: (c: Chip) => void; onPlaytest?: (p: Playtest | null) => void; resolve: (r: Receipt) => void; reject: (e: Error) => void }>());
  const modeRef = useRef<Mode>("checking");
  modeRef.current = mode;
  // racing: the proof's par runner (or a run someone sent) as a ghost beside the player
  const race = useRace({ engine, world: current.current, loaded: timing, result, receipt: proof.receipt, specHash, prompt, urls: wasmUrls, toast: setToast, again: () => againRef.current() });
  // red/green: the same AI runner before and after a change, side by side
  const redGreen = useRedGreen({ engine, urls: wasmUrls });
  // the run's clip: the last seconds of it, cut where it ended, or a clean replay of it for a demo
  const clip = useClip({
    canvas,
    tap: sound.tap,
    active: status === "playing" && !inVr,
    loaded: timing,
    result,
    name: (r, ext, take) => clipName(current.current ? worldTitle(current.current, prompt === RACE_PROMPT ? "" : prompt) : "world", r.tick, ext, take ? "replay" : ""),
    replay: engine.current?.rapierSim ? (r, back) => replayMoment(r.tick, back) : null,
    toast: setToast,
  });
  // the playtest landed while the runners' overview is up: draw its heat map in too
  const playtest = proof.receipt?.playtest;
  useEffect(() => {
    const w = current.current;
    if (routesOn && playtest && w && receiptRef.current) engine.current?.showTrails(receiptRef.current.trails ?? null, revealed(w.bundle, receiptRef.current)?.heat ?? null);
  }, [playtest]); // (only when it lands: the toggle draws the overview itself)

  /**
   * One proof on the device worker; several can be in flight (the world, and a repair of it).
   * With onPlaytest the worker goes on to the playtest once the receipt is out, and sends it after.
   */
  const proveOnDevice = useCallback((world: World, id: number, onChip?: (c: Chip) => void, onPlaytest?: (p: Playtest | null) => void): Promise<Receipt> => {
    if (!worker.current) {
      worker.current = new Worker(new URL("./proof.worker.ts", import.meta.url), { type: "module" });
      worker.current.onmessage = (e: MessageEvent<{ id: number; chip?: Chip; receipt?: Receipt; playtest?: Playtest | null; error?: string }>) => {
        const p = pending.current.get(e.data.id);
        if (!p) return;
        if (e.data.chip) p.onChip?.(e.data.chip);
        if (e.data.receipt) {
          if (!p.onPlaytest) pending.current.delete(e.data.id); // (else the playtest follows)
          p.resolve(e.data.receipt);
        }
        if (e.data.playtest !== undefined) (pending.current.delete(e.data.id), p.onPlaytest?.(e.data.playtest));
        if (e.data.error) (pending.current.delete(e.data.id), p.reject(new Error(e.data.error)));
      };
    }
    const w = worker.current;
    return new Promise((resolve, reject) => {
      pending.current.set(id, { ...(onChip ? { onChip } : {}), ...(onPlaytest ? { onPlaytest } : {}), resolve, reject });
      w.postMessage({ id, bundle: world.bundle, engine: ENGINE_HASH, urls: wasmUrls.current, ...(onPlaytest ? { playtest: true } : {}) });
    });
  }, []);

  /**
   * Counterexample-guided repair for live worlds: the receipt's failures go to /v1/repair, the
   * patch is merged, re-placed and re-proved here, and offered only if its receipt is better
   * (up to three rounds, each building on the last accepted one).
   */
  const maybeRepair = useCallback(async (world: World, receipt: Receipt, id: number) => {
    if (!world.source || modeRef.current !== "live") return;
    const first = issuesOf(receipt, world.bundle, world.fillNotes);
    if (!first.length) return;
    // up to three rounds: each accepted patch is the base for the next, while it keeps getting better
    let base = world;
    let best: { world: World; receipt: Receipt; round: number } | null = null;
    for (let round = 1; round <= 3; round++) {
      const src = base.source!;
      const now = best?.receipt ?? receipt;
      const issues = issuesOf(now, base.bundle, base.fillNotes);
      if (!issues.length) break;
      setRepair({ status: "working", issues: issues.length, round });
      const patch = await liveRepair(src.prompt, src.intent as LiveIntent, src.fill, issues, src.seed);
      if (id !== runId.current) return;
      if (!patch) break;
      // after a person's edit the expectations are the world's promises: a fix may change the world, never the claim
      const merged = mergeFill(src.fill, patch, { edit: Boolean(src.edits?.length) }).text;
      const w2 = worldFromFill(merged, src.seed, base.intent.live, src.pack);
      w2.source = { ...src, fill: merged };
      let r2: Receipt;
      try {
        r2 = await proveOnDevice(w2, -id * 10 - round);
      } catch {
        break;
      }
      if (id !== runId.current) return;
      if (!better(r2, now)) break;
      best = { world: w2, receipt: r2, round };
      base = w2;
    }
    // the fast lane couldn't fix it all: one round on the stronger model before giving up
    let hard = false;
    const still = best ? issuesOf(best.receipt, best.world.bundle, best.world.fillNotes) : first;
    if (still.length) {
      const src = base.source!;
      setRepair({ status: "working", issues: still.length, hard: true });
      const patch = await liveRepair(src.prompt, src.intent as LiveIntent, src.fill, still, src.seed, true);
      if (id !== runId.current) return;
      if (patch) {
        const merged = mergeFill(src.fill, patch, { edit: Boolean(src.edits?.length) }).text;
        const w3 = worldFromFill(merged, src.seed, base.intent.live, src.pack);
        w3.source = { ...src, fill: merged };
        const r3 = await proveOnDevice(w3, -id * 10 - 9).catch(() => null);
        if (id !== runId.current) return;
        if (r3 && better(r3, best?.receipt ?? receipt)) ((best = { world: w3, receipt: r3, round: (best?.round ?? 0) + 1 }), (hard = true));
      }
    }
    if (!best) return setRepair({ status: "failed", issues: first.length });
    repaired.current = best.world;
    repairedReceipt.current = best.receipt;
    const left = best.receipt.chips.filter((c) => c.status === "counterexample").length;
    setRepair({ status: "offer", issues: first.length, left, round: best.round, hard, ...(best.receipt.headline ? { headline: `${best.receipt.headline.text} (${statusWord(best.receipt.headline.status)})` } : {}) });
  }, [proveOnDevice]);

  /** Prove the world on the device worker (until the edge proof service is deployed). */
  const startProof = useCallback((world: World, id: number) => {
    setProof({ status: "proving", chips: [], receipt: null });
    setRepair({ status: "idle", issues: 0 });
    setFooled(null);
    setRoutesOn(false);
    // the receipt turns green as soon as it is out; the playtest (the difficulty band, what the
    // runners revealed) lands on it after
    const played = (pt: Playtest | null) => id === runId.current && setProof((p) => ({ ...p, playing: false, ...(pt && p.receipt ? { receipt: { ...p.receipt, playtest: pt } } : {}) }));
    proveOnDevice(world, id, (chip) => id === runId.current && setProof((p) => ({ ...p, chips: [...p.chips, chip] })), played)
      .then((receipt) => {
        if (id !== runId.current) return;
        setProof((p) => ({ ...p, status: "done", receipt, playing: true }));
        race.proved(world, receipt);
        void redGreen.landed(world, receipt);
        probe().proof = { headline: receipt.headline?.status ?? "none", chips: receipt.chips.length };
        afterProof.current.get(id)?.(receipt);
        afterProof.current.delete(id);
        void maybeRepair(world, receipt, id);
        autoCut.current(world, receipt);
      })
      .catch((err: Error) => id === runId.current && setProof((p) => ({ ...p, status: "error", error: err.message })));
  }, [proveOnDevice, maybeRepair]);

  const show = useCallback(
    async (world: World, id: number, startedAt: number, extra: LoadResult["splits"]) => {
      const e = engine.current;
      if (!e) return;
      setIntent(world.intent);
      setNote(substitution(world.source?.base ?? world.source?.prompt ?? builtPrompt.current, world.bundle));
      setScore({ red: 0, blue: 0, result: null });
      const bonus = new Set(world.bundle.entities.filter((e) => e.tags.includes("bonus")).map((e) => e.id));
      setSecrets({ found: 0, of: bonus.size });
      redGreen.leaving(current.current, receiptRef.current, world);
      if (current.current !== world) notes.reset();
      current.current = world;
      setReported(undefined);
      setResult(null);
      setDirector(null);
      setAsking(null); // (a yes asked in the world before)
      setCut({ status: "idle" });
      cutWorld.current = null;
      const result = await e.load(world, startedAt);
      if (id !== runId.current) return;
      setTiming({ ttffMs: result.ttffMs, splits: [...extra, ...result.splits] });
      setStatus("playing");
      setBuilding(null);
      setHint(true);
      const sim = e.rapierSim;
      setTeams(world.bundle.rules.some((r) => r.then.some((fx) => fx.target === "team:blue" && fx.e !== "damage" && fx.e !== "heal")));
      setUseHint(null);
      setToast(null);
      if (sim) {
        minds.current?.stop();
        minds.current = modeRef.current === "live" ? new Minds(world, sim, barked, actHooks) : null;
        sim.onEvents = (evs) => {
          minds.current?.observe(evs);
          for (const ev of evs) {
            if (ev.k === "score") setScore((s) => ({ ...s, [ev.a === "team:blue" ? "blue" : "red"]: Number(ev.v) }));
            if (ev.k === "win" || ev.k === "lose") {
              setScore((s) => ({ ...s, result: ev.k }));
              const res: RunResult = { k: ev.k, tick: ev.tick, rule: ev.rule, story: story(world.bundle, sim.sim.log, sim.trail), facts: [...facts(world.bundle, sim.sim.log, sim.trail), ...whyFacts(world.bundle, sim.sim.log, sim.trail, receiptRef.current)].slice(0, 40) };
              setResult(res);
              void directorFor(world, sim.trail, res, id);
            }
            if (ev.k === "touch" && ev.a === "player" && ev.v) setToast(String(ev.v)); // an inspected exhibit's text
            if (ev.k === "touch" && ev.a === "player" && bonus.has(ev.b)) setSecrets((x) => ({ ...x, found: x.found + 1 }));
          }
        };
        sim.onHint = setUseHint;
      }
      sound.world(world.bundle, sim, world.cue);
      speech.world(world.bundle);
      startProof(world, id);
      const h = await hashWorld(world.bundle);
      if (id !== runId.current) return;
      setSpecHash(h);
      probe().specHash = h;
    },
    [startProof],
  );

  const run = useCallback(
    async (text: string, startedAt: number, extraSplits: LoadResult["splits"] = [], useLive = false, rebuild = false, image: Picture | null = null) => {
      const id = ++runId.current;
      setStatus("building");
      setNotice(undefined);
      history.current = [];
      setEdit({ status: "idle" });
      setRemixSrc(null);
      builtPrompt.current = text;
      setSpecHash(undefined);
      setFellBack(false);
      setCachedFrom(null);
      setBypassed(useLive && rebuild);
      setBuilding(null);
      setProof({ status: "idle", chips: [], receipt: null });
      delete probe().specHash;
      if (useLive) {
        if (image) setNotice("Looking at your image…");
        const r = await liveBuild(text, {
          fresh: rebuild,
          ...(image ? { image: image.url } : {}),
          // the world is written from the brief's words: they are its prompt from here on (edits, repairs, shares)
          onInspired: (i) => {
            if (id !== runId.current) return;
            builtPrompt.current = i.prompt;
            setInspired(i);
            setNotice(`Inspired by your image: ${i.brief.setting} (${i.ms} ms)`);
          },
          onIntent: (i, ms, seed) => {
            if (id !== runId.current) return;
            setNotice(`${i.genre} · ${i.setting.slice(0, 80)} (${ms} ms)`);
            // the layout follows from the intent alone: it rises while the fill streams in
            engine.current?.materialise({ pack: i.pack, sub: i.sub, seed, look: `${i.setting} ${i.mood}` });
            setBuilding(0);
          },
          onLine: (n, draft) => {
            if (id !== runId.current) return;
            engine.current?.materialiseLine(draft);
            setBuilding(n);
          },
        });
        if (id !== runId.current) return;
        if (r.kind === "world") {
          const world = worldFromFill(r.fill, r.seed, { genre: r.intent.genre, setting: r.intent.setting, goal: r.intent.goal, fail: r.intent.fail, role: r.intent.role }, r.intent.pack, r.intent.mode);
          world.source = { prompt: r.inspired?.prompt ?? text, intent: r.intent, fill: r.fill, seed: r.seed, pack: r.intent.pack };
          setNotice(undefined);
          setFellBack(r.fallback !== null);
          setCachedFrom(r.cached);
          await show(world, id, startedAt, [...extraSplits, { label: r.cached ? "intent (cached)" : "intent", ms: r.intentMs }, { label: r.cached ? "fill (cached)" : r.fallback ? `fill (${r.fallback})` : "fill", ms: r.gameplayMs - r.intentMs }]);
          return;
        }
        setBuilding(null);
        if (r.kind === "refused") {
          engine.current?.endPreview();
          setNotice(r.message);
          setStatus("playing");
          return;
        }
        if (image) {
          // a picture the edge couldn't read leaves the live lane as it was: the words alone still build
          engine.current?.endPreview();
          setNotice(`Couldn't build from the image just now (${r.reason.slice(0, 60)}). Try again, or remove it to build from words alone.`);
          setStatus("playing");
          return;
        }
        setNotice(`Live AI unavailable (${r.reason.slice(0, 60)}): showing the fixture world instead.`);
        setMode("fixture");
      }
      // offline: a recorded world's own prompt opens that world (the URL's fixture otherwise)
      const recorded = Object.entries(FIXTURE_PROMPTS).find(([, p]) => p === text)?.[0];
      await show(buildWorld(text, recorded ?? FIXTURE), id, startedAt, extraSplits);
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
    void liveHealth().then((h) => {
      if (disposed) return;
      setMode(h.llm && params.get("live") !== "0" ? "live" : "fixture");
      setCanSee(h.vision);
    });
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
        e.onInput = () => (setCollapsed(true), setFresh(false));
        e.onVrAction = (a) => vrAct.current(a);
        sound.attach(e);
        void e.vrSupported().then((ok) => !disposed && setVrOk(ok));
        probe().sim = "stub";
        // the proof worker needs the wasm URLs whichever simulation plays here (boot is tiny)
        const boot = await import("./sim/boot");
        wasmUrls.current = boot.WASM_URLS;
        if (params.get("sim") !== "stub") {
          try {
            const [{ loadRapier, loadNav }, { RapierSim }] = [boot, await import("./sim/rapier")];
            const [R, bots] = await Promise.all([loadRapier(), loadNav()]);
            e.simFactory = (b) => new RapierSim(R, b, bots);
            probe().sim = "rapier";
          } catch (err) {
            console.warn("Rapier unavailable, using the stub simulation", err);
            probe().sim = "stub";
          }
        }
        // A race link opens that run's world with the run as the ghost to beat (replayed here first,
        // so it starts with you); a share link opens that run (rebuilt from its fill, replayed frame
        // for frame); otherwise the recorded world appears instantly and Enter builds live.
        const raced = params.get("race") ? await loadRace(params.get("race")!, params.get("by"), boot.WASM_URLS) : null;
        const shared = !raced && params.get("s") ? await loadShare(params.get("s")!) : null;
        if (raced && !disposed) {
          setPrompt(RACE_PROMPT);
          setFellBack(false);
          await show(raced.world, ++runId.current, 0, [{ label: "gpu init", ms: e.initMs }]);
          if (raced.rival) race.setFriend(raced.world, raced.rival);
          setToast(raced.message);
        } else if (shared && !disposed) {
          setPrompt("Shared run");
          setFellBack(false);
          // an edit of it is told what was asked for (the original prompt and the changes since)
          const src = shareSource(params.get("s")!, shared.record);
          builtPrompt.current = contextPrompt(src) || builtPrompt.current;
          setRemixSrc(src);
          await show(shared.world, ++runId.current, 0, [{ label: "gpu init", ms: e.initMs }]);
          const sim = e.rapierSim;
          if (sim) {
            sim.replay(shared.record.inputs, shared.record.minds ?? []);
            sim.onReplayEnd = () => setNotice(undefined);
          }
          setNotice(shared.exact ? "Shared run: replaying exactly as played. Press any key to take over." : "Shared run from another version: the world rebuilt, but the replay may drift.");
        } else if (GALLERY.some((g) => g.slug === params.get("g")) && !disposed) {
          await openGallery(GALLERY.find((g) => g.slug === params.get("g"))!); // a remix's link to its original
        } else {
          if (params.get("s") || params.get("race")) setNotice(`That ${params.get("race") ? "race" : "share"} link wasn't found.`);
          await run(FIRST_PROMPT, 0, [{ label: "gpu init", ms: e.initMs }]);
        }
        // While the player reads and types: compile every look's and kit's shaders in the background.
        if (!disposed && params.get("prewarm") !== "0") {
          const samples = Object.keys(FIXTURES).map((k) => buildWorld("", k).bundle);
          const day = structuredClone(samples.find((b) => b.pack.id === "outdoor"));
          if (day) samples.push({ ...day, cosmetic: { ...day.cosmetic, look: "forest", timeOfDay: 12 } });
          samples.push(...lookSamples(samples)); // one of every newer look, so its shaders are ready too
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
      if (ev.code === "KeyG") setGallery((o) => !o);
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
    if (sim && w) minds.current = new Minds(w, sim, barked, actHooks);
  }, [mode, status]);

  useEffect(() => {
    if (gallery) setFresh(false);
  }, [gallery]);

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
    // a remix carries its line; any share says the prompt it was built from
    const line = lineageOf(remixSrc, w);
    const url = await createShare(w, specHash, sim.inputs, sim.minds, { prompt: line?.origin.prompt || w.source?.base || w.source?.prompt || builtPrompt.current, line });
    if (!url) return setToast("Sharing needs the live service, which isn't reachable.");
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    setToast(`Link copied: ${url}`);
  };

  /**
   * Remix: the shared or gallery world on screen as your own copy (a shared run stops replaying and
   * starts from the top), with the cursor in the edit box; your first accepted edit makes it a remix.
   */
  const remix = () => {
    const w = current.current;
    if (!w || !remixSrc) return;
    setCopied(true);
    setResult(null);
    setNotice(undefined);
    setCollapsed(false);
    history.current = [];
    setEdit({ status: "idle" });
    if (remixSrc.kind === "share") void show(w, ++runId.current, performance.now(), []).then(() => setEditFocus((n) => n + 1));
    else setEditFocus((n) => n + 1);
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

  /**
   * The person's own change: the model patches the world by stable ids, the world swaps in place
   * (same seed, same geometry: see pinLayout) and is re-proved, and the edit comes back with how
   * the receipt moved. A change that breaks a promise shows up as a counterexample, and the repair
   * loop then offers a fix like for any other live world.
   */
  const editWorld = async (change: string) => {
    const w = current.current;
    if (!w || modeRef.current !== "live") return;
    if (SURPRISE.test(change) && receiptRef.current) return void cutFor(w, receiptRef.current, true);
    if (HARDER.test(change) && w.bundle.mode === "play" && receiptRef.current) return raceHarder(w, change, receiptRef.current);
    const base = runId.current;
    const t0 = performance.now();
    setEdit({ status: "editing", change });
    const original = w.source?.base ?? w.source?.prompt ?? builtPrompt.current;
    const patch = await liveEdit(editedPrompt(original, w.source?.edits ?? []), change, intentFor(w, original), pinLayout(w.fill), w.seed);
    if (runId.current !== base) return;
    if (!patch) return setEdit({ status: "failed", change, message: "The live AI couldn't make that change just now. Try again, or say it differently." });
    await applyEdit(w, change, patch, t0);
  };

  /**
   * A patch on the world, the model's or the Intent card's own: merged by stable ids (a layout op
   * settled and re-anchored), placed, re-proved, and back with how the receipt moved, and Undo.
   */
  const applyEdit = async (w: World, change: string, patch: string, t0: number) => {
    const before = receiptRef.current;
    const original = w.source?.base ?? w.source?.prompt ?? builtPrompt.current;
    const edits = [...(w.source?.edits ?? []), change];
    const fill0 = pinLayout(w.fill);
    const { text, stats, layout } = mergeEdit(fill0, patch, w.seed);
    const w2 = worldFromFill(text, w.seed, w.intent.live, w.bundle.pack.id, w.bundle.mode);
    const summary = [...(layout?.summary ?? []), ...changeSummary(w.bundle, w2.bundle)];
    if (!summary.length && text.trim() === fill0.trim()) return setEdit({ status: "failed", change, message: stats.locked ? "That would only change what the world promises, and the proof keeps those fixed." : "Nothing in the world changed. Try saying it differently." });
    if (layout?.notes.length) w2.notes.unshift(...layout.notes);
    w2.source = { prompt: editedPrompt(original, edits), intent: intentFor(w, original), fill: w2.fill, seed: w.seed, pack: w2.bundle.pack.id, base: original, edits, ...(w.source?.pinned ? { pinned: w.source.pinned } : {}) };
    history.current.push(w);
    const shown = summary.length ? summary : [`${stats.replaced + stats.added + stats.deleted} lines changed`];
    const notes = layout?.notes ?? [];
    setEdit({ status: "proving", change, summary: shown, locked: stats.locked, notes });
    const id = ++runId.current;
    afterProof.current.set(id, (after) => {
      const delta = before ? receiptDelta(before, after) : null;
      setEdit({ status: "done", change, summary: shown, locked: stats.locked, delta, failures: before ? newFailures(before, after) : [], notes });
      if (collapsedRef.current && delta?.length) setToast(`Edit re-proved: ${delta.slice(0, 2).map((d) => `${d.label} ${d.from} → ${d.to}`).join(" · ")}`);
    });
    await show(w2, id, t0, [{ label: "edit", ms: performance.now() - t0 }]);
  };

  /** Worlds that differ from the one before them only in how they look (Undo redraws them in place too). */
  const restyledWorlds = useRef(new WeakSet<World>());
  /**
   * The Intent card's look, hour or weather: the same world redrawn in place around the running
   * game (nothing the proof reads changed, so the spec and the receipt stand), with Undo.
   */
  const restyleWorld = async (change: LookPin, said: string, what: string) => {
    const w = current.current;
    const e = engine.current;
    if (!w || !e) return;
    await soon(); // the click lands (its picker closes) before the scene is rebuilt
    const w2 = worldFromFill(restyled(w.fill, change), w.seed, w.intent.live, w.bundle.pack.id, w.bundle.mode);
    // one of the world's changes, as a typed "make it night" is (a remix's line lists it)
    const original = w.source?.base ?? w.source?.prompt ?? builtPrompt.current;
    const edits = [...(w.source?.edits ?? []), said];
    w2.source = { prompt: editedPrompt(original, edits), intent: intentFor(w, original), fill: w2.fill, seed: w.seed, pack: w2.bundle.pack.id, base: original, edits, ...(w.source?.pinned ? { pinned: w.source.pinned } : {}) };
    history.current.push(w);
    restyledWorlds.current.add(w2);
    await redraw(w2);
    setEdit({ status: "done", change: said, summary: [what, "the same spec: the receipt stands"], locked: 0, delta: null, failures: [] });
  };
  /** Swap in a world that only looks different: the scene restyled under the sim (a fresh load if there's none to restyle). */
  const redraw = async (w: World) => {
    current.current = w;
    setIntent(w.intent);
    if (!(await engine.current?.restyle(w))) return show(w, ++runId.current, performance.now(), []);
    sound.world(w.bundle, engine.current?.rapierSim ?? null, w.cue); // its rain, its music
    const h = await hashWorld(w.bundle);
    setSpecHash(h);
    probe().specHash = h;
  };

  /**
   * The Intent card's pack, mode or genre: a new fill, built live with those pinned (the same words
   * and seed; the intent model fits the rest to them), shown as "rebuilt as a maze at your request",
   * with Undo back to the world before. Pins from an earlier rebuild stay pinned.
   */
  const rebuildAs = async (pin: ShapePin) => {
    const w = current.current;
    if (!w || modeRef.current !== "live") return;
    const base = runId.current;
    const t0 = performance.now();
    const before = receiptRef.current;
    const pinned = { ...w.source?.pinned, ...pin };
    const change = rebuiltLine(pin);
    const prompt = w.source?.base ?? w.source?.prompt ?? builtPrompt.current;
    setEdit({ status: "editing", change });
    const r = await liveBuild(prompt, {
      intent: pinned,
      seed: w.seed,
      onIntent: (i, _ms, seed) => runId.current === base && (engine.current?.materialise({ pack: i.pack, sub: i.sub, seed, look: `${i.setting} ${i.mood}` }), setBuilding(0)),
      onLine: (n, draft) => runId.current === base && (engine.current?.materialiseLine(draft), setBuilding(n)),
    });
    if (runId.current !== base) return;
    if (r.kind !== "world") {
      engine.current?.endPreview();
      setBuilding(null);
      return setEdit({ status: "failed", change, message: r.kind === "refused" ? r.message : "The live AI couldn't rebuild it just now. Try again in a moment." });
    }
    const w2 = worldFromFill(r.fill, r.seed, { genre: r.intent.genre, setting: r.intent.setting, goal: r.intent.goal, fail: r.intent.fail, role: r.intent.role }, r.intent.pack, r.intent.mode);
    w2.source = { prompt, intent: r.intent, fill: r.fill, seed: r.seed, pack: r.intent.pack, pinned };
    history.current.push(w);
    const was = intentFor(w, prompt);
    const summary = [
      w.bundle.pack.id !== w2.bundle.pack.id ? `pack ${w.bundle.pack.id} → ${w2.bundle.pack.id}` : "",
      w.bundle.mode !== w2.bundle.mode ? `mode ${w.bundle.mode} → ${w2.bundle.mode}` : "",
      pin.genre && was.genre !== r.intent.genre ? `genre ${was.genre || "game"} → ${r.intent.genre}` : "",
      `${w2.bundle.entities.length} things, ${w2.bundle.rules.length} rules`,
    ].filter(Boolean);
    setFellBack(r.fallback !== null);
    setCachedFrom(r.cached);
    setEdit({ status: "proving", change, summary, locked: 0 });
    const id = ++runId.current;
    afterProof.current.set(id, (after) => setEdit({ status: "done", change, summary, locked: 0, delta: before ? receiptDelta(before, after) : null, failures: [] }));
    await show(w2, id, t0, [{ label: r.cached ? "rebuild (cached)" : "rebuild", ms: performance.now() - t0 }]);
  };

  /** The card's corrections, each the way it has to be made (card.ts). */
  const cardActs: CardActions = {
    onLook: (v) => {
      const name = LOOK_CHOICES.find((c) => c.value === v)?.label ?? v;
      void restyleWorld({ look: v }, `make it look like ${name.toLowerCase()}`, `look: ${name}`);
    },
    onPhase: (p) => void restyleWorld({ phase: p }, `make it ${p === "day" ? "daytime" : p}`, `now ${p}`),
    onWeather: (x) => void restyleWorld({ weather: x as NonNullable<LookPin["weather"]> }, x === "clear" ? "clear skies" : `make it ${WEATHER_WORD[x] ?? x}`, x === "clear" ? "skies clear" : `now ${x}`),
    onLaws: (c) => {
      const w = current.current;
      if (!w) return;
      const { change, patch } = lawChange(w.bundle.laws, c);
      setEdit({ status: "editing", change });
      void soon().then(() => applyEdit(w, change, patch, performance.now()));
    },
    onLayout: (c) => {
      const w = current.current;
      const ch = w && layoutChangeOf(w.fill, c);
      if (!w || !ch) return;
      setEdit({ status: "editing", change: ch.change });
      void soon().then(() => applyEdit(w, ch.change, ch.patch, performance.now()));
    },
    onShape: (pin) => void rebuildAs(pin),
  };

  /** "Try to fool it": the next plantable bug, proved in a copy of the world by its own worker. */
  const foolK = useRef(0);
  const tryFool = () => {
    const w = current.current;
    if (!w || !proof.receipt) return;
    const k = foolK.current++;
    const base = runId.current;
    setFooled({ status: "planting", k });
    const wk = new Worker(new URL("./proof.worker.ts", import.meta.url), { type: "module" });
    wk.onmessage = (e: MessageEvent<{ fooled?: { text: string; at: string | null; of: number; caught: boolean; by: string | null } | null; error?: string }>) => {
      if (!("fooled" in e.data) && !e.data.error) return;
      wk.terminate();
      if (runId.current !== base) return;
      const f = e.data.fooled;
      if (!f) return setFooled({ status: "none" });
      setFooled({ status: "done", text: f.text, caught: f.caught, by: f.by, k, of: f.of });
      if (f.at) engine.current?.highlight(f.at);
    };
    wk.postMessage({ id: 1, bundle: w.bundle, engine: ENGINE_HASH, urls: wasmUrls.current, fool: { k, parS: proof.receipt.par?.goldS ?? null } });
  };

  /**
   * A one-off proof in its own worker (candidate races run several at once, then free them). With
   * `skill` runners per lower level it waits for the playtest too, and the receipt carries its band.
   */
  const proveOnce = (world: World, runs: number, skill = 0) =>
    new Promise<Receipt>((resolve, reject) => {
      const wk = new Worker(new URL("./proof.worker.ts", import.meta.url), { type: "module" });
      const done = (f: () => void) => (wk.terminate(), f());
      let first: Receipt | null = null;
      wk.onmessage = (e: MessageEvent<{ receipt?: Receipt; playtest?: Playtest | null; error?: string }>) => {
        if (e.data.receipt && !skill) done(() => resolve(e.data.receipt!));
        else if (e.data.receipt) first = e.data.receipt;
        const r = first;
        if (e.data.playtest !== undefined && r) done(() => resolve(e.data.playtest ? { ...r, playtest: e.data.playtest } : r));
        if (e.data.error) done(() => reject(new Error(e.data.error)));
      };
      wk.onerror = (e) => done(() => reject(new Error(e.message)));
      wk.postMessage({ id: 1, bundle: world.bundle, engine: ENGINE_HASH, urls: wasmUrls.current, runs, ...(skill ? { playtest: true, skillRuns: skill } : {}) });
    });

  /**
   * "Make it harder but fair": one candidate per angle (obstacles, pressure, a longer route), each
   * proved by AI runners in parallel; the hardest candidate that is still fair is kept, and every
   * candidate's verdict is shown with its numbers. None fair: the world stays as it was.
   */
  const raceHarder = async (w: World, change: string, before: Receipt) => {
    const base = runId.current;
    const t0 = performance.now();
    setEdit({ status: "racing", change, total: ANGLES.length, proved: 0 });
    const original = w.source?.base ?? w.source?.prompt ?? builtPrompt.current;
    const edits = [...(w.source?.edits ?? []), change];
    const fill0 = pinLayout(w.fill);
    const intent = intentFor(w, original);
    const prompt = editedPrompt(original, edits.slice(0, -1));
    const patches = await Promise.all(ANGLES.map((a) => liveEdit(prompt, `${change}: ${a}`, intent, fill0, w.seed)));
    if (runId.current !== base) return;
    const worlds = patches.map((p) => (p ? worldFromFill(mergeEdit(fill0, p, w.seed).text, w.seed, w.intent.live, w.bundle.pack.id, w.bundle.mode) : null));
    if (!worlds.some(Boolean)) return setEdit({ status: "failed", change, message: "The live AI couldn't write the harder versions just now. Try again in a moment." });
    let proved = 0;
    const lanes = Math.max(1, Math.min(worlds.length, (navigator.hardwareConcurrency || 4) - 2));
    const receipts: (Receipt | null)[] = worlds.map(() => null);
    const queue = worlds.map((c, i) => [c, i] as const).filter(([c]) => c);
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          // 6 experts, then 3 novices and 3 average players: enough to say whether it's a band harder
          receipts[job[1]] = await proveOnce(job[0]!, 6, before.playtest ? 3 : 0).catch(() => null);
          if (runId.current === base) setEdit({ status: "racing", change, total: ANGLES.length, proved: ++proved });
        }
      }),
    );
    if (runId.current !== base) return;
    const { best, verdicts } = pickHarder(before, receipts);
    if (best === null) return setEdit({ status: "failed", change, message: "None of the harder versions stayed fair, so the world is unchanged.", race: verdicts });
    const w2 = worlds[best]!;
    w2.source = { prompt: editedPrompt(original, edits), intent, fill: w2.fill, seed: w.seed, pack: w2.bundle.pack.id, base: original, edits };
    history.current.push(w);
    // the race proved with 6 runners each; the kept world's numbers come from its full proof
    const summary = changeSummary(w.bundle, w2.bundle);
    const id = ++runId.current;
    setEdit({ status: "proving", change, summary, locked: 0, race: verdicts });
    afterProof.current.set(id, (full) => setEdit({ status: "done", change, summary, locked: 0, delta: receiptDelta(before, full), failures: newFailures(before, full), race: verdicts }));
    await show(w2, id, t0, [{ label: "race", ms: performance.now() - t0 }]);
  };

  /**
   * The Director's cut: Claude Sonnet reworks a world that plays into the best version of its
   * prompt (a signature upgrade, more to use, voices for the cast, one twist). It is proved in its
   * own worker while you play and offered only if it plays at least as well; Apply swaps it in
   * between runs, and Undo brings the old world back. `asked`: the person said "surprise me", so a
   * cut that doesn't hold up is reported instead of dropped quietly.
   */
  const cutFor = async (w: World, before: Receipt, asked = false) => {
    if (modeRef.current !== "live") return;
    const base = runId.current;
    const quiet = (why: string) => (setCut({ status: "idle" }), asked && setToast(why));
    setCut({ status: "working" });
    const original = w.source?.base ?? w.source?.prompt ?? builtPrompt.current;
    const edits = w.source?.edits ?? [];
    const fill0 = pinLayout(w.fill);
    const patch = await liveDirector(editedPrompt(original, edits), intentFor(w, original), fill0, cutNotes(w.bundle, before), w.seed);
    if (runId.current !== base) return;
    if (!patch) return quiet("The Director's cut isn't available just now.");
    const { text } = mergeEdit(fill0, patch, w.seed);
    const w2 = worldFromFill(text, w.seed, w.intent.live, w.bundle.pack.id, w.bundle.mode);
    const summary = changeSummary(w.bundle, w2.bundle);
    if (!summary.length) return quiet("The Director's cut changed nothing in this world.");
    w2.source = { prompt: editedPrompt(original, edits), intent: intentFor(w, original), fill: w2.fill, seed: w.seed, pack: w2.bundle.pack.id, base: original, edits };
    setCut({ status: "proving", summary });
    const after = await proveOnce(w2, 12).catch(() => null);
    if (runId.current !== base) return;
    if (!after || !cutHolds(before, after)) return quiet("The Director's cut didn't play as well as your world, so it wasn't offered.");
    cutWorld.current = w2;
    setCut({ status: "offer", summary });
  };
  // the first live world of the session that proves clean gets one without asking
  autoCut.current = (w, r) => {
    if (cutTried.current || modeRef.current !== "live" || !w.source || w.source.edits?.length || r.chips.some((c) => c.status === "counterexample")) return;
    cutTried.current = true;
    void cutFor(w, r);
  };

  /** Apply the Director's cut between runs: shown like an edit (what changed, how the receipt moved), with Undo. */
  const applyCut = () => {
    const w2 = cutWorld.current;
    if (!w2 || !current.current) return;
    cutWorld.current = null;
    setCut({ status: "idle" });
    applyChange(w2, "Director's cut (Claude Sonnet)", receiptRef.current);
  };

  /** A re-proved change on offer (the Director's cut, a design note) swapped in like an edit, with Undo. */
  const applyChange = (w2: World, change: string, before: Receipt | null) => {
    const w = current.current;
    if (!w) return;
    history.current.push(w);
    const summary = changeSummary(w.bundle, w2.bundle);
    setEdit({ status: "proving", change, summary, locked: 0 });
    const id = ++runId.current;
    afterProof.current.set(id, (after) => setEdit({ status: "done", change, summary, locked: 0, delta: before ? receiptDelta(before, after) : null, failures: before ? newFailures(before, after) : [] }));
    void show(w2, id, performance.now(), []);
  };

  const notes = useNotes({ world: () => current.current, receipt: () => receiptRef.current, prompt: () => builtPrompt.current, proveOnce, apply: (w2, change, before) => applyChange(w2, change, before) });
  const noteList = useMemo(() => {
    const w = current.current;
    const r = proof.receipt;
    const fs = fengShuiFor(w, w?.source?.base ?? w?.source?.prompt ?? builtPrompt.current)?.section ?? null;
    return w && r ? new Map(designNotes(w.bundle, r.trails ? insights(w.bundle, allRuns(r)) : null, r.trails ? revealed(w.bundle, r) : null, fs).map((n) => [n.key, n])) : new Map<string, never>();
  }, [proof.receipt]);

  /**
   * The Host's fly-to: the camera to the place a cited fact names (over the walls, about 1.2 s),
   * and for a moment of the run, its replay from a second before it, under the held shot. Esc or
   * any input hands the camera (and the run, from where the replay got to) back.
   */
  const flyTo = async (f: Fact) => {
    const e = engine.current;
    if (!e || !f.at) return;
    const { FlyShot } = await import("./render/shots");
    const shot: InstanceType<typeof FlyShot> = new FlyShot(e.stage, f.at, {
      onArrive: () => {
        if (f.tick === null || engine.current?.playing !== shot) return;
        shot.keep = 1; // through the replay's rebuild of the world
        replayMoment(f.tick, 60, "Esc or any key takes over");
      },
      onEnd: () => {
        const sim = engine.current?.rapierSim;
        if (sim?.replaying) sim.takeOver();
      },
    });
    e.play(shot);
  };

  const undo = () => {
    const prev = history.current.pop();
    if (!prev) return;
    setEdit({ status: "idle" });
    // a look undone is redrawn in place, like it was changed; anything else is the old world again
    const top = current.current;
    if (top && restyledWorlds.current.has(top)) return void redraw(prev);
    void show(prev, ++runId.current, performance.now(), []);
  };

  /**
   * The Host's "show me": the same world rebuilt and this run replayed exactly (inputs and minds
   * as logged), from four seconds before the moment (a clean take: up to half a minute); any key
   * takes over.
   */
  const replayMoment = (tick: number, back = 240, takeOver = "Press any key to take over") => {
    const w = current.current;
    const sim = engine.current?.rapierSim;
    if (!w || !sim) return;
    const inputs = [...sim.inputs];
    const chosen = [...sim.minds];
    const from = Math.max(0, tick - back);
    setResult(null);
    void show(w, ++runId.current, performance.now(), []).then(() => {
      const s2 = engine.current?.rapierSim;
      if (!s2) return;
      s2.replay(inputs, chosen, from);
      s2.onReplayEnd = () => setNotice(undefined);
      setNotice(`Replaying from ${mmss(from)}, exactly as it happened. ${takeOver}.`);
    });
  };

  /** A gallery world: the live AI's recorded fill, rebuilt and re-proved here (and editable, like any live world). */
  const openGallery = async (entry: GalleryEntry, asRemix = false) => {
    setGallery(false);
    const load = GALLERY_WORLDS[`./gallery/worlds/${entry.slug}.json`];
    if (!load) return;
    const t0 = performance.now();
    const g = await load();
    const seed = (JSON.parse(splitObjects(g.fill.split("\n", 1)[0] ?? "{}")[0] ?? "{}") as { seed?: number }).seed ?? 7;
    const i = g.intent;
    const world = worldFromFill(g.fill, seed, { genre: i.genre, setting: i.setting, goal: i.goal, fail: i.fail, role: i.role }, i.pack, i.mode);
    world.source = { prompt: g.prompt, intent: i, fill: world.fill, seed, pack: world.bundle.pack.id };
    setPrompt(g.prompt);
    builtPrompt.current = g.prompt;
    history.current = [];
    setEdit({ status: "idle" });
    setStatus("building");
    setFellBack(false);
    setCachedFrom(null);
    setBypassed(false);
    setRemixSrc(null);
    await show(world, ++runId.current, t0, [{ label: "gallery", ms: performance.now() - t0 }]);
    setToast("A recorded live AI world (unedited), re-proved on your device now.");
    setRemixSrc({ ref: galleryRef(entry.slug), kind: "gallery", prompt: g.prompt, spec: await hashWorld(world.bundle), line: null });
    setCopied(asRemix);
    if (asRemix) (setCollapsed(false), setEditFocus((n) => n + 1));
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
  /** A panel button or a spoken prompt in the headset: the same as R, or as the prompt bar's Enter. */
  const vrAct = useRef<(a: VrAction) => void>(() => undefined);
  vrAct.current = (a) => {
    if (a.k === "again") return again();
    setPrompt(a.prompt);
    submit(a.prompt);
  };

  /** Build a prompt; `rebuild` skips the edge's cache ("Build it fresh"). */
  const submit = (text: string, rebuild = false) => {
    setCollapsed(false);
    setFresh(false);
    // offline, a gallery prompt (the bar's examples) opens its recorded world rather than the fixture
    const recorded = mode === "live" ? undefined : GALLERY.find((g) => g.prompt === text);
    if (recorded) return void openGallery(recorded);
    run(text, performance.now(), [], mode === "live", rebuild, mode === "live" && canSee ? picture : null).catch((err: unknown) => {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    });
  };

  /** A landing starter: its prompt, or for "Surprise me" any suggestion this lane can build. */
  const pickStarter = (s: Starter) => {
    const pool = SUGGESTIONS.filter((x) => (mode === "live" || !x.live) && x.prompt !== BRIEF);
    const text = s.prompt ?? pool[Math.floor(Math.random() * pool.length)]!.prompt;
    setPrompt(text);
    submit(text);
  };
  const landing = fresh && !collapsed && !typing;
  // the card says "inspired by your image" for the world that image made, and the edits and repairs of it
  const ownPrompt = current.current?.source?.base ?? current.current?.source?.prompt;
  const inspiredNow = inspired && ownPrompt === inspired.prompt ? inspired.brief : null;

  // the HUD can't be seen in a headset: its facts go to the in-headset panels as words
  const vrCard = race.card?.vs ?? null;
  useEffect(() => {
    const e = engine.current;
    if (!inVr || !e) return;
    const w = current.current;
    const busy = status === "building" || status === "booting";
    e.vrHud({
      proof: proofBadge(proof),
      score: scoreText(score, teams, clock, secrets),
      hint: useHint,
      toast: toast ?? notice ?? (status === "building" ? (building === null ? "Building the world…" : `Building… ${building} ${building === 1 ? "line" : "lines"}`) : null),
      bark,
      result: result && w ? vrResult(result, w.bundle, proof.receipt?.par?.goldS ?? null, vrCard) : null,
      race: race.chip ? { rival: race.chip.rival, secrets: race.chip.secrets } : null,
      prompts: SUGGESTIONS.filter((x) => mode === "live" || !x.live),
      busy,
    });
  }, [inVr, proof, score, teams, clock, secrets, useHint, toast, notice, status, building, bark, result, vrCard, race.chip?.rival, race.chip?.secrets, mode]);

  return (
    <>
      <canvas ref={canvas} className="stage" data-testid="stage" />
      <div className={`hud${touch ? " touch-mode" : ""}${landing ? " fresh" : ""}`}>
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
            source={mode === "live" && cachedFrom ? fromCache(cachedFrom, () => submit(builtPrompt.current, true)) : mode === "live" && fellBack ? FELL_BACK : SOURCE[mode]}
            suggestions={SUGGESTIONS.filter((x) => mode === "live" || !x.live)}
            onFocusChange={setTyping}
            onGallery={() => setGallery(true)}
            galleryCount={GALLERY.length}
            examples={EXAMPLES}
            playing={builtPrompt.current}
            picture={mode === "live" && canSee ? picture : null}
            {...(mode === "live" && canSee ? { onPicture: setPicture } : {})}
          />
          {landing && <Landing starters={STARTERS} ready={status === "playing"} onPick={pickStarter} />}
        </div>
        {notice && <div className="glass notice" role="status">{notice}</div>}
        {redGreen.caption && (
          <div className="glass notice redgreen" role="status" data-testid="redgreen">
            {redGreen.caption}
            <span className="muted"> · Esc to stop</span>
          </div>
        )}
        {mode === "live" && status === "playing" && !collapsed && !typing && current.current?.bundle.mode === "wander" && (
          <div className="glass tourhost" data-testid="tour-host">
            <AskHost run={false} placeholder="Ask the Host about this place" chips={tourChips(current.current.bundle)} onAsk={(q) => askHost(q, tourFacts(current.current!.bundle, proof.receipt))} onFly={(f) => void flyTo(f)} voice={speech.enabled ? { say: speech.host, again: speech.again } : undefined} />
          </div>
        )}
        {!collapsed && !typing && intent && building === null && (
          <IntentCard
            intent={intent}
            specHash={specHash}
            note={note}
            rebuilt={current.current?.source?.pinned ? rebuiltLine(current.current.source.pinned) : null}
            inspired={inspiredNow}
            controls={current.current && status === "playing" ? controlsFor(current.current, { live: mode === "live", busy: edit.status === "editing" || edit.status === "racing" || edit.status === "proving", prompt: current.current.source?.base ?? current.current.source?.prompt ?? builtPrompt.current, act: cardActs }) : undefined}
          />
        )}
        {current.current && status !== "booting" && !typing && (!collapsed || edit.status === "editing" || edit.status === "racing" || edit.status === "proving") && (
          <EditBox state={edit} enabled={mode === "live"} suggestions={[...suggestionsFor(current.current.bundle), "surprise me"]} canUndo={history.current.length > 0} onEdit={(c) => void editWorld(c)} onUndo={undo} focusKey={editFocus} placeholder={copied ? "Change it: make it yours…" : undefined} onRedGreen={redGreen.pair ? () => void redGreen.play(redGreen.pair!) : undefined}>
            {remixSrc && <LineagePanel source={remixSrc} line={lineageOf(remixSrc, current.current)} mine={yourChanges(current.current).length} copied={copied} spec={specHash} onRemix={remix} onShare={() => void shareRun()} />}
          </EditBox>
        )}
        {(score.red > 0 || score.blue > 0 || score.result || clock !== null || secrets.found > 0) && (
          <div className={`glass scoreline ${score.result ?? ""}`} data-testid="score">
            {teams ? (
              <>
                <span className="red">RED {score.red}</span> – <span className="blue">{score.blue} BLUE</span>
              </>
            ) : (
              <span className="red">SCORE {score.red}</span>
            )}
            {clock !== null && !score.result && <span className="clock"> · {Math.floor(clock / 60)}:{String(Math.floor(clock % 60)).padStart(2, "0")}</span>}
            {secrets.of > 0 && secrets.found > 0 && <span className="secrets" title="Secrets found (they don't count toward the win)"> · ★ {secrets.found}/{secrets.of}</span>}
            {score.result && <strong>{score.result === "win" ? " · You win!" : " · You lose"}</strong>}
          </div>
        )}
        <HealthBar engine={engine} active={status === "playing"} />
        <ActsHud engine={engine} active={status === "playing"} bundle={current.current?.bundle ?? null} asking={asking} onYes={() => (asking && engine.current?.rapierSim?.queueAct(asking.act), setAsking(null))} onNo={() => setAsking(null)} />
        <LapBoard engine={engine} active={status === "playing"} />
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
            onReplay={replayMoment}
            onFly={(f) => void flyTo(f)}
            onAsk={mode === "live" && result.facts?.length ? (q) => askHost(q, result.facts!) : undefined}
            director={director}
            onTwist={() => {
              const w = director?.world;
              if (!w) return;
              setResult(null);
              void show(w, ++runId.current, performance.now(), []);
            }}
            race={race.card}
            voice={speech.enabled ? { say: speech.host, again: speech.again } : undefined}
            clip={clip.card}
          />
        )}
        {race.chip && status === "playing" && (collapsed || typing || !intent) && <RaceChip {...race.chip} />}
        {race.board && <BoardPanel {...race.board} />}
        {bark && (
          <div className="glass bark" data-testid="bark">
            <b>{bark.name}:</b> {bark.line}
          </div>
        )}
        {talking && <TalkBox name={talking.name} lang={speech.listenLang()} onSay={(t) => minds.current?.talk(talking.npc, t)} onClose={() => setTalking(null)} onListen={speech.hush} />}
        <ProofBadge proof={proof} onOpen={() => setReceiptOpen((o) => !o)} />
        <CutChip cut={cut} onApply={applyCut} />
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
        {gallery && <Gallery onOpen={(e) => void openGallery(e)} onRemix={(e) => void openGallery(e, true)} onClose={() => setGallery(false)} />}
        {trusting && <TrustPanel onClose={() => setTrusting(false)} />}
        {receiptOpen && (
          <ReceiptPanel
            proof={proof}
            onClose={() => {
              setReceiptOpen(false);
              if (fooled) engine.current?.highlight(null);
            }}
            onTrust={() => (setReceiptOpen(false), setTrusting(true))}
            onFool={proof.status === "done" && proof.receipt ? tryFool : undefined}
            fooled={fooled}
            routes={proof.receipt?.trails && current.current ? insights(current.current.bundle, allRuns(proof.receipt)) : null}
            report={proof.receipt && current.current ? revealed(current.current.bundle, proof.receipt) : null}
            routesOn={routesOn}
            onRoutes={() => {
              const on = !routesOn;
              setRoutesOn(on);
              // the experts' routes, over the heat map of every run at every level
              const heat = on && proof.receipt && current.current ? (revealed(current.current.bundle, proof.receipt)?.heat ?? null) : null;
              engine.current?.showTrails(on ? (proof.receipt?.trails ?? null) : null, heat);
            }}
            reported={reported}
            version={receiptVersion(lineageOf(remixSrc, current.current), specHash)}
            fengShui={fengShuiFor(current.current, ownPrompt ?? builtPrompt.current)}
            chipAction={(c) => {
              const w = current.current;
              const r = proof.receipt;
              const fix = repair.status === "offer" && repaired.current && repairedReceipt.current ? { world: repaired.current, receipt: repairedReceipt.current } : null;
              const plays = redGreen.chipPlays(c, w, r, fix);
              if (!plays || !w || !r) return null;
              return (
                <button type="button" className="chip-redgreen" data-testid="chip-redgreen" disabled={redGreen.lining === c.id} onClick={() => (setReceiptOpen(false), void redGreen.playChip(c, w, r, fix))}>
                  {redGreen.lining === c.id ? "lining up the runs…" : plays === "alone" ? "▶ where it fails" : "▶ red/green"}
                </button>
              );
            }}
            noteAction={mode === "live" ? (key) => {
              const n = noteList.get(key);
              return n ? <NoteApply note={n} state={notes.state} onTry={(k, c, said) => void notes.tryChange(k, c, said)} onAccept={() => (setReceiptOpen(false), notes.accept())} /> : null;
            } : undefined}
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
        {sound.enabled && <MuteButton muted={sound.muted} onToggle={sound.toggle} />}
        {!touch && <KeyHint visible={hint && status === "playing"} sound={sound.enabled} />}
        {touch && status === "playing" && (
          <TouchControls
            onStick={(x, y) => engine.current?.touchStick(x, y)}
            onButton={(bit, down) => engine.current?.touchButton(bit, down)}
            useLabel={useHint}
          />
        )}
        {RECORD && (
          <RecordStrip
            prompt={remixSrc?.prompt || current.current?.source?.base || current.current?.source?.prompt || (prompt === RACE_PROMPT && current.current ? worldTitle(current.current, "") : builtPrompt.current)}
            ttffMs={timing?.ttffMs ?? null}
            busy={status === "building" || status === "booting"}
            source={{ mode, cached: cachedFrom && fromCache(cachedFrom, () => undefined).label, bypassed, fellBack, kind: remixSrc?.kind ?? null }}
            proof={proof}
            onExpand={() => setCollapsed(false)}
          />
        )}
        {status === "booting" && <div className="boot">building world…</div>}
        {status === "building" &&
          (building === null ? (
            <div className="boot">building world…</div>
          ) : (
            <div className="materialise-status" data-testid="materialise">
              building… {building} {building === 1 ? "line" : "lines"}
            </div>
          ))}
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
