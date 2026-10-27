// xxHash32 over raw bytes. Integer-only (Math.imul), so identical on every JS engine.
const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;

const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));

export function xxh32(bytes: Uint8Array, seed = 0): number {
  const len = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  let h: number;
  if (len >= 16) {
    let v1 = (seed + P1 + P2) | 0;
    let v2 = (seed + P2) | 0;
    let v3 = seed | 0;
    let v4 = (seed - P1) | 0;
    for (; i <= len - 16; i += 16) {
      v1 = Math.imul(rotl((v1 + Math.imul(view.getUint32(i, true), P2)) | 0, 13), P1);
      v2 = Math.imul(rotl((v2 + Math.imul(view.getUint32(i + 4, true), P2)) | 0, 13), P1);
      v3 = Math.imul(rotl((v3 + Math.imul(view.getUint32(i + 8, true), P2)) | 0, 13), P1);
      v4 = Math.imul(rotl((v4 + Math.imul(view.getUint32(i + 12, true), P2)) | 0, 13), P1);
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else {
    h = (seed + P5) | 0;
  }
  h = (h + len) | 0;
  for (; i <= len - 4; i += 4) {
    h = Math.imul(rotl((h + Math.imul(view.getUint32(i, true), P3)) | 0, 17), P4);
  }
  for (; i < len; i++) {
    h = Math.imul(rotl((h + Math.imul(bytes[i]!, P5)) | 0, 11), P1);
  }
  h ^= h >>> 15;
  h = Math.imul(h, P2);
  h ^= h >>> 13;
  h = Math.imul(h, P3);
  h ^= h >>> 16;
  return h >>> 0;
}

export const hex32 = (n: number) => n.toString(16).padStart(8, "0");
