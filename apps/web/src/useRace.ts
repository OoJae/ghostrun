// The race layer over whatever world is showing: which ghost runs beside the player (the proof's
// par runner, or a stored run someone sent and this device replayed), the HUD line, the result
// card's line and "Race me" link, and the best-times board. App hands in the world as shown and
// each receipt as it lands; this hands back what the HUD renders.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { nickname } from "@ghostrun/ir";
import { secretsOf, type Ghost, type Receipt } from "@ghostrun/proof/light";
import type { Engine } from "./engine";
import type { World } from "./pipeline";
import { ghostHidden, GhostTrack, raceClock, resultCard, setGhostHidden, worldTitle, type Rival } from "./race";
import { replayOnDevice, verdict, type Check } from "./rivals";
import { createShare, loadShare, MAX_RACE_TICKS, postBest, raceLink, storeRun, upToWin, type BoardEntry } from "./share";
import type { RunResult } from "./hud/Result";
import type { RapierSim } from "./sim/rapier";

type Urls = { rapier: string; recast: string };

const NICK_KEY = "gr_nick";
const savedNick = () => {
  try {
    return localStorage.getItem(NICK_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveNick = (n: string) => {
  try {
    localStorage.setItem(NICK_KEY, n);
  } catch {
    // storage blocked: the name still goes with this post
  }
};

/** The prompt bar's text for a world a race link opened (the link carries the world, not its prompt). */
export const RACE_PROMPT = "A race";

/** What a person's run is called on the HUD: their nickname, or plainly "Their run". */
const runName = (name: string) => name || "Their run";
const whose = (name: string) => (name ? `${name}'s run` : "This run");

export function useRace(d: {
  engine: RefObject<Engine | null>;
  /** The world showing now (App's current world). */
  world: World | null;
  /** Changes after every load (the engine puts the ghost away while it loads). */
  loaded: unknown;
  result: RunResult | null;
  receipt: Receipt | null;
  specHash: string | undefined;
  prompt: string;
  urls: RefObject<Urls | null>;
  toast: (text: string) => void;
  /** A fresh run of the same world. */
  again: () => void;
}) {
  /** The par runner's ghost (and its numbers) per world: "Play again" re-proves, but it's the same run. */
  const ai = useRef(new WeakMap<World, { ghost: Ghost; won: number; runs: number }>());
  const [, setProofs] = useState(0); // a par runner landed: render again to pick it up
  const [friend, setFriend] = useState<{ world: World; rival: Rival } | null>(null);
  const [hidden, setHidden] = useState(ghostHidden);
  const [board, setBoard] = useState(false);
  const [link, setLink] = useState<{ result: RunResult; url: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [posted, setPosted] = useState<RunResult | null>(null);
  const stored = useRef<{ sim: RapierSim; id: Promise<string | null> } | null>(null);

  /** A world's proof landed (App calls this with the world the proof was for). */
  const proved = useCallback((w: World, r: Receipt) => {
    if (!r.ghost || !r.par || ai.current.has(w)) return;
    ai.current.set(w, { ghost: r.ghost, won: r.par.won, runs: r.par.runs });
    setProofs((n) => n + 1);
  }, []);

  const world = d.world;
  const par = world ? ai.current.get(world) : undefined;
  const rival = useMemo<Rival | null>(() => {
    if (friend && friend.world === world) return friend.rival;
    if (!par || world?.bundle.mode !== "play") return null;
    return { kind: "ai", name: "AI", ghost: par.ghost, how: `The fastest of the proof's ${par.runs} AI runners (${par.won} of ${par.runs} won), played in the same physics` };
  }, [friend, world, par]);
  const secrets = useMemo(() => (world ? secretsOf(world.bundle) : new Set<string>()), [world]);

  // the engine draws the ghost; it puts it away whenever a world loads, so hand it back after each
  useEffect(() => {
    d.engine.current?.setGhost(rival ? new GhostTrack(rival.ghost) : null, rival?.kind ?? "ai");
  }, [rival, d.loaded, d.engine]);
  useEffect(() => {
    if (d.engine.current) d.engine.current.ghostShown = !hidden;
  }, [hidden, d.loaded, d.engine]);

  const toggle = useCallback(() => setHidden((h) => (setGhostHidden(!h), !h)), []);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
      if (ev.code === "KeyH") toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const getSim = useCallback(() => d.engine.current?.rapierSim ?? null, [d.engine]);

  /** This run's win, stored up to its winning tick (once per run): what "Race me" and a best time stand on. */
  const storeWin = useCallback((): Promise<string | null> => {
    const sim = d.engine.current?.rapierSim;
    const res = d.result;
    if (!sim || !world || !d.specHash || res?.k !== "win" || res.tick > MAX_RACE_TICKS) return Promise.resolve(null);
    if (stored.current?.sim === sim) return stored.current.id;
    const run = upToWin(sim.inputs, sim.minds, res.tick);
    const id = storeRun(world, d.specHash, run.inputs, run.minds);
    stored.current = { sim, id };
    void id.then((x) => x === null && stored.current?.id === id && (stored.current = null)); // a failed store can be retried
    return id;
  }, [d.engine, d.result, d.specHash, world]);

  /** The link the card carries: a race link for a win, the run's replay link otherwise. */
  const linkFor = useCallback(async (): Promise<string | null> => {
    const res = d.result;
    if (!res) return null;
    if (link?.result === res) return link.url;
    let url: string | null = null;
    if (res.k === "win") {
      const id = await storeWin();
      url = id && raceLink(id, savedNick());
    } else {
      const sim = d.engine.current?.rapierSim;
      url = sim && world && d.specHash ? await createShare(world, d.specHash, sim.inputs, sim.minds) : null;
    }
    if (url) setLink({ result: res, url });
    return url;
  }, [d.result, d.engine, d.specHash, link, storeWin, world]);

  const raceMe = async () => {
    const url = d.result?.k === "win" ? await linkFor() : null;
    if (!url) return d.toast(d.result && d.result.tick > MAX_RACE_TICKS ? "Runs over ten minutes can't be raced (the store keeps ten minutes)." : "Race links need the live service, which isn't reachable.");
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    d.toast(`Race link copied: ${url}`);
  };

  // the AI par has its own line on the card already; a person's run gets the split at the line
  const vs = rival?.kind === "run" && d.result ? { name: rival.name, ticks: rival.ghost.ticks } : null;
  const winChip = d.receipt?.chips.find((c) => c.id === "T3:win");
  const cardText = (url: string | null) =>
    d.result && world
      ? resultCard({
          title: worldTitle(world, d.prompt === RACE_PROMPT ? "" : d.prompt),
          won: winChip ? { k: winChip.k, n: winChip.n } : par ? { k: par.won, n: par.runs } : null,
          me: { ticks: d.result.tick, won: d.result.k === "win" },
          aiTicks: par?.ghost.ticks ?? null,
          rival: rival?.kind === "run" ? { name: rival.name, ticks: rival.ghost.ticks } : null,
          link: url,
        })
      : "";

  const copyCard = async () => {
    const text = cardText(await linkFor());
    const ok = await navigator.clipboard?.writeText(text).then(() => true, () => false);
    setCopied(ok ? "Copied" : "Select and copy");
    setTimeout(() => setCopied(null), 2500);
  };

  const card = d.result && world
    ? {
        text: cardText(link?.result === d.result ? link.url : null),
        onCopy: () => void copyCard(),
        copied,
        ...(d.result.k === "win" && d.engine.current?.rapierSim ? { onRaceMe: () => void raceMe() } : {}),
        ...(world.bundle.mode === "play" && d.specHash ? { onBoard: () => setBoard(true) } : {}),
        vs,
      }
    : undefined;

  /** Race a best-times entry this device has replayed: its ghost, from a fresh run. */
  const raceEntry = (e: BoardEntry, ghost: Ghost) => {
    if (!world) return;
    setFriend({ world, rival: { kind: "run", name: runName(e.name), ghost, how: `${whose(e.name)}, replayed on this device from its stored inputs: it wins at ${raceClock(ghost.ticks)}` } });
    setBoard(false);
    d.again();
  };

  const boardProps =
    board && world && d.specHash
      ? {
          specHash: d.specHash,
          bundle: world.bundle,
          urls: d.urls.current,
          ai: par ? { ticks: par.ghost.ticks, how: `the fastest of the proof's ${par.runs} AI runners (${par.won} of ${par.runs} won), physics` } : null,
          mine: d.result?.k === "win" && d.result.tick <= MAX_RACE_TICKS && d.engine.current?.rapierSim ? { ticks: d.result.tick, posted: posted === d.result } : null,
          name0: savedNick(),
          onPost: async (name: string) => {
            const res = d.result;
            const id = await storeWin();
            if (!id || !res) return { ok: false as const, why: "the share service isn't reachable" };
            const r = await postBest(d.specHash!, id, res.tick, name);
            if (r.ok) setPosted(res);
            if (r.ok && name) saveNick(name);
            return r;
          },
          onRace: raceEntry,
          onClose: () => setBoard(false),
        }
      : null;

  return {
    rival,
    proved,
    /** A stored run to race, as a link opened it: replayed here first, so its ghost starts with you. */
    setFriend: useCallback((w: World, r: Rival) => setFriend({ world: w, rival: r }), []),
    chip: rival ? { rival, getSim, secrets, result: d.result, hidden, onToggle: toggle, ...(d.specHash ? { onBoard: () => setBoard(true) } : {}) } : null,
    card,
    board: boardProps,
  };
}

/**
 * Open a "Race me" link: the world rebuilt from the stored fill, and the run replayed on this
 * device from its inputs. A ghost only when it replays exactly and wins; otherwise the world plays
 * on its own and the message says why.
 */
export async function loadRace(id: string, by: string | null, urls: Urls): Promise<{ world: World; rival: Rival | null; message: string } | null> {
  const shared = await loadShare(id);
  if (!shared) return null;
  const n = by ? nickname(by) : null;
  const name = n?.ok ? n.name : "";
  if (!shared.exact) return { world: shared.world, rival: null, message: "This race link is from another version of GHOSTRUN: the world rebuilt, but its run can't be replayed exactly, so there's no ghost to race." };
  const c: Check = await replayOnDevice(shared.world.bundle, shared.record, urls).then(
    (r) => verdict(r, null),
    (e: unknown) => ({ status: "error", message: String(e) }),
  );
  if (c.status !== "verified") return { world: shared.world, rival: null, message: "This race link's run doesn't win when replayed on this device, so there's no time to beat. The world is yours to play." };
  const time = raceClock(c.winTick);
  return {
    world: shared.world,
    rival: { kind: "run", name: runName(name), ghost: c.ghost, how: `${whose(name)}, replayed on this device from its stored inputs: it wins at ${time}` },
    message: `Race ${name || "this run"}: ${time} to beat (replayed on this device). The ghost started when you did.`,
  };
}
