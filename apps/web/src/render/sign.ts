// A neon billboard drawn on a canvas (system-ui only, no font files) and shown as an HDR texture.
import { CanvasTexture, Color, MeshBasicNodeMaterial, SRGBColorSpace } from "three/webgpu";
import { PALETTE } from "./materials";

export function signMaterial(title: string, sub: string): MeshBasicNodeMaterial {
  const W = 512;
  const H = 256;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#07030d";
  g.fillRect(0, 0, W, H);

  // Double neon tube border.
  g.lineJoin = "round";
  for (const [inset, col, blur, lw] of [[14, PALETTE.cyan, 18, 5], [26, PALETTE.magenta, 10, 2]] as const) {
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
  g.font = "800 92px system-ui, sans-serif";
  g.shadowColor = PALETTE.magenta;
  g.shadowBlur = 26;
  g.fillStyle = "#ffd6f6";
  g.fillText(title, W / 2, H * 0.44);
  g.shadowBlur = 12;
  g.fillText(title, W / 2, H * 0.44);

  g.font = "600 30px system-ui, sans-serif";
  g.shadowColor = PALETTE.cyan;
  g.shadowBlur = 14;
  g.fillStyle = "#c8fbff";
  g.fillText(sub, W / 2, H * 0.76);

  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new MeshBasicNodeMaterial({ map: tex });
  m.color = new Color(2.2, 2.2, 2.2); // push the tubes above the bloom threshold
  return m;
}
