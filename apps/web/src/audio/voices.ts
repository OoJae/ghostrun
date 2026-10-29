// Sound effects, synthesized: each one is a few oscillators and some filtered noise under short
// envelopes, built when it plays (no audio files, nothing to license). A recipe plays into the
// voice it is given (a panner and a reverb send behind it) and returns how long it rings, so the
// caller knows when to free the voice.

export interface Voice {
  ctx: AudioContext;
  /** Start time on the audio clock. */
  t: number;
  out: AudioNode;
  noise: AudioBuffer;
  /** Pitch multiplier: a little different every time, so repeats never sound stamped. */
  p: number;
}

/** MIDI note → Hz. */
export const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);

const SILENT = 0.0004;

/** A gain that rises linearly to `peak` and dies away exponentially. */
function envelope(ctx: AudioContext, at: number, a: number, d: number, peak: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + a);
  g.gain.exponentialRampToValueAtTime(SILENT, at + a + d);
  return g;
}

interface Blip {
  type: OscillatorType;
  f: number;
  /** Glide to this frequency over the note. */
  to?: number;
  at?: number;
  a: number;
  d: number;
  peak: number;
  dest?: AudioNode;
}

/** One oscillator note. */
export function blip(v: Voice, o: Blip): void {
  const { ctx } = v;
  const at = o.at ?? v.t;
  const osc = ctx.createOscillator();
  osc.type = o.type;
  osc.frequency.setValueAtTime(o.f, at);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, at + o.a + o.d);
  const g = envelope(ctx, at, o.a, o.d, o.peak);
  osc.connect(g).connect(o.dest ?? v.out);
  osc.onended = () => g.disconnect();
  osc.start(at);
  osc.stop(at + o.a + o.d + 0.03);
}

interface Hiss {
  type: BiquadFilterType;
  f: number;
  to?: number;
  q?: number;
  at?: number;
  a: number;
  d: number;
  peak: number;
  dest?: AudioNode;
}

/** A burst of filtered noise. */
export function hiss(v: Voice, o: Hiss): void {
  const { ctx } = v;
  const at = o.at ?? v.t;
  const src = ctx.createBufferSource();
  src.buffer = v.noise;
  src.loop = true;
  const flt = ctx.createBiquadFilter();
  flt.type = o.type;
  flt.frequency.setValueAtTime(o.f, at);
  if (o.to) flt.frequency.exponentialRampToValueAtTime(o.to, at + o.a + o.d);
  flt.Q.value = o.q ?? 0.8;
  const g = envelope(ctx, at, o.a, o.d, o.peak);
  src.connect(flt).connect(g).connect(o.dest ?? v.out);
  src.onended = () => g.disconnect();
  // a random point in the loop, so no two bursts share a waveform
  src.start(at, Math.random() * (v.noise.duration - 0.5));
  src.stop(at + o.a + o.d + 0.03);
}

/** An FM bell: a bright strike that settles into a pure tone. */
export function bell(v: Voice, f: number, at: number, d: number, peak: number, ratio = 3.5): void {
  const { ctx } = v;
  const car = ctx.createOscillator();
  car.frequency.value = f;
  const mod = ctx.createOscillator();
  mod.frequency.value = f * ratio;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(f * 1.4, at);
  depth.gain.exponentialRampToValueAtTime(1, at + d * 0.5);
  mod.connect(depth).connect(car.frequency);
  const g = envelope(ctx, at, 0.004, d, peak);
  car.connect(g).connect(v.out);
  car.onended = () => (g.disconnect(), depth.disconnect());
  for (const o of [car, mod]) (o.start(at), o.stop(at + d + 0.05));
}

const jitter = (x: number, by = 0.25) => x * (1 + (Math.random() - 0.5) * by);

// ---- the player's own body ----------------------------------------------------------------------

/** What the player's steps land on: each look has its own (render/looks.ts). */
export type Floor = "street" | "wet" | "soft" | "hard" | "sand" | "snow" | "metal" | "wood" | "stone" | "candy" | "leaves";

export function step(v: Voice, floor: Floor, loud: number): number {
  const k = jitter(loud * 1.3, 0.35);
  if (floor === "sand") {
    // a soft shushing slide, no heel
    hiss(v, { type: "bandpass", f: 1700 * v.p, q: 0.6, a: 0.01, d: 0.09, peak: 0.07 * k });
    hiss(v, { type: "lowpass", f: 600, a: 0.006, d: 0.05, peak: 0.06 * k });
  } else if (floor === "snow") {
    // packed snow: a squeaky crunch in two grains
    hiss(v, { type: "bandpass", f: 3100 * v.p, q: 1.3, a: 0.004, d: 0.05, peak: 0.05 * k });
    hiss(v, { type: "bandpass", f: 2300 * v.p, q: 1.1, at: v.t + 0.025, a: 0.004, d: 0.06, peak: 0.045 * k });
    hiss(v, { type: "lowpass", f: 900, a: 0.008, d: 0.08, peak: 0.09 * k });
  } else if (floor === "metal") {
    // a deck plate: a short clank that rings a little
    blip(v, { type: "triangle", f: 410 * v.p, to: 370 * v.p, a: 0.002, d: 0.08, peak: 0.045 * k });
    blip(v, { type: "sine", f: 1380 * v.p, a: 0.002, d: 0.14, peak: 0.016 * k });
    hiss(v, { type: "bandpass", f: 3000, q: 1.2, a: 0.002, d: 0.03, peak: 0.05 * k });
  } else if (floor === "wood") {
    // floorboards: a hollow knock
    blip(v, { type: "sine", f: 210 * v.p, to: 135, a: 0.002, d: 0.06, peak: 0.11 * k });
    hiss(v, { type: "bandpass", f: 1500 * v.p, q: 1, a: 0.002, d: 0.035, peak: 0.055 * k });
  } else if (floor === "stone") {
    // flagstones and cobbles: a dull heel with grit
    blip(v, { type: "sine", f: 140 * v.p, to: 80, a: 0.002, d: 0.05, peak: 0.1 * k });
    hiss(v, { type: "bandpass", f: 2200 * v.p, q: 1.2, a: 0.002, d: 0.03, peak: 0.065 * k });
  } else if (floor === "candy") {
    // a squishy, springy squeak
    blip(v, { type: "sine", f: 540 * v.p, to: 380 * v.p, a: 0.004, d: 0.07, peak: 0.045 * k });
    hiss(v, { type: "lowpass", f: 700 * v.p, q: 0.7, a: 0.006, d: 0.06, peak: 0.1 * k });
  } else if (floor === "leaves") {
    // leaf litter and twigs: a dry rustle over the body of the step
    hiss(v, { type: "highpass", f: 2600 * v.p, q: 0.6, a: 0.006, d: 0.08, peak: 0.045 * k });
    hiss(v, { type: "lowpass", f: 700, q: 0.5, a: 0.008, d: 0.06, peak: 0.12 * k });
  } else if (floor === "hard") {
    // a heel on polished stone
    hiss(v, { type: "bandpass", f: 2700 * v.p, q: 1.4, a: 0.002, d: 0.04, peak: 0.08 * k });
    blip(v, { type: "sine", f: 160 * v.p, to: 95, a: 0.002, d: 0.05, peak: 0.1 * k });
  } else if (floor === "wet") {
    // a splash on wet asphalt
    hiss(v, { type: "highpass", f: 1900 * v.p, q: 0.7, a: 0.004, d: 0.09, peak: 0.06 * k });
    hiss(v, { type: "lowpass", f: 480, a: 0.003, d: 0.05, peak: 0.08 * k });
  } else if (floor === "soft") {
    // grass and earth: all body, no click
    hiss(v, { type: "lowpass", f: 850 * v.p, q: 0.5, a: 0.008, d: 0.08, peak: 0.18 * k });
  } else {
    hiss(v, { type: "bandpass", f: 1300 * v.p, q: 0.9, a: 0.003, d: 0.045, peak: 0.07 * k });
    blip(v, { type: "sine", f: 125 * v.p, to: 75, a: 0.002, d: 0.045, peak: 0.07 * k });
  }
  return 0.15;
}

export function jump(v: Voice): number {
  blip(v, { type: "sine", f: 250 * v.p, to: 510 * v.p, a: 0.01, d: 0.14, peak: 0.1 });
  hiss(v, { type: "bandpass", f: 900, to: 2600, q: 0.8, a: 0.02, d: 0.1, peak: 0.04 });
  return 0.2;
}

/** The second jump, in the air: higher, with a glint. */
export function airJump(v: Voice): number {
  blip(v, { type: "triangle", f: 520 * v.p, to: 1040 * v.p, a: 0.008, d: 0.15, peak: 0.07 });
  blip(v, { type: "sine", f: 1560 * v.p, to: 2100 * v.p, at: v.t + 0.03, a: 0.005, d: 0.18, peak: 0.025 });
  hiss(v, { type: "bandpass", f: 2200, to: 5200, q: 1, a: 0.01, d: 0.1, peak: 0.03 });
  return 0.25;
}

/** Landing, as hard as the fall was long (0…1). */
export function land(v: Voice, impact: number): number {
  const k = 0.3 + 0.7 * impact;
  blip(v, { type: "sine", f: 120 * v.p, to: 48, a: 0.004, d: 0.1 + 0.12 * impact, peak: 0.16 * k });
  hiss(v, { type: "lowpass", f: 600 + 1000 * impact, q: 0.6, a: 0.003, d: 0.07 + 0.08 * impact, peak: 0.1 * k });
  return 0.3;
}

export function respawn(v: Voice): number {
  // a rewind: noise rising, then a soft pop where you reappear
  hiss(v, { type: "bandpass", f: 300, to: 3200, q: 1.2, a: 0.28, d: 0.1, peak: 0.06 });
  blip(v, { type: "sine", f: 330 * v.p, to: 990 * v.p, at: v.t + 0.32, a: 0.01, d: 0.2, peak: 0.06 });
  return 0.6;
}

// ---- things you get, lose and score ------------------------------------------------------------

/** A coin, a gem: two bell notes a fourth apart, from the song's key. */
export function coin(v: Voice, f: number): number {
  bell(v, f, v.t, 0.32, 0.075);
  bell(v, f * 1.335, v.t + 0.07, 0.5, 0.075);
  return 0.7;
}

/** A secret found: a quick rising arpeggio and a sparkle. */
export function secret(v: Voice, notes: readonly number[]): number {
  notes.forEach((f, i) => bell(v, f, v.t + i * 0.06, 0.6, 0.06));
  hiss(v, { type: "highpass", f: 6000, q: 0.7, at: v.t + 0.1, a: 0.05, d: 0.4, peak: 0.02 });
  return 1;
}

/** Picking up the thing that matters: up a fifth. */
export function grab(v: Voice, f: number): number {
  blip(v, { type: "triangle", f, a: 0.005, d: 0.12, peak: 0.09 });
  blip(v, { type: "triangle", f: f * 1.5, at: v.t + 0.07, a: 0.005, d: 0.22, peak: 0.09 });
  hiss(v, { type: "bandpass", f: 1500, to: 4200, q: 1, a: 0.04, d: 0.1, peak: 0.025 });
  return 0.4;
}

export function drop(v: Voice, f: number): number {
  blip(v, { type: "triangle", f: f * 1.5, to: f, a: 0.005, d: 0.18, peak: 0.07 });
  return 0.25;
}

/** It was knocked out of your hands. */
export function tagged(v: Voice): number {
  const lp = v.ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1300;
  lp.connect(v.out);
  blip(v, { type: "sawtooth", f: 330 * v.p, to: 140, a: 0.005, d: 0.3, peak: 0.07, dest: lp });
  blip(v, { type: "sawtooth", f: 345 * v.p, to: 146, a: 0.005, d: 0.3, peak: 0.05, dest: lp });
  hiss(v, { type: "lowpass", f: 900, a: 0.002, d: 0.08, peak: 0.12 });
  setTimeout(() => lp.disconnect(), 800);
  return 0.5;
}

/** You knocked it out of someone's hands. */
export function tag(v: Voice): number {
  hiss(v, { type: "bandpass", f: 1800, q: 1.1, a: 0.002, d: 0.06, peak: 0.12 });
  blip(v, { type: "triangle", f: 420 * v.p, to: 860 * v.p, a: 0.004, d: 0.12, peak: 0.07 });
  return 0.25;
}

/** A point: the chord of the key, broken upwards. */
export function scored(v: Voice, notes: readonly number[]): number {
  notes.forEach((f, i) => bell(v, f, v.t + i * 0.07, 0.55 + i * 0.1, 0.07, 2));
  return 1;
}

/** The other side scored: down a third, dulled. */
export function conceded(v: Voice, hi: number, lo: number): number {
  const lp = v.ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1400;
  lp.connect(v.out);
  blip(v, { type: "triangle", f: hi, a: 0.01, d: 0.22, peak: 0.08, dest: lp });
  blip(v, { type: "triangle", f: lo, at: v.t + 0.18, a: 0.01, d: 0.4, peak: 0.08, dest: lp });
  setTimeout(() => lp.disconnect(), 1000);
  return 0.7;
}

// ---- hazards and hits --------------------------------------------------------------------------

export type Harm = "burn" | "zap" | "blade" | "splash" | "buzz";

export function harmOf(noun: string): Harm {
  if (/lava|fire|flame|magma|acid|ember|coal|burn|heat|sun/.test(noun)) return "burn";
  if (/laser|electr|zap|plasma|spark|beam|wire|shock|tesla/.test(noun)) return "zap";
  if (/spike|saw|blade|thorn|cactus|knife|sword|trap/.test(noun)) return "blade";
  if (/water|pit|abyss|sea|river|tide|pool|swamp|mud|ice/.test(noun)) return "splash";
  return "buzz";
}

export function hurt(v: Voice, harm: Harm): number {
  const { ctx, t } = v;
  if (harm === "burn") {
    // sizzle: hissing noise under a fast tremolo, and a dull thump
    const trem = ctx.createGain();
    trem.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 34;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(trem.gain);
    trem.connect(v.out);
    hiss(v, { type: "highpass", f: 2400, q: 0.6, a: 0.01, d: 0.45, peak: 0.12, dest: trem });
    lfo.start(t);
    lfo.stop(t + 0.55);
    lfo.onended = () => (depth.disconnect(), trem.disconnect());
    blip(v, { type: "sine", f: 95, to: 40, a: 0.003, d: 0.2, peak: 0.14 });
  } else if (harm === "zap") {
    blip(v, { type: "sawtooth", f: 1300 * v.p, to: 90, a: 0.002, d: 0.22, peak: 0.12 });
    blip(v, { type: "square", f: 1950 * v.p, to: 130, a: 0.002, d: 0.16, peak: 0.05 });
    hiss(v, { type: "bandpass", f: 4200, q: 2, a: 0.002, d: 0.12, peak: 0.12 });
  } else if (harm === "blade") {
    blip(v, { type: "square", f: 1530 * v.p, a: 0.001, d: 0.12, peak: 0.025 });
    blip(v, { type: "square", f: 2370 * v.p, a: 0.001, d: 0.09, peak: 0.02 });
    hiss(v, { type: "highpass", f: 3000, a: 0.001, d: 0.06, peak: 0.1 });
    blip(v, { type: "sine", f: 140, to: 60, a: 0.002, d: 0.12, peak: 0.12 });
  } else if (harm === "splash") {
    hiss(v, { type: "lowpass", f: 2600, to: 380, q: 0.9, a: 0.01, d: 0.45, peak: 0.16 });
    blip(v, { type: "sine", f: 520 * v.p, to: 160, a: 0.005, d: 0.12, peak: 0.06 });
  } else {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    lp.connect(v.out);
    blip(v, { type: "square", f: 110 * v.p, a: 0.004, d: 0.26, peak: 0.07, dest: lp });
    blip(v, { type: "square", f: 117 * v.p, a: 0.004, d: 0.26, peak: 0.06, dest: lp });
    setTimeout(() => lp.disconnect(), 700);
  }
  return 0.6;
}

/** Something thrown lands on someone (or something). */
export function impact(v: Voice): number {
  hiss(v, { type: "lowpass", f: 1400, q: 0.7, a: 0.002, d: 0.1, peak: 0.18 });
  blip(v, { type: "sine", f: 180 * v.p, to: 60, a: 0.002, d: 0.15, peak: 0.16 });
  return 0.25;
}

export function whoosh(v: Voice): number {
  hiss(v, { type: "bandpass", f: 480 * v.p, to: 2300 * v.p, q: 1.3, a: 0.05, d: 0.14, peak: 0.2 });
  return 0.25;
}

export function shove(v: Voice): number {
  hiss(v, { type: "lowpass", f: 900, a: 0.003, d: 0.08, peak: 0.16 });
  blip(v, { type: "sine", f: 140 * v.p, to: 70, a: 0.003, d: 0.12, peak: 0.14 });
  hiss(v, { type: "bandpass", f: 700, to: 1800, q: 1.2, at: v.t + 0.04, a: 0.03, d: 0.12, peak: 0.05 });
  return 0.3;
}

/** Caught someone. */
export function caught(v: Voice, f: number): number {
  blip(v, { type: "sine", f: 210 * v.p, to: 90, a: 0.003, d: 0.12, peak: 0.15 });
  blip(v, { type: "triangle", f, to: f * 2, at: v.t + 0.05, a: 0.004, d: 0.14, peak: 0.06 });
  return 0.3;
}

/** Projectiles (a kit verb that shoots, when a world has one). */
export function pew(v: Voice): number {
  const lp = v.ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 3200;
  lp.connect(v.out);
  blip(v, { type: "square", f: 1600 * v.p, to: 280, a: 0.002, d: 0.1, peak: 0.055, dest: lp });
  hiss(v, { type: "highpass", f: 4000, a: 0.001, d: 0.03, peak: 0.05 });
  setTimeout(() => lp.disconnect(), 400);
  return 0.2;
}

// ---- mechanisms ---------------------------------------------------------------------------------

/** A switch or lever: two clicks and a tone (higher for on). */
export function flip(v: Voice, on: boolean): number {
  hiss(v, { type: "bandpass", f: 3600, q: 4, a: 0.001, d: 0.012, peak: 0.45 });
  hiss(v, { type: "bandpass", f: 2600, q: 4, at: v.t + 0.035, a: 0.001, d: 0.014, peak: 0.33 });
  blip(v, { type: "triangle", f: (on ? 880 : 520) * v.p, at: v.t + 0.04, a: 0.004, d: 0.08, peak: 0.05 });
  return 0.2;
}

/** A pressure plate going down (a stone thunk) or coming back up. */
export function plate(v: Voice, down: boolean): number {
  if (down) {
    blip(v, { type: "sine", f: 88 * v.p, to: 58, a: 0.004, d: 0.24, peak: 0.18 });
    hiss(v, { type: "lowpass", f: 420, a: 0.004, d: 0.12, peak: 0.1 });
  } else {
    blip(v, { type: "sine", f: 115 * v.p, a: 0.004, d: 0.09, peak: 0.07 });
    hiss(v, { type: "bandpass", f: 1200, a: 0.002, d: 0.03, peak: 0.05 });
  }
  return 0.3;
}

/** A key turns: click, clack, and a chime. */
export function unlock(v: Voice, f: number): number {
  hiss(v, { type: "bandpass", f: 4300, q: 6, a: 0.001, d: 0.016, peak: 0.3 });
  hiss(v, { type: "bandpass", f: 2800, q: 6, at: v.t + 0.07, a: 0.001, d: 0.02, peak: 0.28 });
  bell(v, f, v.t + 0.13, 0.6, 0.05);
  bell(v, f * 1.5, v.t + 0.19, 0.8, 0.045);
  return 1;
}

/** A door sliding open (or shut): a heavy low sweep. */
export function door(v: Voice, open: boolean): number {
  const lp = v.ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 2;
  const [a, b] = open ? [180, 900] : [900, 160];
  lp.frequency.setValueAtTime(a, v.t);
  lp.frequency.exponentialRampToValueAtTime(b, v.t + 0.6);
  lp.connect(v.out);
  blip(v, { type: "sawtooth", f: 62 * v.p, a: 0.08, d: 0.6, peak: 0.07, dest: lp });
  hiss(v, { type: "bandpass", f: 320, q: 0.8, a: 0.1, d: 0.55, peak: 0.05 });
  setTimeout(() => lp.disconnect(), 1100);
  return 0.9;
}

/** A checkpoint: an open chord, gently strummed. */
export function checkpoint(v: Voice, notes: readonly number[]): number {
  notes.forEach((f, i) => bell(v, f, v.t + i * 0.025, 1.1, 0.045, 2));
  return 1.3;
}

/** A platform crumbles away: grit and a rumble. */
export function crumble(v: Voice): number {
  for (let i = 0; i < 7; i++) {
    hiss(v, { type: "lowpass", f: 700 + Math.random() * 900, at: v.t + Math.random() * 0.35, a: 0.002, d: 0.03 + Math.random() * 0.04, peak: 0.08 + Math.random() * 0.06 });
  }
  blip(v, { type: "sine", f: 72, to: 38, a: 0.02, d: 0.45, peak: 0.1 });
  return 0.6;
}

/** Through a portal: a rising, wavering shimmer. */
export function portal(v: Voice): number {
  const { ctx, t } = v;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 9;
  const depth = ctx.createGain();
  depth.gain.value = 26;
  lfo.connect(depth);
  for (const [f, peak] of [[300, 0.05], [303, 0.04]] as const) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f * v.p, t);
    o.frequency.exponentialRampToValueAtTime(f * 4.6 * v.p, t + 0.45);
    depth.connect(o.frequency);
    const g = envelope(ctx, t, 0.05, 0.45, peak);
    o.connect(g).connect(v.out);
    o.onended = () => g.disconnect();
    o.start(t);
    o.stop(t + 0.55);
  }
  lfo.start(t);
  lfo.stop(t + 0.55);
  lfo.onended = () => depth.disconnect();
  hiss(v, { type: "bandpass", f: 800, to: 4200, q: 1.5, a: 0.1, d: 0.35, peak: 0.03 });
  return 0.7;
}

// ---- small things -------------------------------------------------------------------------------

/** Looking closely at something: a soft two-note "here's what it says". */
export function info(v: Voice, f: number): number {
  blip(v, { type: "sine", f, a: 0.01, d: 0.22, peak: 0.035 });
  blip(v, { type: "sine", f: f * 1.5, at: v.t + 0.06, a: 0.01, d: 0.28, peak: 0.03 });
  return 0.4;
}

export function use(v: Voice): number {
  hiss(v, { type: "bandpass", f: 2500, q: 3, a: 0.001, d: 0.02, peak: 0.18 });
  blip(v, { type: "sine", f: 700 * v.p, a: 0.003, d: 0.05, peak: 0.05 });
  return 0.1;
}

/** Something goes back to where it started. */
export function fwip(v: Voice): number {
  hiss(v, { type: "bandpass", f: 3000, to: 600, q: 1.4, a: 0.02, d: 0.16, peak: 0.08 });
  return 0.25;
}

export function pop(v: Voice): number {
  blip(v, { type: "sine", f: 720 * v.p, to: 180, a: 0.002, d: 0.08, peak: 0.07 });
  hiss(v, { type: "highpass", f: 3000, a: 0.001, d: 0.03, peak: 0.035 });
  return 0.15;
}

/** A rule's cosmetic effect (confetti, fireworks): a handful of high glints. */
export function sparkle(v: Voice, notes: readonly number[]): number {
  for (let i = 0; i < 6; i++) bell(v, notes[i % notes.length]! * 2, v.t + Math.random() * 0.4, 0.18, 0.022, 5);
  return 0.7;
}

/** Time's up: an inharmonic gong. */
export function gong(v: Voice): number {
  [1, 2.41, 3.9, 5.43].forEach((r, i) => blip(v, { type: "sine", f: 98 * r, a: 0.004, d: 2.4 - i * 0.4, peak: 0.07 / (i + 1) }));
  hiss(v, { type: "lowpass", f: 900, a: 0.002, d: 0.08, peak: 0.08 });
  return 2.6;
}

/** The last ten seconds of a countdown. */
export function tick(v: Voice, last: boolean): number {
  blip(v, { type: "sine", f: last ? 2000 : 1500, a: 0.001, d: 0.035, peak: last ? 0.1 : 0.07 });
  hiss(v, { type: "bandpass", f: 3200, q: 3, a: 0.001, d: 0.012, peak: 0.08 });
  return 0.1;
}

/** A new world appears: a soft rising swell. */
export function arrive(v: Voice, notes: readonly number[]): number {
  hiss(v, { type: "bandpass", f: 400, to: 3000, q: 0.9, a: 0.5, d: 0.5, peak: 0.025 });
  notes.forEach((f, i) => blip(v, { type: "sine", f, at: v.t + 0.2 + i * 0.09, a: 0.25, d: 1, peak: 0.022 }));
  return 1.6;
}

// ---- the end of a run ---------------------------------------------------------------------------

/** You win: the chord climbs, and a bright pad holds it. */
export function win(v: Voice, notes: readonly number[]): number {
  notes.forEach((f, i) => bell(v, f, v.t + i * 0.085, 0.9 + i * 0.15, 0.065, 2));
  const lp = v.ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(600, v.t);
  lp.frequency.exponentialRampToValueAtTime(2600, v.t + 0.8);
  lp.connect(v.out);
  for (const f of notes.slice(0, 3)) {
    for (const det of [-6, 6]) {
      const o = v.ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f / 2;
      o.detune.value = det;
      const g = v.ctx.createGain();
      g.gain.setValueAtTime(0, v.t);
      g.gain.linearRampToValueAtTime(0.02, v.t + 0.35);
      g.gain.exponentialRampToValueAtTime(SILENT, v.t + 2.6);
      o.connect(g).connect(lp);
      o.onended = () => g.disconnect();
      o.start(v.t);
      o.stop(v.t + 2.7);
    }
  }
  setTimeout(() => lp.disconnect(), 3200);
  return 2.8;
}

/** You lose: the chord falls, and a low note fades under it. */
export function lose(v: Voice, notes: readonly number[]): number {
  const lp = v.ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1300;
  lp.connect(v.out);
  notes.forEach((f, i) => blip(v, { type: "triangle", f, at: v.t + i * 0.22, a: 0.01, d: 0.5, peak: 0.075, dest: lp }));
  blip(v, { type: "sine", f: notes[notes.length - 1]! / 2, at: v.t + 0.5, a: 0.2, d: 1.6, peak: 0.08, dest: lp });
  setTimeout(() => lp.disconnect(), 2800);
  return 2.4;
}
