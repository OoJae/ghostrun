// A photo or sketch to build from, checked before anything is spent: a base64 data URL of a JPEG,
// PNG or WebP whose bytes really are that type, under a byte cap, with its width and height read
// from the file's own header (they price the vision call). The picture is passed to the model once
// and kept nowhere: not in the cache, not in a share, not in a log.
import type { ImageIn } from "@ghostrun/llm";

export const IMAGE_TYPES: readonly ImageIn["mediaType"][] = ["image/jpeg", "image/png", "image/webp"];
/** Decoded bytes; the client sends at most ~300 KB (768 px on the long side, re-encoded). */
export const MAX_IMAGE_BYTES = 384 * 1024;
export const MAX_IMAGE_SIDE = 1024;
/** The longest data URL a build body may carry. */
export const MAX_IMAGE_URL = 32 + Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export interface Picture extends ImageIn {
  width: number;
  height: number;
  bytes: number;
}

export type ImageCheck = { ok: true; image: Picture } | { ok: false; status: 400 | 413 | 415; error: string };

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/;
const no = (status: 400 | 413 | 415, error: string): ImageCheck => ({ ok: false, status, error });

export function readImage(x: unknown): ImageCheck {
  if (typeof x !== "string") return no(400, "bad image");
  if (x.length > MAX_IMAGE_URL) return no(413, "image too large");
  const m = DATA_URL.exec(x);
  if (!m) return no(400, "bad image: send a base64 data URL");
  const type = m[1] as ImageIn["mediaType"];
  if (!IMAGE_TYPES.includes(type)) return no(415, "unsupported image type: send a JPEG, PNG or WebP");
  let b: Uint8Array;
  try {
    b = Uint8Array.from(atob(m[2]!), (c) => c.charCodeAt(0));
  } catch {
    return no(400, "bad image: not base64");
  }
  if (b.length > MAX_IMAGE_BYTES) return no(413, "image too large");
  const size = sniff(b);
  if (!size || size.type !== type) return no(415, "unsupported image type: the bytes aren't the type it says");
  if (size.width < 1 || size.height < 1) return no(400, "bad image: no size");
  if (Math.max(size.width, size.height) > MAX_IMAGE_SIDE) return no(413, `image too large: at most ${MAX_IMAGE_SIDE} px on the long side`);
  return { ok: true, image: { mediaType: type, data: m[2]!, width: size.width, height: size.height, bytes: b.length } };
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u24le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 65536 + u16be(b, i + 2);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** The image's type and size from its header, or null when it isn't a JPEG, PNG or WebP we can read. */
export function sniff(b: Uint8Array): { type: ImageIn["mediaType"]; width: number; height: number } | null {
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && ascii(b, 12, 4) === "IHDR") return { type: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // walk the segments to the frame header (SOF0-15 but DHT, JPG and DAC), which holds the size
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++; // fill byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; // markers without a length
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // the image data began with no frame header
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: "image/jpeg", width: u16be(b, i + 7), height: u16be(b, i + 5) };
      i += 2 + u16be(b, i + 2);
    }
    return null;
  }
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { type: "image/webp", width: ((b[26] ?? 0) | ((b[27] ?? 0) << 8)) & 0x3fff, height: ((b[28] ?? 0) | ((b[29] ?? 0) << 8)) & 0x3fff };
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const [b1, b2, b3, b4] = [b[21] ?? 0, b[22] ?? 0, b[23] ?? 0, b[24] ?? 0];
      return { type: "image/webp", width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
    }
    if (chunk === "VP8X") return { type: "image/webp", width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  return null;
}
