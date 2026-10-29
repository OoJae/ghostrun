// The sound of the place, one bed per look: filtered noise under slow LFOs, with the odd event
// scattered over it (a car going by, a bird, a cricket's chirp, a raindrop, a beep, a creak). A new
// world crossfades from the last one's bed. Rain is a layer of its own that follows whether the
// world's rain is on (muffled when you hear it from indoors).
import type { LookStyle } from "../render/looks";

const SILENT = 0.0004;

export interface Place {
  look: LookStyle["id"];
  variant: string;
  night: boolean;
  rain: boolean;
  storm: boolean;
  snow: boolean;
  dust: boolean;
  /** Inside a building: the weather is heard through its walls. */
  indoor: boolean;
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
    switch (p.look) {
      case "neon": this.#city(bed); break;
      case "grove": (p.night ? this.#night(bed, p) : this.#day(bed, p)); break;
      case "desert": (p.variant === "underwater" ? this.#seabed(bed) : p.variant === "beach" ? this.#beach(bed, p) : this.#desert(bed, p)); break;
      case "snow": (p.variant === "cave" ? this.#cave(bed) : this.#snowfield(bed, p)); break;
      case "space": this.#station(bed, p.variant === "moon"); break;
      case "haunted": this.#haunt(bed, p); break;
      case "medieval": this.#castle(bed, p); break;
      case "candy": this.#candy(bed, p); break;
      case "jungle": this.#jungle(bed, p); break;
      case "home": this.#home(bed, p); break;
      default: (p.variant === "underwater" ? this.#seabed(bed) : this.#room(bed));
    }
    if (p.rain || p.storm) this.#rain(bed, p.storm, p.indoor);
    if (p.snow && p.look !== "snow") this.#wind(bed, 380, 0.05);
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
    this.#wind(bed, 520, 0.1);
    this.#layer(bed, "highpass", 3200, 0.5, 0.018, 0.11, 0.8);
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
    this.#wind(bed, 300, 0.08);
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
      g.gain.linearRampToValueAtTime(0.025, at + 0.004);
      g.gain.setValueAtTime(0.025, at + 0.012);
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
    this.#layer(bed, "lowpass", 260, 0.6, 0.08, 0.03, 0.2);
    this.#layer(bed, "bandpass", 900, 3, 0.006, 0.05, 0.4);
    this.#hum(bed, 117, 0.005);
  }

  /** A gust: wind rising and falling through a sweeping band, from one side. */
  #gust(bed: Bed, t: number, level: number, f = 420) {
    const v = this.#spot(bed, rand(-0.8, 0.8), 1, 0.2);
    const d = rand(1.8, 3.6);
    this.#burst(v, t, "bandpass", f * rand(0.8, 1.1), f * rand(1.8, 2.6), 0.9, d * 0.45, d * 0.55, level * rand(0.6, 1));
  }

  /** Desert: a dry wind with grains of sand in it and gusts sweeping through; at night, a few crickets. */
  #desert(bed: Bed, p: Place) {
    const storm = p.dust;
    this.#wind(bed, 420, storm ? 0.14 : 0.08);
    this.#layer(bed, "highpass", 4200, 0.6, storm ? 0.03 : 0.012, 0.17, 0.8);
    bed.events.push({ next: 0, every: storm ? [2.5, 6] : [7, 15], play: (t) => this.#gust(bed, t, storm ? 0.09 : 0.05) });
    if (!p.night) return;
    for (let i = 0; i < 2; i++) {
      const f = rand(3800, 4600);
      const pan = rand(-0.8, 0.8);
      bed.events.push({ next: 0, every: [0.6, 1.4], play: (t) => Math.random() < 0.6 && this.#chirp(bed, t, f, pan) });
    }
  }

  /** The beach: waves rolling in and drawing back, a sea breeze, now and then a gull. */
  #beach(bed: Bed, p: Place) {
    this.#layer(bed, "lowpass", 380, 0.6, 0.16, 0.09, 0.85);
    this.#layer(bed, "bandpass", 1300, 0.5, 0.035, 0.09, 0.9);
    this.#wind(bed, 600, 0.05);
    if (p.rain || p.night) return;
    bed.events.push({
      next: 0,
      every: [6, 15],
      play: (t) => {
        // a gull: two falling cries with a crack in them
        const v = this.#spot(bed, rand(-0.8, 0.8), rand(0.5, 0.9), 0.4);
        const f = rand(1500, 1900);
        this.#tone(v, t, f, f * 0.7, 0.03, 0.32, 0.02, "sawtooth");
        this.#tone(v, t + 0.42, f * 1.05, f * 0.68, 0.03, 0.26, 0.016, "sawtooth");
      },
    });
  }

  /** Under the sea: a deep muffled swell, and bubbles rising past. */
  #seabed(bed: Bed) {
    this.#layer(bed, "lowpass", 160, 0.7, 0.22, 0.07, 0.4);
    this.#layer(bed, "bandpass", 420, 0.8, 0.02, 0.11, 0.7);
    bed.events.push({
      next: 0,
      every: [0.8, 3],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.7, 0.7), rand(0.4, 1), 0.6);
        const n = 1 + Math.floor(Math.random() * 4);
        for (let i = 0; i < n; i++) {
          const f = rand(260, 520);
          this.#tone(v, t + i * rand(0.05, 0.12), f, f * 2.4, 0.004, 0.06, 0.03);
        }
      },
    });
  }

  /** Snowfields: the hush of snow, a low wind, gusts that lift it, and the odd crack of a branch. */
  #snowfield(bed: Bed, p: Place) {
    this.#wind(bed, 300, p.night ? 0.05 : 0.04);
    this.#layer(bed, "highpass", 5200, 0.5, 0.006, 0.08, 0.6);
    bed.events.push({ next: 0, every: [8, 18], play: (t) => this.#gust(bed, t, p.snow ? 0.07 : 0.05, 520) });
    bed.events.push({
      next: 0,
      every: [20, 45],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.8, 0.8), 0.6, 0.7);
        this.#burst(v, t, "bandpass", 1800, 900, 1.2, 0.002, 0.08, 0.05);
      },
    });
  }

  /** An ice cave: a low drone under the rock and water dripping into pools, ringing round the walls. */
  #cave(bed: Bed) {
    this.#layer(bed, "lowpass", 110, 0.7, 0.14, 0.04, 0.3);
    this.#hum(bed, 55, 0.006);
    bed.events.push({
      next: 0,
      every: [1.2, 4],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.9, 0.9), rand(0.4, 1), 0.85);
        const f = rand(1100, 1900);
        this.#tone(v, t, f, f * 0.55, 0.002, 0.09, 0.03);
      },
    });
  }

  /** A space station: the air handling, a mains hum, panels beeping and a servo whirring somewhere. On the moon, almost nothing. */
  #station(bed: Bed, moon: boolean) {
    if (moon) {
      this.#layer(bed, "lowpass", 90, 0.7, 0.07, 0.03, 0.3);
      this.#hum(bed, 50, 0.004);
    } else {
      this.#layer(bed, "lowpass", 300, 0.6, 0.09, 0.05, 0.2);
      this.#layer(bed, "bandpass", 1800, 2, 0.006, 0.07, 0.5);
      this.#hum(bed, 60, 0.012);
      this.#hum(bed, 120, 0.004, "sawtooth", 900);
    }
    bed.events.push({
      next: 0,
      every: moon ? [9, 20] : [3, 9],
      play: (t) => {
        // a console: two or three short tones
        const v = this.#spot(bed, rand(-0.8, 0.8), rand(0.4, 0.8), 0.35);
        const base = [880, 1175, 1320, 1568][Math.floor(Math.random() * 4)]!;
        const n = 2 + Math.floor(Math.random() * 2);
        for (let i = 0; i < n; i++) this.#tone(v, t + i * 0.11, base * (i % 2 ? 1.335 : 1), base * (i % 2 ? 1.335 : 1), 0.004, 0.07, 0.022, "square");
      },
    });
    if (moon) return;
    bed.events.push({
      next: 0,
      every: [10, 22],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.8, 0.8), 0.7, 0.4);
        const d = rand(0.6, 1.2);
        this.#burst(v, t, "bandpass", 700, 2400, 4, d * 0.5, d * 0.5, 0.025);
        this.#tone(v, t, 180, 320, d * 0.5, d * 0.5, 0.006, "sawtooth");
      },
    });
  }

  /** Haunted: a low beating drone, the wind moaning far off, timbers creaking, and now and then a distant bell. */
  #haunt(bed: Bed, p: Place) {
    this.#hum(bed, 55, 0.008);
    this.#hum(bed, 55.6, 0.008); // two close tones beat slowly against each other
    this.#layer(bed, "lowpass", 140, 0.7, 0.1, 0.05, 0.4);
    // the wind's howl: a narrow band sweeping slowly
    this.#layer(bed, "bandpass", 520, 6, 0.05, 0.06, 0.8, [0.04, 220]);
    bed.events.push({
      next: 0,
      every: [6, 15],
      play: (t) => {
        // a creak: a slow, rough, falling groan through a resonant band
        const v = this.#spot(bed, rand(-0.9, 0.9), rand(0.5, 1), 0.6);
        const bp = this.#ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = rand(600, 1100);
        bp.Q.value = 5;
        bp.connect(v);
        const f = rand(70, 110);
        this.#tone(bp, t, f, f * 0.75, 0.15, rand(0.5, 0.9), 0.06, "sawtooth");
        setTimeout(() => bp.disconnect(), 2500);
      },
    });
    if (p.indoor) return;
    bed.events.push({
      next: 0,
      every: [25, 50],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.5, 0.5), 0.5, 0.9);
        this.#tone(v, t, 196, 194, 0.01, 3.5, 0.02);
        this.#tone(v, t, 196 * 2.76, 196 * 2.74, 0.01, 2.2, 0.006);
      },
    });
  }

  /** A crackle of flames: tiny bright pops at random, louder now and then. */
  #crackle(bed: Bed, level: number) {
    bed.events.push({
      next: 0,
      every: [0.04, 0.3],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.6, 0.6), 1, 0.2);
        this.#burst(v, t, "highpass", rand(1500, 4000), rand(1200, 3000), 0.7, 0.001, rand(0.004, 0.02), level * (Math.random() < 0.1 ? 2.5 : rand(0.3, 1)));
      },
    });
    this.#layer(bed, "lowpass", 400, 0.6, level * 2.5, 0.3, 0.5); // the fire's low roar
  }

  /** The castle: torches crackling, a breeze over the walls and birds by day; crickets and an owl by night. Magic adds a shimmer. */
  #castle(bed: Bed, p: Place) {
    this.#wind(bed, 480, 0.06);
    this.#crackle(bed, p.night ? 0.012 : 0.006);
    if (p.variant === "magic") {
      bed.events.push({
        next: 0,
        every: [2.5, 7],
        play: (t) => {
          const v = this.#spot(bed, rand(-0.8, 0.8), rand(0.4, 0.8), 0.7);
          const scale = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
          for (let i = 0; i < 3; i++) {
            const f = 1046 * scale[Math.floor(Math.random() * scale.length)]!;
            this.#tone(v, t + i * 0.09, f, f, 0.005, 0.5, 0.012);
          }
        },
      });
    }
    if (p.night) return this.#night(bed, { ...p, look: "grove" });
    if (p.rain) return;
    bed.events.push({ next: 0, every: [3, 9], play: (t) => this.#bird(bed, t) });
  }

  /** Candy land: a music box chiming in the breeze, never the same tune twice. */
  #candy(bed: Bed, p: Place) {
    this.#wind(bed, 700, 0.05);
    const scale = [0, 2, 4, 7, 9, 12, 14, 16];
    bed.events.push({
      next: 0,
      every: [1.4, 3.8],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.7, 0.7), rand(0.4, 0.8), 0.6);
        const n = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) {
          const f = 1046.5 * 2 ** (scale[Math.floor(Math.random() * scale.length)]! / 12);
          this.#tone(v, t + i * 0.16, f, f, 0.003, 0.6, p.night ? 0.014 : 0.02, "triangle");
        }
      },
    });
  }

  /** The jungle: insects buzzing in waves, calls and whoops from the canopy; at night crickets and frogs. */
  #jungle(bed: Bed, p: Place) {
    this.#wind(bed, 380, 0.04);
    // cicadas: a narrow high band whose level swells and fades
    this.#layer(bed, "bandpass", 5600, 7, 0.034, 0.09, 0.95);
    this.#layer(bed, "bandpass", 4300, 6, 0.018, 0.13, 0.9);
    if (p.night) {
      this.#night(bed, { ...p, look: "grove" });
      bed.events.push({
        next: 0,
        every: [0.5, 1.6],
        play: (t) => {
          // a frog: a few low rubbery pulses
          const v = this.#spot(bed, rand(-0.9, 0.9), rand(0.4, 0.9), 0.3);
          const f = rand(240, 380);
          for (let i = 0; i < 3; i++) this.#tone(v, t + i * 0.07, f, f * 0.9, 0.006, 0.05, 0.03, "triangle");
        },
      });
      return;
    }
    if (p.rain) return;
    bed.events.push({ next: 0, every: [2, 6], play: (t) => this.#bird(bed, t) });
    bed.events.push({
      next: 0,
      every: [7, 16],
      play: (t) => {
        // a whooping call from the canopy, rising
        const v = this.#spot(bed, rand(-0.9, 0.9), rand(0.5, 0.9), 0.6);
        const f = rand(500, 700);
        for (let i = 0; i < 3; i++) this.#tone(v, t + i * 0.28, f * (1 + i * 0.12), f * (1.5 + i * 0.12), 0.03, 0.2, 0.025);
      },
    });
  }

  /** A home: room tone, the fridge's hum and a clock ticking; a tea house hears a bamboo knock; a library turns a page. */
  #home(bed: Bed, p: Place) {
    this.#layer(bed, "lowpass", 220, 0.6, 0.085, 0.03, 0.2);
    this.#hum(bed, 98, 0.003);
    if (p.variant === "japanese") {
      bed.events.push({
        next: 0,
        every: [14, 26],
        play: (t) => {
          // a shishi-odoshi: water tips the bamboo, which knocks on the stone
          const v = this.#spot(bed, rand(-0.6, 0.6), 0.8, 0.6);
          this.#tone(v, t, 520, 380, 0.002, 0.18, 0.05, "triangle");
          this.#burst(v, t, "bandpass", 1400, 900, 2, 0.001, 0.05, 0.04);
        },
      });
    } else {
      let tick = true;
      bed.events.push({
        next: 0,
        every: [1, 1],
        play: (t) => {
          const v = this.#spot(bed, 0.35, 0.5, 0.3);
          this.#burst(v, t, "bandpass", tick ? 3200 : 2700, 2000, 4, 0.001, 0.012, 0.03);
          tick = !tick;
        },
      });
    }
    if (p.variant !== "library") return;
    bed.events.push({
      next: 0,
      every: [12, 28],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.7, 0.7), 0.7, 0.4);
        this.#burst(v, t, "highpass", 2500, 4500, 0.7, 0.04, 0.18, 0.025);
      },
    });
  }

  /** Rain: a wash of high noise, heavier in a storm (with thunder), and drops landing close by. */
  #rain(bed: Bed, storm: boolean, indoor = false) {
    const level = storm ? 0.085 : 0.05;
    if (indoor) {
      // heard through the walls: the wash without its hiss, on the roof rather than all around
      this.#layer(bed, "lowpass", 1400, 0.5, level * 0.8, 0.13, 0.25);
      this.#layer(bed, "bandpass", 700, 0.7, level * 0.4, 0.21, 0.3);
    } else {
      this.#layer(bed, "highpass", 900, 0.5, level, 0.13, 0.25);
      this.#layer(bed, "bandpass", 5200, 0.7, level * 0.4, 0.21, 0.3);
    }
    bed.events.push({
      next: 0,
      every: storm ? [0.04, 0.12] : [0.07, 0.2],
      play: (t) => {
        const v = this.#spot(bed, rand(-0.9, 0.9), 1, 0.15);
        this.#burst(v, t, "bandpass", rand(2200, 6500), rand(1500, 3000), 2.5, 0.001, rand(0.006, 0.014), rand(0.005, 0.016));
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
