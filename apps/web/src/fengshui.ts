// The receipt's Feng Shui section: shown for a prompt that asks for Feng Shui (or a world that says
// it is), and offered for any interior. It reads the placed world and the pack's rooms and
// doorways, never the simulation, so it costs the proof nothing.
import { asksFengShui, fengShui, saysFengShui, type FengShuiSection } from "@ghostrun/layout";
import { fengShuiFix } from "@ghostrun/proof/light";
import type { World } from "./pipeline";

export interface FengShuiView {
  section: FengShuiSection;
  /** The prompt or the world asked for it: open from the start (else one button away). */
  asked: boolean;
}

export function fengShuiFor(w: World | null | undefined, prompt: string): FengShuiView | null {
  if (!w?.layout) return null;
  const asked = asksFengShui(prompt) || saysFengShui(w.bundle);
  const interior = w.layout.zones.some((z) => Object.keys(z.anchors).some((k) => k.startsWith("doorway_")));
  if (!asked && !interior) return null;
  return { section: fengShui(w.bundle, w.layout.zones), asked };
}

/**
 * Each failed principle as a design note the edit path can apply: what the receipt says, and the
 * change the edit model is sent (ids included). The hook for the design notes' Apply.
 */
export function fengShuiNotes(s: FengShuiSection): { id: string; text: string; change: string }[] {
  return s.findings.flatMap((f) => (f.fix ? [{ id: `fengshui:${f.rule}`, text: `Feng Shui: ${fengShuiFix(f.fix)}`, change: f.fix.change }] : []));
}
