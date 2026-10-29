// A sign drawn on a canvas (system-ui only, no font files) and shown as an HDR texture: a neon
// billboard in the city, a carved board in the desert or the castle, a lit panel on a space
// station. What it says comes from the world itself (signText), never a fixed line.
import type { WorldBundle } from "@ghostrun/ir";
import { CanvasTexture, Color, MeshBasicNodeMaterial, SRGBColorSpace } from "three/webgpu";
import type { LookId } from "./looks";
import { PALETTE } from "./materials";

export type SignStyle = "neon" | "wood" | "panel" | "stone" | "candy" | "placard" | "paper";

export const SIGN_STYLE: Record<LookId, SignStyle> = {
  neon: "neon", grove: "wood", gallery: "placard", desert: "wood", snow: "wood", space: "panel",
  haunted: "stone", medieval: "wood", candy: "candy", jungle: "stone", home: "paper",
};

interface Face {
  bg: string;
  /** Border strokes: inset, colour, glow, width. */
  rims: readonly (readonly [number, string, number, number])[];
  title: string;
  titleGlow: string;
  sub: string;
  subGlow: string;
  /** HDR multiplier: neon and panels glow, boards are lit by the scene's own colour. */
  hdr: number;
  grain?: string;
}

const FACES: Record<SignStyle, Face> = {
  neon: { bg: "#07030d", rims: [[14, PALETTE.cyan, 18, 5], [26, PALETTE.magenta, 10, 2]], title: "#ffd6f6", titleGlow: PALETTE.magenta, sub: "#c8fbff", subGlow: PALETTE.cyan, hdr: 2.2 },
  wood: { bg: "#6a4426", rims: [[10, "#3a2412", 0, 10], [24, "#a0703e", 0, 3]], title: "#fbe6c0", titleGlow: "#2a1608", sub: "#f0d2a0", subGlow: "#2a1608", hdr: 0.9, grain: "#5a3818" },
  panel: { bg: "#0a1420", rims: [[12, "#4fd8ff", 14, 3], [24, "#1a3a50", 0, 2]], title: "#c8f4ff", titleGlow: "#4fd8ff", sub: "#ffd36a", subGlow: "#ffb02e", hdr: 1.8 },
  stone: { bg: "#4a4a52", rims: [[12, "#2a2a30", 0, 8], [26, "#6a6a74", 0, 2]], title: "#e8e6f0", titleGlow: "#101014", sub: "#c8c4d4", subGlow: "#101014", hdr: 0.8, grain: "#3a3a42" },
  candy: { bg: "#ff8ad0", rims: [[12, "#ffffff", 8, 10], [28, "#8affe0", 6, 4]], title: "#ffffff", titleGlow: "#d0308a", sub: "#fff6a0", subGlow: "#d0308a", hdr: 1.1 },
  placard: { bg: "#f4f1ea", rims: [[14, "#2c2b30", 0, 3]], title: "#1e1d22", titleGlow: "#f4f1ea", sub: "#5a5860", subGlow: "#f4f1ea", hdr: 0.9 },
  paper: { bg: "#f2e6cc", rims: [[12, "#6a4a2a", 0, 6], [24, "#c8a878", 0, 2]], title: "#3a2414", titleGlow: "#f2e6cc", sub: "#6a4a2a", subGlow: "#f2e6cc", hdr: 0.9 },
};

/** Shrink the font until the text fits the board. */
function fit(g: CanvasRenderingContext2D, text: string, weight: number, size: number, max: number): number {
  let s = size;
  for (; s > 14; s -= 4) {
    g.font = `${weight} ${s}px system-ui, sans-serif`;
    if (g.measureText(text).width <= max) break;
  }
  return s;
}

export function signMaterial(title: string, sub: string, style: SignStyle = "neon"): MeshBasicNodeMaterial {
  const f = FACES[style];
  const W = 512;
  const H = 256;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d")!;
  g.fillStyle = f.bg;
  g.fillRect(0, 0, W, H);
  if (f.grain) {
    // wood grain or stone speckle, from a fixed pattern (the same sign every time)
    g.strokeStyle = f.grain;
    g.globalAlpha = 0.35;
    for (let i = 0; i < 26; i++) {
      g.lineWidth = 1 + (i % 3);
      g.beginPath();
      const y = (i * 37) % H;
      g.moveTo(0, y);
      g.bezierCurveTo(W * 0.3, y + ((i * 13) % 9) - 4, W * 0.7, y - ((i * 7) % 9) + 4, W, y + 2);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  g.lineJoin = "round";
  for (const [inset, col, blur, lw] of f.rims) {
    g.shadowColor = col;
    g.shadowBlur = blur;
    g.strokeStyle = col;
    g.lineWidth = lw;
    g.beginPath();
    g.roundRect(inset, inset, W - inset * 2, H - inset * 2, 22);
    g.stroke();
  }

  g.textAlign = "center";
  g.textBaseline = "middle";
  fit(g, title, 800, 92, W - 80);
  g.shadowColor = f.titleGlow;
  g.shadowBlur = style === "neon" ? 26 : 6;
  g.fillStyle = f.title;
  g.fillText(title, W / 2, H * 0.44);
  if (style === "neon") {
    g.shadowBlur = 12;
    g.fillText(title, W / 2, H * 0.44);
  }

  fit(g, sub, 600, 30, W - 90);
  g.shadowColor = f.subGlow;
  g.shadowBlur = style === "neon" ? 14 : 4;
  g.fillStyle = f.sub;
  g.fillText(sub, W / 2, H * 0.76);

  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new MeshBasicNodeMaterial({ map: tex });
  m.color = new Color(f.hdr, f.hdr, f.hdr); // neon and panels push above the bloom threshold
  return m;
}

const GENERIC = /^(the |a |an )?(glowing |neon |wooden |weathered |old |stone |info |information |welcome )*(sign|signpost|board|billboard|placard|plaque|notice|banner|poster)s?$/i;

/**
 * What a sign says, from the world it stands in: its zone's name over the way to the others (a
 * signpost), or the sign's own words when it has some ("warning inscription"). The organizer's CTF
 * world keeps its noodle bar.
 */
export function signText(b: WorldBundle, sign: WorldBundle["entities"][number], look: LookId): [string, string] {
  if (look === "neon" && b.pack.id === "city_block" && b.entities.some((e) => e.team === "blue")) return ["NOODLES", "OPEN 24H  ·  CTF FINALS"];
  const zone = b.zones.find((z) => z.id === sign.zone);
  const here = (zone?.name || "").trim();
  const noun = sign.noun.trim();
  const own = noun && !GENERIC.test(noun) ? noun.replace(/\s*(sign|plaque|placard|board)$/i, "") : "";
  const title = (own || here || noun || "WELCOME").toUpperCase();
  const others = b.zones
    .filter((z) => z.id !== sign.zone && z.name && z.layer === "gameplay")
    .map((z) => {
      const c = b.entities.filter((e) => e.zone === z.id);
      const at = c.length ? c.reduce((s, e) => s + Math.hypot(e.pos[0] - sign.pos[0], e.pos[2] - sign.pos[2]), 0) / c.length : 1e9;
      return { name: z.name, at };
    })
    .sort((a, b2) => a.at - b2.at)
    .slice(0, 2)
    .map((z) => z.name);
  const sub = others.length ? `→ ${others.join("  ·  ")}` : here && own ? here : "";
  return [title, sub];
}
