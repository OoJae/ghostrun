// sfc32: small fast counter PRNG. Integer-only, so every JS engine produces the same stream.
// Simulation code takes randomness only from named sfc32 streams, never Math.random.
export type Rng = () => number;

export function sfc32(a: number, b: number, c: number, d: number): Rng {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** Derive an independent stream from a world seed and a stream name (e.g. "t3:runner:4"). */
export function stream(seed: number, name: string): Rng {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  const rng = sfc32(0x9e3779b9, h, seed | 0, (h ^ 0x85ebca6b) | 0);
  for (let i = 0; i < 12; i++) rng(); // warm up
  return rng;
}
