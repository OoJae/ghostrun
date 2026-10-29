// The sound of the place, one bed per look: filtered noise under slow LFOs, with the odd event
// scattered over it (a car going by, a bird, a cricket's chirp, a raindrop). A new world crossfades
// from the last one's bed. Rain is a layer of its own that follows whether the world's rain is on.
import type { LookStyle } from "../render/looks";

const SILENT = 0.0004;

export interface Place {
  look: LookStyle["id"];
  night: boolean;
  rain: boolean;
  storm: boolean;
  snow: boolean;
}

/** A running bed: its nodes, and how often each of its scattered events comes round. */
interface Bed {
  out: GainNode;
  stops: (AudioScheduledSourceNode)[];
  events: { next: number; every: [number, number]; play: (t: number) => void }[];
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Ambience {
  readonly #ctx: AudioContext;
  readonly #out: AudioNode;
  readonly #rev: AudioNode;
  readonly #noise: AudioBuffer;
  #bed: Bed | null = null;
  #place: Place | null = null;

  constructor(ctx: AudioContext, out: AudioNode, rev: AudioNode, noise: AudioBuffer) {
    this.#ctx = ctx;
    this.#out = out;
    this.#rev = rev;
    this.#noise = noise;
  }

  get place(): Place | null {
    return this.#place;
  }

  /** Into a new place (the same place again keeps its bed playing). */
  set(p: Place) {
    const same = this.#place && JSON.stringify(this.#place) === JSON.stringify(p);
    if (same && this.#bed) return;
    this.#place = p;
    const now = this.#ctx.currentTime;
    const old = this.#bed;
    if (old) {
      old.out.gain.cancelScheduledValues(now);
      old.out.gain.setValueAtTime(old.out.gain.value, now);
      old.out.gain.linearRampToValueAtTime(0, now + 1.8);
      for (const s of old.stops) s.stop(now + 1.9);
      setTimeout(() => old.out.disconnect(), 2200);
    }
    const bed: Bed = { out: this.#ctx.createGain(), stops: [], events: [] };
    bed.out.gain.setValueAtTime(0, now);
    bed.out.gain.linearRampToValueAtTime(1, now + 2.5);
    bed.out.connect(this.#out);
    if (p.look === "neon") this.#city(bed);
    else if (p.look === "grove") (p.night ? this.#night(bed, p) : this.#day(bed, p));
    else this.#room(bed);
    if (p.rain || p.storm) this.#rain(bed, p.storm);
    if (p.snow) this.#wind(bed, 380, 0.05);
    this.#bed = bed;
  }

  /** Scatter the events that fall due in the next little while. */
  pump() {
    const bed = this.#bed;
    if (!bed) return;
    const now = this.#ctx.currentTime;
    for (const e of bed.events) {
      if (e.next < now) e.next = now + rand(...e.every) * Math.random(); // after a pause, don't burst
      if (e.next > now + 0.2) continue;
      e.play(e.next);
      e.next += rand(...e.every);
    }
  }

  // ---- building blocks ------------------------------------------------------------------------

  /** Endless filtered noise at a level, its level breathing on a slow LFO. */
  #layer(bed: Bed, type: BiquadFilterType, f: number, q: number, level: number, lfoHz: number, lfoDepth: number, sweep?: [number, number]): GainNode {
    const ctx = this.#ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = level;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = lfoHz;
    const depth = ctx.createGain();
    depth.gain.value = level * lfoDepth;
    lfo.connect(depth).connect(g.gain);
    if (sweep) {
      // the wind's pitch wanders too
      const fl = ctx.createOscillator();
      fl.frequency.value = sweep[0];
      const fd = ctx.createGain();
      fd.gain.value = sweep[1];
      fl.connect(fd).connect(flt.frequency);
      fl.start();
      bed.stops.push(fl);
    }
    src.connect(flt).connect(g).connect(bed.out);
    src.start(0, Math.random() * this.#noise.duration);
    lfo.start();
    bed.stops.push(src, lfo);
    return g;
  }

  /** A quiet steady tone (mains hum, a neon tube). */
  #hum(bed: Bed, f: number, level: number, type: OscillatorType = "sine", band?: number) {
    const ctx = this.#ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = level;
    if (band) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = band;
      bp.Q.value = 6;
      o.connect(bp).connect(g);
    } else o.connect(g);
    g.connect(bed.out);
    o.start();
    bed.stops.push(o);
  }

  /** A one-off voice for a scattered event: a panner, a level and a reverb send. */
  #spot(bed: Bed, pan: number, level: number, wet = 0.4): AudioNode {
    const ctx = this.#ctx;
    const g = ctx.createGain();
    g.gain.value = level;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    const send = ctx.createGain();
    send.gain.value = wet;
    g.connect(p).connect(bed.out);
    p.connect(send).connect(this.#rev);
    setTimeout(() => g.disconnect(), 4000);
    return g;
  }

  #tone(dest: AudioNode, t: number, f: number, to: number, a: number, d: number, peak: number, type: OscillatorType = "sine") {
    const ctx = this.#ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(to, t + a + d);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(SILENT, t + a + d);
    o.connect(g).connect(dest);
    o.onended = () => g.disconnect();
    o.start(t);
    o.stop(t + a + d + 0.03);
  }

  #burst(dest: AudioNode, t: number, type: BiquadFilterType, f: number, to: number, q: number, a: number, d: number, peak: number) {
    const ctx = this.#ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.setValueAtTime(f, t);
    flt.frequency.exponentialRampToValueAtTime(to, t + a + d);
    flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(SILENT, t + a + d);
    src.connect(flt).connect(g).connect(dest);
    src.onended = () => g.disconnect();
    src.start(t, Math.random() * (this.#noise.duration - 0.5));
    src.stop(t + a + d + 0.03);
  }

  #wind(bed: Bed, f: number, level: number) {
    this.#layer(bed, "bandpass", f, 0.6, level, 0.07, 0.6, [0.05, f * 0.5]);
  }

  // ---- the places ---------------------------------------------------------------------------

  /** Neon city: a low traffic rumble, a buzzing tube, and cars going by. */
  #city(bed: Bed) {
    this.#layer(bed, "lowpass", 170, 0.7, 0.32, 0.06, 0.35);
    this.#layer(bed, "bandpass", 460, 0.6, 0.05, 0.045, 0.9);
    this.#hum(bed, 120, 0.004, "sawtooth", 1300);
    this.#hum(bed, 60, 0.012);
    bed.events.push({
      next: 0,
      every: [6, 16],
      play: (t) => {
        // a car passing from one side to the other
        const dir = Math.random() < 0.5 ? -1 : 1;
        const p = this.#ctx.createStereoPanner();
        p.pan.setValueAtTime(-0.9 * dir, t);
        p.pan.linearRampToValueAtTime(0.9 * dir, t + 3.4);
        p.connect(bed.out);
        const dur = rand(2.6, 3.6);
        this.#burst(p, t, "bandpass", 260, 520, 0.9, dur * 0.55, dur * 0.45, rand(0.04, 0.07));
        this.#tone(p, t, rand(90, 120), rand(70, 85), dur * 0.55, dur * 0.45, 0.012, "sawtooth");
        setTimeout(() => p.disconnect(), (dur + 1) * 1000);
      },
    });
  }

  /** The grove by day: wind in the leaves and birds. */
  #day(bed: Bed, p: Place) {
    this.#wind(bed, 520, 0.07);
    this.#layer(bed, "highpass", 3200, 0.5, 0.012, 0.11, 0.8);
    if (p.rain || p.snow) return; // the birds keep quiet in bad weather
    bed.events.push({ next: 0, every: [2.2, 7], play: (t) => this.#bird(bed, t) });
    bed.events.push({ next: 0, every: [5, 12], play: (t) => this.#bird(bed, t) });
  }

  #bird(bed: Bed, t: number) {
    const v = this.#spot(bed, rand(-0.85, 0.85), rand(0.5, 1), 0.5);
    const kind = Math.floor(Math.random() * 3);
    const base = rand(2600, 4200);
    if (kind === 0) {
      // tweets: quick upward sweeps
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) this.#tone(v, t + i * 0.13, base, base * 1.45, 0.01, 0.06, 0.045);
    } else if (kind === 1) {
      // a falling warble
      this.#tone(v, t, base * 1.3, base * 0.8, 0.02, 0.28, 0.035);
      this.#tone(v, t + 0.32, base * 1.2, base * 0.75, 0.02, 0.22, 0.03);
    } else {
      // a trill
      for (let i = 0; i < 7; i++) this.#tone(v, t + i * 0.045, base * 1.15, base * 1.05, 0.004, 0.025, 0.03);
    }
  }

  /** The grove at night: a low breeze, crickets in rounds, and now and then an owl. */
  #night(bed: Bed, p: Place) {
    this.#wind(bed, 300, 0.05);
    if (p.snow) return;
    for (let i = 0; i < 3; i++) {
      const f = rand(4200, 5300);
      const pan = rand(-0.8, 0.8);
      let singing = Math.random() < 0.7;
      let until = 0;
      bed.events.push({
        next: 0,
        every: [0.5, 0.85],
        play: (t) => {
          // each cricket sings for a while, then rests
          if (t > until) ((singing = !singing), (until = t + (singing ? rand(4, 11) : rand(1.5, 4))));
          if (singing) this.#chirp(bed, t, f, pan);
        },
      });
    }
    bed.events.push({
      next: 0,
      every: [18, 40],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.7, 0.7), 0.8, 0.7);
        this.#tone(v, t, 400, 372, 0.06, 0.26, 0.03);
        this.#tone(v, t + 0.55, 410, 360, 0.08, 0.5, 0.035);
      },
    });
  }

  #chirp(bed: Bed, t: number, f: number, pan: number) {
    const ctx = this.#ctx;
    const o = ctx.createOscillator();
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    const pulses = 3 + Math.floor(Math.random() * 2);
    for (let i = 0; i < pulses; i++) {
      const at = t + i * 0.032;
      g.gain.linearRampToValueAtTime(0.012, at + 0.004);
      g.gain.setValueAtTime(0.012, at + 0.012);
      g.gain.linearRampToValueAtTime(0, at + 0.017);
    }
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(bed.out);
    o.onended = () => (g.disconnect(), p.disconnect());
    o.start(t);
    o.stop(t + pulses * 0.032 + 0.02);
  }

  /** The gallery: a quiet room, the air handling, and a faint hum. */
  #room(bed: Bed) {
    this.#layer(bed, "lowpass", 260, 0.6, 0.06, 0.03, 0.2);
    this.#layer(bed, "bandpass", 900, 3, 0.006, 0.05, 0.4);
    this.#hum(bed, 117, 0.005);
  }

  /** Rain: a wash of high noise, heavier in a storm (with thunder), and drops landing close by. */
  #rain(bed: Bed, storm: boolean) {
    const level = storm ? 0.2 : 0.12;
    this.#layer(bed, "highpass", 900, 0.5, level, 0.13, 0.25);
    this.#layer(bed, "bandpass", 5200, 0.7, level * 0.4, 0.21, 0.3);
    bed.events.push({
      next: 0,
      every: storm ? [0.04, 0.12] : [0.07, 0.2],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.9, 0.9), 1, 0.15);
        this.#burst(v, t, "bandpass", rand(2200, 6500), rand(1500, 3000), 2.5, 0.001, rand(0.006, 0.014), rand(0.01, 0.03));
      },
    });
    if (!storm) return;
    bed.events.push({
      next: 0,
      every: [16, 40],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.6, 0.6), 1, 0.6);
        this.#burst(v, t, "lowpass", 220, 90, 0.7, 0.06, rand(2.5, 4), 0.22);
        this.#burst(v, t + rand(0.5, 1.2), "lowpass", 160, 70, 0.7, 0.3, rand(2, 3), 0.14);
      },
    });
  }
}
