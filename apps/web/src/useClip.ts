// The run's clip, as the HUD sees it: recorded while you play (paused while a world builds, in VR
// and in a hidden tab), cut a moment after the win or the loss, previewed on the result card and
// saved from there. A clean take replays the run with the HUD hidden and saves the whole replay:
// footage for a demo. ?clip=0 turns it all off (and phones only record with ?clip=1).
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ClipRecorder, clipsOn, WANT_MS, type Clip } from "./clip";
import type { ClipCard } from "./hud/Clip";
import type { RunResult } from "./hud/Result";
import { probe } from "./probe";

const ON = clipsOn(window.location.search, window.matchMedia?.("(pointer: coarse)").matches ?? false);
/** Recording starts a beat after a run's first frame: past the shader warm-up, and past a replay's fast-forward. */
const START_MS = 300;
/** The clip runs on this long past the end, so the win or lose sting is in it. */
const TAIL_MS = 1500;
/** A clean take replays at most the last half minute of the run. */
export const TAKE_TICKS = 30 * 60;
/** A take that hasn't reached its end by then is called off (a replay that drifted). */
const TAKE_MAX_MS = (TAKE_TICKS / 60 + 15) * 1000;

function save(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

export function useClip(d: {
  canvas: RefObject<HTMLCanvasElement | null>;
  /** The game's mix (null while there is no sound). */
  tap: () => MediaStream | null;
  /** A run is on screen to record (not a world building, not a VR session). */
  active: boolean;
  /** Changes after every load: a new run, recorded from its start. */
  loaded: unknown;
  result: RunResult | null;
  /** The file name for a run's clip (a clean take is marked as one). */
  name: (r: RunResult, ext: string, take: boolean) => string;
  /** Replay this run from up to `back` ticks before its end (App's "show me" path); null where it can't be replayed. */
  replay: ((r: RunResult, back: number) => void) | null;
  toast: (text: string) => void;
}) {
  const rec = useRef<ClipRecorder | null | undefined>(undefined);
  const [clip, setClip] = useState<{ result: RunResult; clip: Clip | null; url: string | null; take: boolean; done: boolean } | null>(null);
  const [taking, setTaking] = useState(false);
  const takingRef = useRef(false);
  const live = useRef(d);
  live.current = d;

  /** The recorder, made the first time it's needed (none where clips are off or the browser can't). */
  const recorder = useCallback((): ClipRecorder | null => {
    if (rec.current !== undefined) return rec.current;
    if (!d.canvas.current) return null;
    if (!ON) probe().clip = { state: "disabled", segments: 0, bytes: 0, type: "" };
    rec.current = ON ? ClipRecorder.create(d.canvas.current, () => live.current.tap()) : null;
    return rec.current;
  }, [d.canvas]);

  const endTake = useCallback(() => {
    takingRef.current = false;
    setTaking(false);
  }, []);

  // every load is a new run: recorded from the top
  useEffect(() => {
    const r = recorder();
    if (!r || !d.loaded) return;
    r.stop();
    const t = setTimeout(() => r.start(takingRef.current ? "take" : "rolling"), START_MS);
    return () => clearTimeout(t);
  }, [d.loaded, recorder]);

  useEffect(() => recorder()?.idle(!d.active), [d.active, recorder]);

  // the run ended: the clip is cut a moment later, ending there (a take is saved as soon as it is)
  useEffect(() => {
    const res = d.result;
    const r = rec.current;
    if (!res || !r) return setClip(null);
    const take = takingRef.current;
    let gone = false;
    r.hold();
    setClip({ result: res, clip: null, url: null, take, done: false });
    const t = setTimeout(() => {
      void r
        .cut(take ? Infinity : WANT_MS)
        .catch(() => null)
        .then((c) => {
          if (gone) return;
          const url = c && URL.createObjectURL(c.blob);
          setClip({ result: res, clip: c, url, take, done: true });
          if (!take) return;
          endTake();
          if (c && url) save(url, live.current.name(res, c.ext, true));
          live.current.toast(c ? `Saved the clean replay (${Math.round(c.ms / 100) / 10} s).` : "The clean replay couldn't be recorded.");
        });
    }, TAIL_MS);
    return () => {
      gone = true;
      clearTimeout(t);
      if (take) endTake(); // a new run before the take was saved: it is called off
    };
  }, [d.result, endTake]);

  // a clip's file lives as long as its card
  useEffect(() => () => void (clip?.url && URL.revokeObjectURL(clip.url)), [clip]);

  // while a take is recording the HUD and the cursor step aside; a key calls it off (the replay ends there anyway)
  useEffect(() => {
    if (!taking) return;
    document.body.classList.add("clip-take");
    const off = () => {
      if (!takingRef.current) return;
      endTake();
      rec.current?.start("rolling");
      live.current.toast("Clean replay called off.");
    };
    const onKey = (e: KeyboardEvent) => !e.repeat && off();
    const t = setTimeout(off, TAKE_MAX_MS);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("clip-take");
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [taking, endTake]);

  const c = clip && clip.result === d.result ? clip : null;
  const replay = d.replay;
  const card: ClipCard | undefined =
    c && rec.current
      ? {
          status: !c.done ? "cutting" : c.url ? "ready" : "none",
          url: c.url,
          seconds: (c.clip?.ms ?? 0) / 1000,
          onSave: () => c.url && c.clip && save(c.url, d.name(c.result, c.clip.ext, c.take)),
          onTake: replay
            ? () => {
                takingRef.current = true;
                setTaking(true);
                replay(c.result, TAKE_TICKS);
              }
            : undefined,
        }
      : undefined;

  return { card, taking };
}
