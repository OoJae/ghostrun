// A photo or sketch to build from, made small and clean in the browser before it leaves: redrawn
// on a canvas (which leaves EXIF, GPS and every other bit of metadata behind), at most 768 px on
// the long side, as WebP (JPEG where the browser can't write WebP), under ~300 KB. The edge reads
// it once into a scene brief and keeps nothing; the world is inspired by it, not rebuilt from it.

export const MAX_SIDE = 768;
export const MAX_BYTES = 300 * 1024;
/** A file bigger than this isn't worth decoding on a phone just to shrink it. */
const MAX_INPUT_BYTES = 40 * 1024 * 1024;

export interface Picture {
  /** The re-encoded image as a data URL: what is sent, and the chip's thumbnail. */
  url: string;
  width: number;
  height: number;
  bytes: number;
}

export type PictureResult = { ok: true; picture: Picture } | { ok: false; why: string };

/** The first image in a paste or a drop, if there is one. */
export function imageIn(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const f of Array.from(data.files)) if (f.type.startsWith("image/")) return f;
  for (const item of Array.from(data.items ?? [])) if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
  return null;
}

const blobOf = (c: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob | null>((ok) => c.toBlob(ok, type, quality));
const dataUrlOf = (b: Blob) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => no(r.error);
    r.readAsDataURL(b);
  });

// a browser that can't write WebP hands back a PNG instead; after the first time, go straight to JPEG
let webp = true;

async function encode(c: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  if (webp) {
    const b = await blobOf(c, "image/webp", quality);
    if (b?.type === "image/webp") return b;
    webp = false;
  }
  return blobOf(c, "image/jpeg", quality);
}

export async function preparePicture(file: Blob): Promise<PictureResult> {
  if (!file.type.startsWith("image/")) return { ok: false, why: "That isn't a picture: try a photo or a sketch." };
  if (file.size > MAX_INPUT_BYTES) return { ok: false, why: "That picture is too big to read here." };
  const src = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = src;
    try {
      await img.decode(); // the browser turns a phone photo upright as it decodes it
    } catch {
      return { ok: false, why: "Couldn't read that picture: try a JPEG, PNG or WebP." };
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight, 1));
    let w = Math.max(1, Math.round(img.naturalWidth * scale));
    let h = Math.max(1, Math.round(img.naturalHeight * scale));
    // lower the quality first, then the size, until it fits
    for (let pass = 0; pass < 4; pass++) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      if (!g) return { ok: false, why: "This browser can't prepare pictures." };
      g.fillStyle = "#ffffff"; // a transparent sketch reads on paper, not on black
      g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      for (const q of [0.82, 0.68, 0.52]) {
        const b = await encode(c, q);
        if (b && b.size <= MAX_BYTES) return { ok: true, picture: { url: await dataUrlOf(b), width: w, height: h, bytes: b.size } };
      }
      w = Math.max(1, Math.round(w * 0.7));
      h = Math.max(1, Math.round(h * 0.7));
    }
    return { ok: false, why: "Couldn't make that picture small enough to send." };
  } finally {
    URL.revokeObjectURL(src);
  }
}
