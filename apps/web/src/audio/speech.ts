// Spoken lines: NPC barks and replies, and the Host's answers, in the browser's own voices
// (speechSynthesis: no audio files, no paid TTS, nothing leaves the device but what the browser's
// speech service already does). Cosmetic, like the rest of the sound: it never feeds the simulation.
//
// One line at a time. A reply or a Host line cuts in over anything less important (the newest one
// wins); a bark waits its turn in a single slot (a newer bark replaces it) and is dropped if it has
// gone stale by the time the voice is free, because the moment it was about has passed.

export type Kind = "bark" | "reply" | "host";

const RANK: Record<Kind, number> = { bark: 0, reply: 1, host: 2 };
/** How long a line may wait for the voice before it is no longer worth saying. */
const STALE_MS: Record<Kind, number> = { bark: 4000, reply: 12_000, host: 20_000 };
/** Long enough for a line or two (a Host answer); Chrome's online voices cut off past ~15 s. */
const MAX_CHARS = 220;

/** Who is speaking: an NPC (its id, cast role and persona prose) or the Host. */
export interface Speaker {
  id: string;
  /** A cast role (guard, merchant, guide, rival, teammate, creature, citizen) or "host". */
  role: string;
  persona?: string;
}

// The slices of the Web Speech API used here, so a fake can stand in for it in tests.
export interface VoiceLike {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
  default: boolean;
}
export interface UtteranceLike {
  text: string;
  lang: string;
  voice: VoiceLike | null;
  pitch: number;
  rate: number;
  volume: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}
export interface SynthLike {
  speak(u: UtteranceLike): void;
  cancel(): void;
  getVoices(): VoiceLike[];
  addEventListener?(type: "voiceschanged", fn: () => void): void;
  removeEventListener?(type: "voiceschanged", fn: () => void): void;
}

/** One line as it was handed to the voice (the probe keeps the last few). */
export interface Spoken {
  who: string;
  text: string;
  kind: Kind;
  voice: string;
  lang: string;
  pitch: number;
  rate: number;
}

export interface SpeechStats {
  state: "on" | "disabled" | "unsupported";
  muted: boolean;
  speaking: boolean;
  /** Lines started, and lines dropped (muted, stale, or pushed out by a newer one). */
  spoken: number;
  dropped: number;
  voices: number;
  lang: string;
  last?: Spoken;
  lines: Spoken[];
}

/** FNV-1a: a stable number from a name, so a character gets the same voice every time. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const primary = (lang: string) => lang.toLowerCase().split(/[-_]/)[0] ?? "";

// macOS ships joke voices (they sing, bubble or whisper): never a character's voice when there are others
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox)\b/i;

/**
 * The voices to cast from: those for the world's language, else the reader's own, else English,
 * else whatever the browser has. Sorted by URI, so the order (and every pick) is stable.
 */
export function voicesFor(all: readonly VoiceLike[], lang: string, fallback = "en"): VoiceLike[] {
  const real = all.filter((v) => !NOVELTY.test(v.name));
  const pool = real.length ? real : [...all];
  for (const want of [lang, fallback, "en"]) {
    if (!want) continue;
    const m = pool.filter((v) => primary(v.lang) === primary(want));
    if (m.length) return m.sort((a, b) => (a.voiceURI < b.voiceURI ? -1 : a.voiceURI > b.voiceURI ? 1 : 0));
  }
  return pool.sort((a, b) => (a.voiceURI < b.voiceURI ? -1 : a.voiceURI > b.voiceURI ? 1 : 0));
}

/**
 * A speaker's voice. The Host gets the language's default voice (else its first on-device one), so
 * it sounds the same in every world; each NPC hashes its id and persona onto the rest, preferring
 * on-device voices (they start at once and aren't cut off), so two characters rarely share one.
 */
export function pickVoice(cands: readonly VoiceLike[], who: Speaker): VoiceLike | null {
  if (!cands.length) return null;
  const local = cands.filter((v) => v.localService);
  const host = cands.find((v) => v.default) ?? local[0] ?? cands[0]!;
  if (who.role === "host") return host;
  const pool = (local.length >= 2 ? local : [...cands]).filter((v) => v !== host || cands.length === 1);
  const from = pool.length ? pool : [host];
  return from[hash(`${who.id}|${who.persona ?? ""}`) % from.length]!;
}

/** How each role sounds: a guard low and measured, a rival quick, a creature deep and slow. */
const ROLE: Record<string, { pitch: number; rate: number }> = {
  host: { pitch: 1, rate: 1.02 },
  guard: { pitch: 0.78, rate: 0.92 },
  merchant: { pitch: 1.15, rate: 1.08 },
  guide: { pitch: 1.05, rate: 0.94 },
  rival: { pitch: 0.94, rate: 1.12 },
  teammate: { pitch: 1.1, rate: 1.06 },
  creature: { pitch: 0.6, rate: 0.86 },
  citizen: { pitch: 1, rate: 1 },
};

/** Words in a persona that move its voice (up for young and lively, down for old, big or machine). */
const TRAITS: { re: RegExp; pitch: number; rate: number }[] = [
  { re: /\b(old|elderly|ancient|aged|wise|weary|tired|gruff|grizzled|grumpy|stern)\b/i, pitch: -0.12, rate: -0.08 },
  { re: /\b(young|kid|child|cheerful|excited|bubbly|eager|nervous|energetic|playful|chirpy)\b/i, pitch: 0.12, rate: 0.08 },
  { re: /\b(robot|robotic|android|machine|droid|automaton)\b/i, pitch: -0.2, rate: -0.04 },
  { re: /\b(giant|huge|ogre|troll|monster|beast|dragon|minotaur|golem)\b/i, pitch: -0.18, rate: -0.08 },
];

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Pitch and rate for a speaker: its role's, moved by its persona, and nudged apart by its id. */
export function tone(who: Speaker): { pitch: number; rate: number } {
  const base = ROLE[who.role] ?? ROLE.citizen!;
  if (who.role === "host") return { ...base };
  let { pitch, rate } = base;
  for (const t of TRAITS) if (t.re.test(who.persona ?? "")) ((pitch += t.pitch), (rate += t.rate));
  // two guards in one world still sound like two people
  const h = hash(who.id);
  pitch += ((h % 13) - 6) / 100;
  rate += (((h >>> 8) % 9) - 4) / 100;
  return { pitch: Math.round(clamp(pitch, 0.3, 1.8) * 100) / 100, rate: Math.round(clamp(rate, 0.7, 1.4) * 100) / 100 };
}

/** Text as it should be said: no stage directions, links or emoji, and not too long. */
export function speakable(text: string): string {
  const t = text
    .replace(/\*[^*]*\*/g, " ") // *grins*
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ") // (blue 1–3), [laughs]
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}▶✓✗★]/gu, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= MAX_CHARS) return t;
  const cut = t.slice(0, MAX_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

interface Queued {
  who: Speaker;
  text: string;
  kind: Kind;
  at: number;
}

export interface SpeechOptions {
  /** The reader's own language, for a world whose language has no voice here. */
  fallback?: string;
  /** Someone started or stopped speaking (the music and ambience duck under it). */
  onSpeaking?: (on: boolean) => void;
  /** Makes an utterance (the browser's SpeechSynthesisUtterance by default). */
  make?: (text: string) => UtteranceLike;
  now?: () => number;
  /** Whether the page may speak yet (browsers refuse before the person has interacted with it). */
  allowed?: () => boolean;
  /** Where the counters live (the page probe), so tests can read them. */
  stats?: SpeechStats;
}

export class Speech {
  readonly #synth: SynthLike | null;
  readonly #make: (text: string) => UtteranceLike;
  readonly #now: () => number;
  readonly #onSpeaking: (on: boolean) => void;
  readonly #fallback: string;
  readonly #allowed: () => boolean;
  readonly stats: SpeechStats;
  #lang = "en";
  #cands: VoiceLike[] = [];
  #current: { line: Queued; u: UtteranceLike; watchdog: ReturnType<typeof setTimeout> } | null = null;
  #next: Queued | null = null;
  readonly #onVoices = () => this.#recast();

  constructor(synth: SynthLike | null, o: SpeechOptions = {}) {
    this.#synth = synth;
    this.#make = o.make ?? ((t) => new SpeechSynthesisUtterance(t) as unknown as UtteranceLike);
    this.#now = o.now ?? (() => Date.now());
    this.#onSpeaking = o.onSpeaking ?? (() => undefined);
    this.#fallback = o.fallback ?? "en";
    this.#allowed = o.allowed ?? (() => true);
    this.stats = o.stats ?? { state: "on", muted: false, speaking: false, spoken: 0, dropped: 0, voices: 0, lang: "en", lines: [] };
    this.stats.state = synth ? "on" : "unsupported";
    // Chrome fills its voice list a moment after load, and says so
    synth?.addEventListener?.("voiceschanged", this.#onVoices);
    this.#recast();
  }

  get speaking(): boolean {
    return this.#current !== null;
  }

  /** The world's language (the intent's `lang`): its voices are the ones cast from. */
  setLang(lang: string | undefined) {
    this.#lang = lang || this.#fallback;
    this.#recast();
  }

  setMuted(m: boolean) {
    this.stats.muted = m;
    if (m) this.hush();
  }

  /** Say a line now, after the current one, or not at all (see the rules at the top). */
  say(who: Speaker, text: string, kind: Kind): boolean {
    const line: Queued = { who, text: speakable(text), kind, at: this.#now() };
    if (!this.#synth || this.stats.muted || !line.text || !this.#allowed()) return this.#drop();
    const cur = this.#current?.line;
    if (!cur) return this.#start(line);
    if (kind !== "bark" && RANK[kind] >= RANK[cur.kind]) {
      // the newest important line wins: the one speaking stops mid-word, anything waiting goes
      if (this.#next) this.#drop();
      this.#next = null;
      this.#stop();
      return this.#start(line);
    }
    // it waits in the one slot, unless something more important is waiting there already
    if (this.#next && RANK[this.#next.kind] > RANK[kind]) return this.#drop();
    if (this.#next) this.#drop();
    this.#next = line;
    return true;
  }

  /** Stop talking and forget what was waiting (mute, a new world, the person speaking). */
  hush() {
    if (this.#next) this.#drop();
    this.#next = null;
    if (this.#current) this.#stop();
    this.#idle();
  }

  dispose() {
    this.hush();
    this.#synth?.removeEventListener?.("voiceschanged", this.#onVoices);
  }

  #recast() {
    this.#cands = this.#synth ? voicesFor(this.#synth.getVoices(), this.#lang, this.#fallback) : [];
    this.stats.voices = this.#cands.length;
    this.stats.lang = this.#lang;
  }

  #start(line: Queued): boolean {
    const synth = this.#synth!;
    if (!this.#cands.length) this.#recast();
    const voice = pickVoice(this.#cands, line.who);
    const { pitch, rate } = tone(line.who);
    const u = this.#make(line.text);
    u.voice = voice;
    // the voice's own locale when there is one (an English voice reading a Czech world says it in English)
    u.lang = voice?.lang ?? this.#lang;
    u.pitch = pitch;
    u.rate = rate;
    u.volume = 1;
    u.onend = () => this.#ended(u);
    u.onerror = () => this.#ended(u);
    // some engines never say they've finished: give up on a line well after it should be over
    const watchdog = setTimeout(() => this.#ended(u), 2500 + (line.text.length * 95) / rate);
    this.#current = { line, u, watchdog };
    const spoken: Spoken = { who: line.who.id, text: line.text, kind: line.kind, voice: voice?.name ?? "", lang: u.lang, pitch, rate };
    this.stats.spoken++;
    this.stats.last = spoken;
    this.stats.lines = [...this.stats.lines, spoken].slice(-12);
    this.stats.speaking = true;
    this.#onSpeaking(true);
    try {
      synth.speak(u);
    } catch {
      this.#ended(u);
    }
    return true;
  }

  /** Cut the current line off (its end event, if one comes, is ignored). */
  #stop() {
    const c = this.#current;
    if (!c) return;
    clearTimeout(c.watchdog);
    this.#current = null;
    try {
      this.#synth?.cancel();
    } catch {
      // nothing was speaking
    }
  }

  #ended(u: UtteranceLike) {
    const c = this.#current;
    if (!c || c.u !== u) return; // a line already cut off
    clearTimeout(c.watchdog);
    this.#current = null;
    const next = this.#next;
    this.#next = null;
    if (next && this.#now() - next.at <= STALE_MS[next.kind]) return void this.#start(next);
    if (next) this.#drop();
    this.#idle();
  }

  #idle() {
    if (!this.stats.speaking) return;
    this.stats.speaking = false;
    this.#onSpeaking(false);
  }

  #drop(): false {
    this.stats.dropped++;
    return false;
  }
}
