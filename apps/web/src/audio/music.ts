// One adaptive loop, written as it plays: a pad, a plucked arpeggio through a dotted-eighth echo, a
// soft bass, and hats that only come in under pressure. The world's mood picks the key, the mode,
// the tempo and how bright it sounds; tension (carrying the objective, the last ten seconds) speeds
// it up a little and opens the filter. Notes are scheduled ahead on the audio clock, so the timing
// holds however busy the main thread is.
import { hz } from "./voices";

const MODES = {
  lydian: [0, 2, 4, 6, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
} as const;
export type ModeName = keyof typeof MODES;

export interface Key {
  /** MIDI note of the tonic, around the third octave. */
  root: number;
  mode: ModeName;
}

/** The MIDI note of a scale degree (0 = the tonic; 7 = an octave up). */
export function degree(k: Key, d: number): number {
  const s = MODES[k.mode];
  const o = Math.floor(d / 7);
  return k.root + s[((d % 7) + 7) % 7]! + 12 * o;
}

export interface MoodIn {
  /** valence, arousal, tension, each −1…1 (the fill's meta line). */
  mood: readonly [number, number, number];
  timeOfDay: number;
  look: "neon" | "grove" | "gallery";
  night: boolean;
}

export interface Score {
  key: Key;
  bpm: number;
  /** 0…1: how open the filters are. */
  bright: number;
  /** 0…1: how busy the arpeggio is. */
  busy: number;
  /** The world's own tension, before anything happens. */
  tension: number;
  progression: readonly number[];
}

const NAMES = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
export const keyName = (k: Key) => `${NAMES[k.root % 12]} ${k.mode}`;

const PROGRESSIONS = [
  [0, 5, 3, 4],
  [0, 3, 5, 4],
  [0, 4, 5, 3],
  [0, 5, 2, 3],
] as const;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** What the world's mood sounds like. */
export function scoreFor(m: MoodIn): Score {
  const [valence, arousal, tension] = m.mood;
  // neon nights lean cool, a sunny grove leans bright; tension darkens either
  const v = valence - 0.25 * tension - (m.night ? 0.12 : 0) + (m.look === "grove" && !m.night ? 0.1 : 0) - (m.look === "neon" ? 0.1 : 0);
  const mode: ModeName = v > 0.45 ? "lydian" : v > 0.25 ? "ionian" : v > 0.05 ? "mixolydian" : v > -0.2 ? "dorian" : tension > 0.7 ? "phrygian" : "aeolian";
  const root = m.look === "neon" ? 57 : m.look === "gallery" ? 51 : m.night ? 50 : 53;
  const day = 0.5 + 0.5 * Math.cos(((m.timeOfDay - 13) * Math.PI) / 12);
  return {
    key: { root, mode },
    bpm: Math.round(64 + 36 * clamp01(arousal) + 6 * clamp01(tension)),
    bright: clamp01(0.3 + 0.2 * valence + 0.3 * day),
    busy: clamp01(0.25 + 0.6 * arousal),
    tension: clamp01(tension) * 0.25,
    progression: PROGRESSIONS[Math.abs(Math.round(m.timeOfDay * 7 + root)) % PROGRESSIONS.length]!,
  };
}

/** k hits spread as evenly as they go over n steps (Bjorklund's pattern, by Bresenham). */
function euclid(k: number, n: number, rot: number): boolean[] {
  return Array.from({ length: n }, (_, i) => Math.floor(((i + rot) * k) / n) !== Math.floor(((i + rot - 1) * k) / n));
}

const LOOKAHEAD = 0.14;
const SILENT = 0.0004;

export class Music {
  readonly #ctx: AudioContext;
  readonly #noise: AudioBuffer;
  /** Everything the music plays goes through here (its level, fades and endings). */
  readonly #bus: GainNode;
  readonly #lp: BiquadFilterNode;
  readonly #echo: DelayNode;
  readonly #echoIn: GainNode;
  readonly #rev: AudioNode;
  #score: Score | null = null;
  #tension = 0;
  #step = 0;
  #next = 0;
  #pattern: boolean[] = [];
  #walk = 0;
  #playing = false;

  constructor(ctx: AudioContext, out: AudioNode, rev: AudioNode, noise: AudioBuffer) {
    this.#ctx = ctx;
    this.#noise = noise;
    this.#rev = rev;
    this.#bus = ctx.createGain();
    this.#bus.gain.value = 0;
    this.#lp = ctx.createBiquadFilter();
    this.#lp.type = "lowpass";
    this.#lp.Q.value = 0.5;
    this.#lp.connect(this.#bus);
    this.#bus.connect(out);
    // the echo: a dotted eighth, darker on every repeat
    this.#echo = ctx.createDelay(2);
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    const dark = ctx.createBiquadFilter();
    dark.type = "lowpass";
    dark.frequency.value = 2300;
    this.#echoIn = ctx.createGain();
    this.#echoIn.gain.value = 0.32;
    this.#echoIn.connect(this.#echo);
    this.#echo.connect(dark).connect(fb).connect(this.#echo);
    dark.connect(this.#lp);
  }

  get score(): Score | null {
    return this.#score;
  }

  get bpm(): number {
    return this.#score ? Math.round(this.#score.bpm * (1 + 0.09 * this.#effTension())) : 0;
  }

  /** A new world: its own key and tempo, faded in from the top of a phrase. */
  start(s: Score) {
    const now = this.#ctx.currentTime;
    this.#score = s;
    this.#tension = 0;
    this.#step = 0;
    this.#walk = 0;
    this.#pattern = euclid(Math.round(3 + 5 * s.busy), 16, Math.floor(Math.random() * 4));
    this.#echo.delayTime.setValueAtTime((60 / s.bpm) * 0.75, now);
    this.#next = now + 0.15;
    this.#playing = true;
    const g = this.#bus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(1, now + 3.5);
  }

  /** The run ended: let the music fall away (a lost run closes its filter as it goes). */
  end(lost: boolean) {
    if (!this.#playing) return;
    const now = this.#ctx.currentTime;
    this.#playing = false;
    const g = this.#bus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + (lost ? 1.4 : 0.9));
    if (lost) this.#lp.frequency.setTargetAtTime(220, now, 0.4);
  }

  /** 0…1: carrying the objective is about half; the last ten seconds are all of it. */
  set tension(x: number) {
    this.#tension = clamp01(x);
  }

  #effTension(): number {
    return Math.max(this.#tension, this.#score?.tension ?? 0);
  }

  /** Called every few tens of milliseconds: schedule whatever falls in the next lookahead window. */
  pump() {
    const s = this.#score;
    if (!s || !this.#playing) return;
    const now = this.#ctx.currentTime;
    // the clock stood still (muted, a hidden tab): pick up from now instead of rushing to catch up
    if (this.#next < now - 0.1) this.#next = now + 0.05;
    const tn = this.#effTension();
    const cutoff = 500 + 2600 * clamp01(s.bright + 0.35 * tn);
    this.#lp.frequency.setTargetAtTime(cutoff, now, 0.6);
    while (this.#next < now + LOOKAHEAD) {
      this.#play(this.#step, this.#next, s, tn);
      this.#next += 60 / (s.bpm * (1 + 0.09 * tn)) / 4;
      this.#step++;
    }
  }

  #play(step: number, t: number, s: Score, tn: number) {
    const inBar = step % 16;
    const bar = Math.floor(step / 16);
    // a chord every two bars, round the progression
    const chordDeg = s.progression[Math.floor(bar / 2) % s.progression.length]!;
    const chord = [chordDeg, chordDeg + 2, chordDeg + 4];
    if (inBar === 0 && bar % 2 === 0) this.#pad(t, chord.map((d) => degree(s.key, d)), (60 / s.bpm) * 8);
    // bass: the chord's root, syncopated; pulsing eighths under pressure
    const pulse = tn > 0.45;
    if (inBar === 0 || inBar === 10 || (pulse && inBar % 2 === 0)) this.#bass(t, hz(degree(s.key, chordDeg) - 12), pulse && inBar !== 0 ? 0.16 : 0.5);
    // the arpeggio: a walk over the chord tones in two octaves, now and then resting
    if (this.#pattern[inBar] && Math.random() < 0.88) {
      this.#walk = Math.max(0, Math.min(5, this.#walk + (Math.random() < 0.5 ? -1 : 1)));
      const d = chord[this.#walk % 3]! + 7 * (1 + Math.floor(this.#walk / 3));
      this.#pluck(t, hz(degree(s.key, d)), 0.055 + 0.02 * s.bright);
    }
    // every four bars a bell motif (more often in a happy world), and the arpeggio shifts
    if (inBar === 0 && bar % 4 === 3) {
      this.#pattern = euclid(Math.round(3 + 5 * s.busy), 16, Math.floor(Math.random() * 4));
      if (Math.random() < 0.45 + 0.25 * s.bright) {
        const top = chordDeg + 14;
        [top, top + 1, top + 4].forEach((d, i) => this.#bellNote(t + i * (60 / s.bpm / 2), hz(degree(s.key, d))));
      }
    }
    if (tn > 0.3 && (inBar % 4 === 2 || (tn > 0.8 && inBar % 2 === 1))) this.#hat(t, tn);
  }

  #pad(t: number, notes: number[], len: number) {
    const ctx = this.#ctx;
    for (const m of notes) {
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = det < 0 ? "triangle" : "sawtooth";
        o.frequency.value = hz(m);
        o.detune.value = det;
        const g = ctx.createGain();
        const peak = det < 0 ? 0.03 : 0.012;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + 1.4);
        g.gain.setValueAtTime(peak, t + len - 0.2);
        g.gain.exponentialRampToValueAtTime(SILENT, t + len + 1.8);
        o.connect(g).connect(this.#lp);
        g.connect(this.#rev);
        o.onended = () => g.disconnect();
        o.start(t);
        o.stop(t + len + 1.9);
      }
    }
  }

  #bass(t: number, f: number, d: number) {
    const ctx = this.#ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.012);
    g.gain.exponentialRampToValueAtTime(SILENT, t + d);
    o.connect(g).connect(this.#lp);
    o.onended = () => g.disconnect();
    o.start(t);
    o.stop(t + d + 0.03);
  }

  #pluck(t: number, f: number, peak: number) {
    const ctx = this.#ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(SILENT, t + 0.38);
    g.connect(this.#lp);
    g.connect(this.#echoIn);
    for (const [type, mul, lvl] of [["triangle", 1, 1], ["sine", 2, 0.35]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mul;
      const lg = ctx.createGain();
      lg.gain.value = lvl;
      o.connect(lg).connect(g);
      o.onended = () => lg.disconnect();
      o.start(t);
      o.stop(t + 0.42);
    }
    setTimeout(() => g.disconnect(), (t - ctx.currentTime + 0.6) * 1000);
  }

  #bellNote(t: number, f: number) {
    const ctx = this.#ctx;
    const car = ctx.createOscillator();
    car.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.frequency.value = f * 2;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(f * 0.8, t);
    depth.gain.exponentialRampToValueAtTime(1, t + 0.6);
    mod.connect(depth).connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.025, t + 0.005);
    g.gain.exponentialRampToValueAtTime(SILENT, t + 1.4);
    car.connect(g).connect(this.#lp);
    g.connect(this.#rev);
    car.onended = () => (g.disconnect(), depth.disconnect());
    for (const o of [car, mod]) (o.start(t), o.stop(t + 1.45));
  }

  #hat(t: number, tn: number) {
    const ctx = this.#ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.018 + 0.016 * tn, t + 0.002);
    g.gain.exponentialRampToValueAtTime(SILENT, t + 0.04);
    src.connect(hp).connect(g).connect(this.#bus);
    src.onended = () => g.disconnect();
    src.start(t, Math.random() * (this.#noise.duration - 0.2));
    src.stop(t + 0.05);
  }
}
