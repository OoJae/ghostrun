import { afterEach, describe, expect, it, vi } from "vitest";
import { firstSentences, recap } from "../src/audio/lines";
import { pickVoice, speakable, Speech, tone, voicesFor, type SynthLike, type UtteranceLike, type VoiceLike } from "../src/audio/speech";
import { story } from "../src/host";
import { buildWorld } from "../src/pipeline";

const voice = (name: string, lang: string, o: Partial<VoiceLike> = {}): VoiceLike => ({ name, lang, voiceURI: `${name}-${lang}`, localService: true, default: false, ...o });
const VOICES = [voice("Samantha", "en-US", { default: true }), voice("Daniel", "en-GB"), voice("Karen", "en-AU"), voice("Moira", "en-IE"), voice("Zuzana", "cs-CZ"), voice("Anna", "de-DE"), voice("Bells", "en-US"), voice("Google US English", "en-US", { localService: false })];

/** The browser's speechSynthesis, faked: it records what it was asked to say and ends lines on cue. */
function fakeSynth(voices: VoiceLike[] = VOICES) {
  const said: UtteranceLike[] = [];
  let speaking: UtteranceLike | null = null;
  const listeners: (() => void)[] = [];
  const synth: SynthLike & { said: UtteranceLike[]; cancels: number; end(): void; current(): UtteranceLike | null; voices: VoiceLike[]; announce(): void } = {
    said,
    cancels: 0,
    voices,
    speak(u) {
      said.push(u);
      speaking = u;
      u.onstart?.();
    },
    cancel() {
      this.cancels++;
      const u = speaking;
      speaking = null;
      u?.onerror?.({ error: "interrupted" }); // as Chrome does, for the line it cut off
    },
    getVoices() {
      return this.voices;
    },
    addEventListener(_t, fn) {
      listeners.push(fn);
    },
    end() {
      const u = speaking;
      speaking = null;
      u?.onend?.();
    },
    current: () => speaking,
    announce() {
      for (const f of listeners) f();
    },
  };
  return synth;
}

const make = (text: string): UtteranceLike => ({ text, lang: "", voice: null, pitch: 1, rate: 1, volume: 1, onstart: null, onend: null, onerror: null });
const guard = { id: "guard_1", role: "guard", persona: "A gruff old night watchman." };
const rival = { id: "rival_1", role: "rival", persona: "A cocky young runner." };
const host = { id: "host", role: "host" };

function setup(voices?: VoiceLike[]) {
  let now = 0;
  const synth = fakeSynth(voices);
  const ducks: boolean[] = [];
  const speech = new Speech(synth, { make, now: () => now, onSpeaking: (on) => ducks.push(on) });
  return { synth, speech, ducks, tick: (ms: number) => (now += ms), texts: () => synth.said.map((u) => u.text) };
}

afterEach(() => vi.useRealTimers());

describe("voice selection", () => {
  it("casts from the world's language, then the reader's, then English, and never a novelty voice", () => {
    expect(voicesFor(VOICES, "cs").map((v) => v.name)).toEqual(["Zuzana"]);
    expect(voicesFor(VOICES, "de-AT").map((v) => v.name)).toEqual(["Anna"]);
    expect(voicesFor(VOICES, "ja", "de").map((v) => v.name)).toEqual(["Anna"]); // no Japanese voice: the reader's language
    const en = voicesFor(VOICES, "ja", "fr").map((v) => v.name);
    expect(en).toContain("Samantha");
    expect(en).not.toContain("Bells");
    expect(voicesFor([voice("Kyoko", "ja-JP")], "cs").map((v) => v.name)).toEqual(["Kyoko"]); // anything rather than nothing
    expect(voicesFor([], "en")).toEqual([]);
    // stable whatever order the browser lists them in
    expect(voicesFor([...VOICES].reverse(), "en")).toEqual(voicesFor(VOICES, "en"));
  });

  it("the Host takes the default voice; each character keeps its own, preferring on-device voices", () => {
    const en = voicesFor(VOICES, "en");
    expect(pickVoice(en, host)?.name).toBe("Samantha");
    const a = pickVoice(en, guard);
    expect(pickVoice([...en].reverse().sort((x, y) => (x.voiceURI < y.voiceURI ? -1 : 1)), guard)).toBe(a); // same voice every time
    expect(a?.name).not.toBe("Samantha"); // not the Host's
    expect(a?.localService).toBe(true);
    const cast = ["guard_1", "guard_2", "rival_1", "rival_2", "guide", "merchant"].map((id) => pickVoice(en, { id, role: "citizen" })?.name);
    expect(new Set(cast).size).toBeGreaterThan(1); // spread over the voices there are
    expect(pickVoice([voice("Solo", "en-US")], guard)?.name).toBe("Solo"); // one voice: everyone shares it
    expect(pickVoice([], guard)).toBeNull();
  });

  it("pitch and rate follow the role and the persona, and two of a kind still differ", () => {
    const g = tone({ id: "g", role: "guard" });
    const m = tone({ id: "g", role: "merchant" });
    expect(g.pitch).toBeLessThan(m.pitch);
    expect(tone({ id: "c", role: "creature" }).pitch).toBeLessThan(0.8);
    expect(tone({ id: "x", role: "citizen", persona: "an ancient, weary keeper" }).pitch).toBeLessThan(tone({ id: "x", role: "citizen", persona: "a cheerful young kid" }).pitch);
    expect(tone(host)).toEqual({ pitch: 1, rate: 1.02 });
    const two = [tone({ id: "guard_1", role: "guard" }), tone({ id: "guard_2", role: "guard" })];
    expect(two[0]).not.toEqual(two[1]);
    for (const t of [tone({ id: "z", role: "creature", persona: "an old robot giant monster" }), tone({ id: "z", role: "merchant", persona: "young cheerful excited kid" })]) {
      expect(t.pitch).toBeGreaterThanOrEqual(0.3);
      expect(t.pitch).toBeLessThanOrEqual(1.8);
      expect(t.rate).toBeGreaterThanOrEqual(0.7);
      expect(t.rate).toBeLessThanOrEqual(1.4);
    }
    expect(tone({ id: "q", role: "something new" })).toEqual(tone({ id: "q", role: "citizen" }));
  });
});

describe("speaking one line at a time", () => {
  it("speaks a line with its character's voice, pitch and rate, and ducks the music while it does", () => {
    const { synth, speech, ducks } = setup();
    expect(speech.say(guard, "Halt! Who goes there?", "bark")).toBe(true);
    const u = synth.said[0]!;
    expect(u.text).toBe("Halt! Who goes there?");
    expect(u.voice).toBe(pickVoice(voicesFor(VOICES, "en"), guard));
    expect(u.lang).toBe(u.voice!.lang);
    expect({ pitch: u.pitch, rate: u.rate }).toEqual(tone(guard));
    expect(speech.stats.last).toMatchObject({ who: "guard_1", kind: "bark", voice: u.voice!.name });
    expect(ducks).toEqual([true]);
    synth.end();
    expect(ducks).toEqual([true, false]);
    expect(speech.speaking).toBe(false);
  });

  it("a bark waits for the voice; a newer bark takes its place, and a stale one is dropped", () => {
    const { synth, speech, tick, texts } = setup();
    speech.say(guard, "One.", "bark");
    speech.say(rival, "Two.", "bark");
    speech.say(rival, "Three.", "bark"); // replaces Two
    expect(texts()).toEqual(["One."]);
    synth.end();
    expect(texts()).toEqual(["One.", "Three."]);
    speech.say(guard, "Four.", "bark");
    tick(4500); // Three runs long: Four's moment has passed
    synth.end();
    expect(texts()).toEqual(["One.", "Three."]);
    expect(speech.speaking).toBe(false);
    expect(speech.stats).toMatchObject({ spoken: 2, dropped: 2 });
  });

  it("a reply cuts in over a bark, and the Host over both; the cut-off line's late end changes nothing", () => {
    const { synth, speech, texts } = setup();
    speech.say(guard, "Patrolling.", "bark");
    const bark = synth.current()!;
    speech.say(guard, "You again? Move along.", "reply");
    expect(synth.cancels).toBe(1);
    expect(texts()).toEqual(["Patrolling.", "You again? Move along."]);
    bark.onend?.(); // a late end for the line that was cut off
    expect(speech.speaking).toBe(true);
    speech.say(host, "You lost because time ran out.", "host");
    expect(texts().at(-1)).toBe("You lost because time ran out.");
    // a bark during the Host waits, and a newer Host line still wins
    speech.say(rival, "Ha!", "bark");
    speech.say(host, "The rival scored three times.", "host");
    expect(texts().at(-1)).toBe("The rival scored three times.");
    synth.end();
    expect(texts()).toHaveLength(4); // the bark waiting behind the first Host line went with it
  });

  it("a reply waiting behind the Host is said after it, a bark can't push it out", () => {
    const { synth, speech, texts } = setup();
    speech.say(host, "You won in 41 seconds.", "host");
    speech.say(guard, "Well run.", "reply");
    speech.say(rival, "Lucky.", "bark");
    synth.end();
    expect(texts()).toEqual(["You won in 41 seconds.", "Well run."]);
  });

  it("muted, nothing is said; muting mid-line stops it and forgets what was waiting", () => {
    const { synth, speech, ducks, texts } = setup();
    speech.say(guard, "First.", "bark");
    speech.say(guard, "Second.", "bark");
    speech.setMuted(true);
    expect(synth.cancels).toBe(1);
    expect(ducks).toEqual([true, false]);
    expect(speech.say(host, "You lost.", "host")).toBe(false);
    synth.end();
    expect(texts()).toEqual(["First."]);
    speech.setMuted(false);
    speech.say(host, "You lost.", "host");
    expect(texts()).toEqual(["First.", "You lost."]);
  });

  it("uses voices that arrive late, and the world's language when it changes", () => {
    const { synth, speech } = setup([]);
    speech.say(guard, "No voices yet.", "bark");
    expect(synth.said[0]!.voice).toBeNull();
    expect(synth.said[0]!.lang).toBe("en");
    synth.end();
    synth.voices = VOICES;
    synth.announce();
    speech.setLang("cs");
    speech.say(guard, "Stůj!", "bark");
    expect(synth.said[1]!.voice?.name).toBe("Zuzana");
    expect(speech.stats.lang).toBe("cs");
  });

  it("an engine that never says it finished doesn't keep the next line waiting forever", () => {
    vi.useFakeTimers();
    const { synth, speech, texts } = setup();
    speech.say(guard, "Hello there.", "bark");
    speech.say(rival, "Hi.", "reply");
    speech.say(guard, "Later.", "bark");
    expect(texts()).toEqual(["Hello there.", "Hi."]);
    vi.advanceTimersByTime(10_000); // no end event ever comes
    expect(texts()).toEqual(["Hello there.", "Hi.", "Later."]);
    synth.end();
    expect(speech.speaking).toBe(false);
  });

  it("without speechSynthesis every line is dropped quietly (the subtitles still show)", () => {
    const speech = new Speech(null, { make });
    expect(speech.stats.state).toBe("unsupported");
    expect(speech.say(guard, "Hello.", "bark")).toBe(false);
    expect(speech.stats.dropped).toBe(1);
  });
});

describe("what is said", () => {
  it("leaves out stage directions, scores in brackets, links and emoji, and keeps it short", () => {
    expect(speakable("*grins* Mine now! (blue 1–3) 😀 see https://x.y/z")).toBe("Mine now! see");
    expect(speakable("▶ 0:41 Rival 1 hit you [laughs].")).toBe("0:41 Rival 1 hit you.");
    const long = `${"The orb went home again. ".repeat(12)}`;
    const s = speakable(long);
    expect(s.length).toBeLessThanOrEqual(220);
    expect(s.endsWith(".")).toBe(true);
    expect(speakable("  ")).toBe("");
  });

  it("the Host's recap says why the run ended and the moment that mattered", () => {
    const b = buildWorld("", "ctf").bundle;
    const lose = b.rules.find((r) => r.then.some((e) => e.e === "lose") && r.when.t === "score_gte")!;
    const tick = 3000;
    const log = [
      { k: "pickup", a: "orb", b: "rival_1", tick: 2900, cause: -1 },
      { k: "enter", a: "orb", b: "goal_blue", tick: 3000, cause: -1 },
      { k: "score", a: "team:blue", v: 3, tick: 3000, cause: 1 },
      { k: "lose", a: "player", tick: 3000, rule: lose.id, cause: 2 },
    ] as never;
    const said = recap({ k: "lose", tick, rule: lose.id, story: story(b, log) }, b);
    expect(said).toMatch(/^You lost because the blue team reached 3\. /);
    expect(said).not.toContain("(");
    expect(recap({ k: "lose", tick, rule: "no_such_rule" }, b)).toBe("You lost.");
    const win = b.rules.find((r) => r.then.some((e) => e.e === "win"))!;
    expect(recap({ k: "win", tick: 2481, rule: win.id }, b)).toMatch(/^You won in 41\.4 seconds: the red team reached \d+\.$/);
  });

  it("an answer's first sentence or two", () => {
    expect(firstSentences("Rival 1 ran the orb home three times. You stood still at the spawn. Try the rooftop.")).toBe("Rival 1 ran the orb home three times. You stood still at the spawn.");
    expect(firstSentences("Just one sentence")).toBe("Just one sentence");
    expect(firstSentences("Čas vypršel. Zkus to znovu. Hodně štěstí.", 1)).toBe("Čas vypršel.");
    expect(firstSentences("It was at 0:41. Then 1.5 m short.", 1)).toBe("It was at 0:41.");
  });
});
