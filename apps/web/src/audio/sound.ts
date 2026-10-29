// The sound of a world: effects from the simulation's events and from the player's own motion,
// the place's ambience, and one adaptive music loop, mixed into a master bus that mute fades out.
// Read-only on the simulation: it listens to events and frames and never feeds anything back, so
// determinism is untouched (and cosmetic randomness here is fine).
import type { Vec3, WorldBundle } from "@ghostrun/ir";
import type { SimEvent } from "@ghostrun/sim";
import { probe, type AudioProbe } from "../probe";
import { lookOf } from "../render/looks";
import type { RapierSim } from "../sim/rapier";
import { PLAYER_ID, type Pose, type SimFrame } from "../sim/types";
import { Ambience } from "./ambience";
import { degree, keyName, Music, scoreFor, type Key } from "./music";
import * as fx from "./voices";
import { hz } from "./voices";

/** Where the sound is heard from: the camera (the headset in VR) and the way it faces. */
export type Ear = () => { p: Vec3; yaw: number } | null;

type Entity = WorldBundle["entities"][number];

const LEVEL = { master: 0.9, sfx: 0.85, amb: 0.5, music: 0.3 };
/** Room size per look: the gallery rings, the grove is open air. */
const WET = { neon: 0.3, grove: 0.2, gallery: 0.55 } as const;

interface Play {
  /** Where it happens (null: on the player, centred). */
  at?: Vec3 | null;
  gain?: number;
  /** How much goes to the reverb. */
  wet?: number;
  /** How far the music dips under it (0…1). */
  duck?: number;
  /** The shortest gap before the same sound plays again, in seconds. */
  gap?: number;
  /** A little pitch variation (off for notes that must stay in key). */
  vary?: boolean;
  pan?: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export class Sound {
  readonly ctx: AudioContext;
  readonly #master: GainNode;
  readonly #sfx: GainNode;
  readonly #duck: GainNode;
  readonly #revIn: GainNode;
  readonly #revOut: GainNode;
  readonly #noise: AudioBuffer;
  readonly #music: Music;
  readonly #ambience: Ambience;
  readonly #ear: Ear;
  readonly #probe: AudioProbe;
  #muted: boolean;

  #sim: RapierSim | null = null;
  #unsub: (() => void) | null = null;
  #verbs = new Map<string, Set<string>>();
  #ents = new Map<string, Entity>();
  #floor: fx.Floor = "street";
  #key: Key = { root: 57, mode: "dorian" };
  #ended = false;

  // the player, from the frames
  #poses: Map<string, Pose> | null = null;
  #last: Vec3 | null = null;
  #stride = 0;
  #fall = 0;
  /** Ticks off the ground in a row. */
  #air = 0;
  #foot = 1;
  #carrying = new Set<string>();
  #second = -1;
  #coins = { at: -9, n: 0, tick: -1 };

  #lastAt = new Map<string, number>();
  #recent: number[] = [];

  constructor(ctx: AudioContext, o: { muted: boolean; ear: Ear }) {
    this.ctx = ctx;
    this.#ear = o.ear;
    this.#muted = o.muted;
    this.#noise = noiseBuffer(ctx);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    this.#master = ctx.createGain();
    this.#master.gain.value = o.muted ? 0 : LEVEL.master;
    this.#master.connect(comp);
    this.#sfx = gain(ctx, LEVEL.sfx, this.#master);
    const amb = gain(ctx, LEVEL.amb, this.#master);
    this.#duck = gain(ctx, 1, this.#master);
    const music = gain(ctx, LEVEL.music, this.#duck);
    const rev = ctx.createConvolver();
    rev.buffer = impulse(ctx, 2.6, 3.2);
    this.#revIn = ctx.createGain();
    this.#revOut = gain(ctx, WET.neon, this.#master);
    this.#revIn.connect(rev).connect(this.#revOut);
    this.#music = new Music(ctx, music, this.#revIn, this.#noise);
    this.#ambience = new Ambience(ctx, amb, this.#revIn, this.#noise);

    this.#probe = { state: ctx.state, muted: o.muted, played: 0, counts: {} };
    probe().audio = this.#probe;
    ctx.addEventListener("statechange", () => (this.#probe.state = ctx.state));
    if (o.muted) void ctx.suspend();
    // a hidden tab goes quiet (and costs nothing); it comes back when shown
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void ctx.suspend();
      else if (!this.#muted) void ctx.resume().catch(() => undefined);
    });
    setInterval(() => this.#pump(), 25);
  }

  get muted(): boolean {
    return this.#muted;
  }

  setMuted(m: boolean) {
    this.#muted = m;
    this.#probe.muted = m;
    const now = this.ctx.currentTime;
    const g = this.#master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(m ? 0 : LEVEL.master, now + 0.15);
    // after the fade, stop the clock altogether: no CPU spent on sound nobody hears
    if (m) setTimeout(() => this.#muted && void this.ctx.suspend(), 250);
    else void this.ctx.resume().catch(() => undefined);
  }

  /** A new world (or the same one from the top): its place, its music, its events. */
  world(b: WorldBundle, sim: RapierSim | null) {
    this.#unsub?.();
    this.#sim = sim;
    this.#unsub = sim?.subscribe((evs) => this.#events(evs)) ?? null;
    this.#verbs = new Map();
    for (const v of b.verbs) {
      const set = this.#verbs.get(v.on) ?? new Set<string>();
      set.add(v.verb);
      this.#verbs.set(v.on, set);
    }
    this.#ents = new Map(b.entities.map((e) => [e.id, e]));
    this.#poses = null;
    this.#last = null;
    this.#stride = this.#fall = this.#air = 0;
    this.#carrying.clear();
    this.#second = -1;
    this.#ended = false;

    const look = lookOf(b);
    const storm = look.rain && b.cosmetic.weather === "storm";
    this.#floor = look.id === "gallery" ? "hard" : look.rain ? "wet" : look.id === "grove" ? "soft" : "street";
    this.#revOut.gain.setTargetAtTime(WET[look.id], this.ctx.currentTime, 0.5);
    this.#ambience.set({ look: look.id, night: look.night, rain: look.rain, storm, snow: b.cosmetic.weather === "snow" });
    const score = scoreFor({ mood: b.cosmetic.mood, timeOfDay: b.cosmetic.timeOfDay, look: look.id, night: look.night });
    this.#key = score.key;
    this.#music.start(score);
    this.#probe.music = { key: keyName(score.key), bpm: score.bpm };
    this.#play("arrive", (v) => fx.arrive(v, this.#chord(0, 4, 1)), { vary: false, wet: 0.6 });
  }

  /** One simulation frame: the player's footsteps and falls, and where everything is. */
  frame(f: SimFrame) {
    this.#poses = f.poses;
    const p = f.poses.get(PLAYER_ID)?.p;
    if (!p) return;
    const last = this.#last;
    this.#last = [p[0], p[1], p[2]];
    if (!last) return;
    const [dx, dy, dz] = [p[0] - last[0], p[1] - last[1], p[2] - last[2]];
    const d = Math.hypot(dx, dz);
    if (d > 1 || Math.abs(dy) > 1) return; // a respawn or a portal, not a step
    // the controller's grounded flag flickers walking on the flat: a few ticks off it still count as ground
    const grounded = this.#sim ? this.#sim.sim.player.grounded : Math.abs(dy) < 0.004;
    this.#air = grounded ? 0 : this.#air + 1;
    if (!grounded) this.#fall = Math.min(this.#fall, dy * 60);
    if (this.#air > 3) return;
    if (d < 0.003) return;
    // a stride grows with speed: about three steps a second at a run
    const speed = d * 60;
    const stride = 1.15 + 0.14 * speed;
    this.#stride += d;
    if (this.#stride < stride) return;
    this.#stride -= stride;
    this.#foot = -this.#foot;
    this.#play("step", (v) => fx.step(v, this.#floor, Math.min(1, 0.45 + speed / 10)), { gap: 0.12, pan: this.#foot * 0.1, wet: this.#floor === "hard" ? 0.35 : 0.1 });
  }

  // ---- the simulation's events ---------------------------------------------------------------

  #events(evs: SimEvent[]) {
    for (const ev of evs) this.#event(ev);
  }

  #event(ev: SimEvent) {
    const me = ev.a === PLAYER_ID;
    switch (ev.k) {
      case "jump":
        if (!me) return;
        this.#air = 99; // in the air from this tick: no step as you leave the ground
        this.#play("jump", fx.jump, { gain: 0.8 });
        return;
      case "air_jump":
        if (me) this.#play("air-jump", fx.airJump);
        return;
      case "land": {
        if (!me) return;
        const impact = clamp01((-this.#fall - 3) / 10);
        this.#fall = 0;
        this.#play("land", (v) => fx.land(v, impact), { gain: 0.5 + 0.5 * impact, gap: 0.12 });
        return;
      }
      case "pickup": {
        const mine = ev.b === PLAYER_ID;
        if (mine && !this.#has(ev.a, "combat_sport.throw")) this.#carrying.add(ev.a);
        this.#play(mine ? "pickup" : "pickup-far", (v) => fx.grab(v, this.#note(mine ? 7 : 4)), { at: mine ? null : this.#where(ev.b), gain: mine ? 1 : 0.6, duck: mine ? 0.35 : 0.1, vary: false });
        return;
      }
      case "drop":
        if (ev.b === PLAYER_ID) this.#carrying.delete(ev.a);
        this.#play("drop", (v) => fx.drop(v, this.#note(4)), { at: ev.b === PLAYER_ID ? null : this.#where(ev.b), gain: 0.7, vary: false });
        return;
      case "tag":
        if (ev.b === PLAYER_ID) this.#play("tagged", fx.tagged, { duck: 0.4 });
        else if (me) this.#play("tag", fx.tag, { duck: 0.2 });
        else this.#play("tag-far", fx.tag, { at: this.#where(ev.a), gain: 0.5 });
        return;
      case "touch":
        return this.#touch(ev, me);
      case "score": {
        if (ev.tick === this.#coins.tick) return; // the coin already said it
        const ours = ev.a !== "team:blue";
        if (ours) this.#play("score", (v) => fx.scored(v, this.#chord(0, 4, 1)), { duck: 0.6, gap: 0.2, vary: false, wet: 0.4 });
        else this.#play("score-rival", (v) => fx.conceded(v, this.#note(4), this.#note(2)), { duck: 0.4, gap: 0.2, vary: false });
        return;
      }
      case "hit": {
        const e = this.#ents.get(ev.b);
        const at = me ? null : this.#where(ev.a);
        if (this.#has(ev.b, "motion_hazards.hazard") || e?.kind === "hazard") {
          const harm = fx.harmOf(`${e?.noun ?? ""} ${e?.hyper ?? ""}`.toLowerCase());
          this.#play(me ? "hurt" : "hurt-far", (v) => fx.hurt(v, harm), { at, gain: me ? 1 : 0.5, duck: me ? 0.5 : 0 });
        } else this.#play(me ? "hit-me" : "hit", fx.impact, { at, duck: me ? 0.4 : 0.15 });
        return;
      }
      case "respawn":
        if (!me) return;
        this.#carrying.clear();
        this.#play("respawn", fx.respawn, { duck: 0.3 });
        return;
      case "state":
        return this.#state(ev);
      case "enter":
        if (this.#has(ev.b, "puzzle.portal")) this.#play("portal", fx.portal, { at: me ? null : this.#where(ev.b), duck: me ? 0.3 : 0, gap: 0.3, wet: 0.5 });
        return;
      case "teleport":
        this.#play("portal", fx.portal, { at: ev.a === PLAYER_ID ? null : this.#where(ev.a), gap: 0.3, wet: 0.5 });
        return;
      case "destroy":
        // a coin is its chime, a key its lock: only other things go with a pop
        if (!this.#has(ev.a, "puzzle.collect") && !this.#has(ev.a, "physics_props.carry") && !this.#carrying.has(ev.a)) this.#play("pop", fx.pop, { at: this.#where(ev.a), gain: 0.7 });
        this.#carrying.delete(ev.a);
        return;
      case "reset":
        // a rule sent it home (a respawn's own reset is covered by the respawn)
        this.#carrying.delete(ev.a);
        if (ev.rule) this.#play("reset", fx.fwip, { at: this.#where(ev.a), gain: 0.6 });
        return;
      case "emit":
        this.#play("emit", (v) => fx.sparkle(v, this.#chord(0, 4, 1)), { at: this.#where(ev.a), gap: 0.3, vary: false, wet: 0.5 });
        return;
      case "timer_end":
        this.#play("gong", fx.gong, { duck: 0.6, wet: 0.5 });
        return;
      case "win":
      case "lose": {
        this.#ended = true;
        this.#carrying.clear();
        this.#music.end(ev.k === "lose");
        if (ev.k === "win") this.#play("win", (v) => fx.win(v, this.#chord(0, 5, 1)), { duck: 1, gap: 1, vary: false, wet: 0.5 });
        else this.#play("lose", (v) => fx.lose(v, [this.#note(4), this.#note(2), this.#note(0)]), { duck: 1, gap: 1, vary: false, wet: 0.4 });
        return;
      }
      case "shoot":
      case "shot":
        this.#play("shoot", fx.pew, { at: me ? null : this.#where(ev.a), gain: me ? 0.9 : 0.6 });
        return;
    }
  }

  /** Someone touched or used something: what it sounds like depends on the verb that's on it. */
  #touch(ev: SimEvent, me: boolean) {
    const at = me ? null : this.#where(ev.a);
    if (this.#has(ev.b, "puzzle.collect")) {
      if (me && this.#ents.get(ev.b)?.tags.includes("bonus")) return this.#play("secret", (v) => fx.secret(v, this.#chord(0, 4, 1)), { duck: 0.5, wet: 0.5, vary: false });
      // a run of coins climbs the scale
      const now = this.ctx.currentTime;
      if (me) ((this.#coins.n = now - this.#coins.at < 2.5 ? this.#coins.n + 1 : 0), (this.#coins.at = now), (this.#coins.tick = ev.tick));
      const f = hz(degree(this.#key, 7 + (me ? this.#coins.n % 8 : 0)) + 12);
      return this.#play(me ? "coin" : "coin-far", (v) => fx.coin(v, f), { at, gain: me ? 1 : 0.45, duck: me ? 0.3 : 0, vary: false, wet: 0.3 });
    }
    if (this.#has(ev.b, "combat_sport.throw")) return this.#play("throw", fx.whoosh, { at });
    if (this.#has(ev.b, "combat_sport.shove")) return this.#play("shove", fx.shove, { at, duck: me ? 0.2 : 0 });
    if (this.#has(ev.b, "combat_sport.catch")) return this.#play("catch", (v) => fx.caught(v, this.#note(9)), { at, duck: 0.3, vary: false });
    if (this.#has(ev.b, "social.inspect")) return me ? this.#play("inspect", (v) => fx.info(v, this.#note(11)), { vary: false, wet: 0.4 }) : undefined;
    // switches and locks speak when their state changes
    if (this.#has(ev.b, "puzzle.switch") || this.#has(ev.b, "puzzle.lock")) return;
    if (me) this.#play("use", fx.use, { gain: 0.7 });
  }

  #state(ev: SimEvent) {
    const v = String(ev.v);
    const at = this.#where(ev.a);
    if (this.#has(ev.a, "puzzle.timer")) return;
    if (this.#has(ev.a, "puzzle.switch")) return this.#play("switch", (x) => fx.flip(x, v === "on"), { at });
    if (this.#has(ev.a, "puzzle.plate")) return v === "down" || v === "up" ? this.#play("plate", (x) => fx.plate(x, v === "down"), { at, gap: 0.1 }) : undefined;
    if (this.#has(ev.a, "puzzle.checkpoint")) return v === "reached" ? this.#play("checkpoint", (x) => fx.checkpoint(x, this.#chord(0, 3, 1)), { duck: 0.5, wet: 0.5, vary: false }) : undefined;
    if (this.#has(ev.a, "motion_hazards.crumble")) return v === "fallen" ? this.#play("crumble", fx.crumble, { at }) : undefined;
    if (this.#has(ev.a, "puzzle.lock") && v === "open") return this.#play("unlock", (x) => fx.unlock(x, this.#note(7, 1)), { at, duck: 0.4, vary: false, wet: 0.4 });
    if (v === "open" || (v === "closed" && this.#ents.get(ev.a)?.kind === "door")) return this.#play("door", (x) => fx.door(x, v === "open"), { at, duck: 0.25 });
    // any other change the world's rules make: a soft tick, so something audibly happened
    this.#play("state", fx.use, { at, gain: 0.5, gap: 0.5 });
  }

  // ---- mixing ----------------------------------------------------------------------------------

  /**
   * Play one effect: throttled (the same sound can't stack up, and no more than a handful start at
   * once, as when a replay fast-forwards), panned and faded by distance, ducking the music under it.
   */
  #play(name: string, recipe: (v: fx.Voice) => number, o: Play = {}) {
    const ctx = this.ctx;
    if (this.#muted || ctx.state !== "running") return;
    const now = ctx.currentTime;
    if (now - (this.#lastAt.get(name) ?? -9) < (o.gap ?? 0.05)) return;
    this.#recent = this.#recent.filter((t) => now - t < 0.12);
    if (this.#recent.length >= 8) return;
    const { pan, gain: far } = this.#place(o.at ?? null);
    const level = (o.gain ?? 1) * far;
    if (level < 0.03) return; // too far away to hear
    this.#lastAt.set(name, now);
    this.#recent.push(now);

    const g = ctx.createGain();
    g.gain.value = level;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan + (o.pan ?? 0)));
    const send = ctx.createGain();
    send.gain.value = o.wet ?? 0.2;
    g.connect(p).connect(this.#sfx);
    p.connect(send).connect(this.#revIn);
    const t = now + 0.005;
    const ring = recipe({ ctx, t, out: g, noise: this.#noise, p: o.vary === false ? 1 : 2 ** ((Math.random() - 0.5) * 0.12) });
    setTimeout(() => (g.disconnect(), p.disconnect(), send.disconnect()), (ring + 0.6) * 1000);

    const duck = o.duck ?? 0.15;
    if (duck > 0) {
      const dg = this.#duck.gain;
      dg.cancelScheduledValues(t);
      dg.setTargetAtTime(1 - 0.55 * duck, t, 0.02);
      dg.setTargetAtTime(1, t + 0.12 + 0.5 * duck, 0.35);
    }
    this.#probe.played++;
    this.#probe.counts[name] = (this.#probe.counts[name] ?? 0) + 1;
    this.#probe.last = name;
  }

  /** Pan and level for a sound at `at`, as heard from the player with the camera's bearing. */
  #place(at: Vec3 | null): { pan: number; gain: number } {
    if (!at) return { pan: 0, gain: 1 };
    const ear = this.#ear();
    if (!ear) return { pan: 0, gain: 1 };
    const me = this.#poses?.get(PLAYER_ID)?.p ?? ear.p;
    const [dx, dy, dz] = [at[0] - me[0], at[1] - me[1], at[2] - me[2]];
    const flat = Math.hypot(dx, dz);
    // the camera's right, in three's convention (yaw 0 looks down −z)
    const right = flat > 0.01 ? (dx * Math.cos(ear.yaw) - dz * Math.sin(ear.yaw)) / flat : 0;
    const d = Math.hypot(flat, dy);
    return { pan: 0.85 * right * Math.min(1, flat / 3), gain: 1 / (1 + Math.max(0, d - 4) / 9) };
  }

  #where(id: string): Vec3 | null {
    return this.#poses?.get(id)?.p ?? this.#ents.get(id)?.pos ?? null;
  }

  #has(id: string, verb: string): boolean {
    return this.#verbs.get(id)?.has(verb) ?? false;
  }

  /** A note of the song's key, so the effects and the music agree. */
  #note(d: number, octave = 0): number {
    return hz(degree(this.#key, d) + 12 * octave);
  }

  /** `n` notes of the chord on degree `d`, broken upwards (thirds, then the octave). */
  #chord(d: number, n: number, octave = 0): number[] {
    return [0, 2, 4, 7, 9].slice(0, n).map((x) => this.#note(d + x, octave));
  }

  /** Every 25 ms: tension (carrying, the clock), the countdown's last ten ticks, music and ambience. */
  #pump() {
    if (this.ctx.state !== "running") return;
    const left = this.#sim?.countdown ?? null;
    let tension = this.#carrying.size ? 0.5 : 0;
    if (left !== null && !this.#ended) {
      if (left > 0 && left <= 10) {
        tension = 1;
        const s = Math.ceil(left);
        if (s !== this.#second) {
          this.#second = s;
          this.#play("tick", (v) => fx.tick(v, s <= 3), { gap: 0.5, vary: false, duck: 0 });
        }
      } else if (left <= 30) tension = Math.max(tension, 0.3);
    }
    this.#music.tension = tension;
    this.#music.pump();
    this.#ambience.pump();
    if (this.#probe.music) this.#probe.music.bpm = this.#music.bpm;
  }
}

function gain(ctx: AudioContext, value: number, to: AudioNode): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  g.connect(to);
  return g;
}

/** Two seconds of white noise: every hiss, wind and raindrop is cut from it. */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/** A room's reverb tail: decaying noise, a little darker than white. */
function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const n = Math.round(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += 0.4 * (Math.random() * 2 - 1 - lp);
      d[i] = lp * (1 - i / n) ** decay;
    }
  }
  return b;
}
