// Red/green over whatever world is showing. App says when a world is about to replace the one on
// screen (with that one's receipt) and when the new one's receipt lands; if the new world is a
// change of the old one (an edit, a design note, the Director's cut, a repair: same seed, same
// layout pack) and a check moved between holding and failing, the same AI runner's run on both is
// paired in a worker, ready to play side by side. A counterexample chip can ask for its own pair
// (against the repair on offer) or play the world's own failing run alone.
import { useCallback, useRef, useState, type RefObject } from "react";
import type { Chip, Receipt } from "@ghostrun/proof/light";
import type { Engine } from "./engine";
import type { World } from "./pipeline";
import { failingOnly, pairInWorker, planPair, redGreenOf, type RedGreen } from "./redgreen";

type Urls = { rapier: string; recast: string };

/** Two versions of one world: built from the same seed on the same layout pack (an edit keeps both). */
const related = (a: World, b: World) => a !== b && a.seed === b.seed && a.bundle.pack.id === b.bundle.pack.id && a.fill !== b.fill;

export function useRedGreen(d: { engine: RefObject<Engine | null>; urls: RefObject<Urls | null> }) {
  /** The pair for the world on screen (from the change that made it), and that world. */
  const [pair, setPair] = useState<{ world: World; rg: RedGreen } | null>(null);
  const [caption, setCaption] = useState<string | null>(null);
  /** A chip's pair being worked out (its id), so its button can say so. */
  const [lining, setLining] = useState<string | null>(null);
  const left = useRef<{ world: World; receipt: Receipt; next: World } | null>(null);
  const shown = useRef<World | null>(null);

  /** `next` replaces `prev` on screen: if it is a change of it, its receipt is compared with this one when it lands. */
  const leaving = useCallback((prev: World | null, receipt: Receipt | null, next: World) => {
    if (prev === next) return; // the same world again (Play again, a replay): its pair stays
    shown.current = next;
    setPair(null);
    left.current = prev && receipt && related(prev, next) ? { world: prev, receipt, next } : null;
  }, []);

  /** The receipt of the world on screen landed: pair it with the world it changed, if a check moved. */
  const landed = useCallback(async (world: World, receipt: Receipt) => {
    const was = left.current;
    if (!was || was.next !== world || !d.urls.current) return;
    left.current = null;
    const plan = planPair(was.receipt, receipt);
    if (!plan) return;
    const p = await pairInWorker(was.world.bundle, world.bundle, plan.ask, d.urls.current);
    const rg = p && redGreenOf(p, plan, world.bundle);
    if (rg && shown.current === world) setPair({ world, rg });
  }, []);

  const play = useCallback(async (rg: RedGreen) => {
    const { RedGreenShot } = await loadShots();
    const e = d.engine.current;
    if (e) e.play(new RedGreenShot(e.stage, { ...rg, onCaption: setCaption }));
  }, []);

  /**
   * A counterexample chip's ▶: the change's own pair if it shows this chip; else this world against
   * the repair on offer (red here, green there); else the world's own failing run, alone.
   */
  const playChip = useCallback(
    async (chip: Chip, world: World, receipt: Receipt, repair: { world: World; receipt: Receipt } | null) => {
      if (pair && pair.world === world && pair.rg.chips.includes(chip.id)) return play(pair.rg);
      const plan = repair ? planPair(receipt, repair.receipt) : null;
      if (repair && plan?.chips.includes(chip.id) && d.urls.current) {
        setLining(chip.id);
        const p = await pairInWorker(world.bundle, repair.world.bundle, plan.ask, d.urls.current);
        setLining(null);
        const rg = p && redGreenOf(p, plan, repair.world.bundle);
        if (rg && shown.current === world) return play(rg);
      }
      if (chip.id === "T3:win" && receipt.failRun) play(failingOnly(receipt.failRun, receipt.trails?.length ?? chip.n));
    },
    [pair],
  );

  /** What this chip can play: a pair (of the change that made the world, or against the repair on offer), its own failing run alone, or nothing. */
  const chipPlays = (chip: Chip, world: World | null, receipt: Receipt | null, repair: { receipt: Receipt } | null): "pair" | "alone" | null => {
    if (chip.status !== "counterexample" || !world || !receipt) return null;
    if (pair?.world === world && pair.rg.chips.includes(chip.id)) return "pair";
    if (repair && planPair(receipt, repair.receipt)?.chips.includes(chip.id)) return "pair";
    return chip.id === "T3:win" && receipt.failRun ? "alone" : null;
  };

  return { pair: pair && pair.world === shown.current ? pair.rg : null, caption, lining, leaving, landed, play, playChip, chipPlays };
}

// the shots (three.js meshes) load with the first one played, not with the HUD
let shots: Promise<typeof import("./render/shots")> | null = null;
const loadShots = () => (shots ??= import("./render/shots"));
