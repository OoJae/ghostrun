// Which look a world gets, from what the AI already wrote about it: the fill's look word counts
// most, then the intent's setting sentence, then the names it gave its zones and things. The
// weather word and the time of day colour the choice in; the pack decides only when the words say
// nothing. Pure and three-free, so it is tested over every recorded prompt (test/looks.test.ts).
import type { WorldBundle } from "@ghostrun/ir";

export type LookId = "neon" | "grove" | "gallery" | "desert" | "snow" | "space" | "haunted" | "medieval" | "candy" | "jungle" | "home";

/** What the AI wrote about how a world looks, gathered from everywhere it says it. */
export interface Cue {
  /** The meta line's look words. */
  look: string;
  /** The intent's setting sentence ('' when there is none, as for a recorded fixture). */
  setting: string;
  /** Zone names, entity nouns, dress and poster prompts, joined. */
  names: string;
  /** The weather as written: the meta line may say "sandstorm" or "overcast". */
  weather: string;
  timeOfDay: number;
  /** Valence, arousal, tension in [-1, 1]. */
  mood: readonly [number, number, number];
  pack: string;
  /** What the person chose on the Intent card: it wins over every word. */
  pin?: LookPin;
}

/** A look, a time of day and a weather the person picked (the meta line's "pin"); cosmetic only. */
export interface LookPin {
  /** A look id, or "id/variant" ("snow/cave"). */
  look?: string;
  phase?: Pick["phase"];
  weather?: WorldBundle["cosmetic"]["weather"];
}

export interface Pick {
  id: LookId;
  /** A sub-style: beach (desert), moon (space), magic (medieval), cave (snow), japanese / library (home, haunted), underwater (desert outside, gallery inside). */
  variant: string;
  phase: "day" | "dusk" | "night";
  rain: boolean;
  storm: boolean;
  snow: boolean;
  fog: boolean;
  dust: boolean;
  /** A grey sky: the sun behind cloud. */
  overcast: boolean;
  /** Walls are cut away and the weather stays outside them (the floor-plan pack). */
  indoor: boolean;
}

type Words = readonly (readonly [RegExp, number])[];

// 3: a word that restyles whatever it names ("haunted carnival"); 2: the word names the place;
// 1: it leans that way. Matched on lowercased text with accents stripped, so "Eishöhle" reads
// "eishohle" and "strašidelný" reads "strasidelny".
const WORDS: Record<LookId, Words> = {
  neon: [
    [/\bneon|cyber|synth ?wave|vaporwave|\bnoir\b|night ?club|\bclub\b|\brave\b|\bdisco|night market|food stall|street food/, 2],
    [/\bcity\b|street|urban|downtown|metropol|skyline|rooftop|tokyo|alley|casino|\barcade|dance ?floor|retro/, 1],
  ],
  grove: [
    [/forest|\bgrove|woodland|\bwoods\b|meadow|\bglade|biolumin|hedge|\bgarden|orchard|countryside|picnic|beanstalk|floating island|sky island|treehouse|\bgolf/, 2],
    [/\bpark\b|nature|\bfield\b|\bfarm|valley|mountain|\bhills?\b|lake|river|pond|trail|\bcamp|mushroom|fairy|cloud|tennis|archery|soccer|football|stadium|\bpitch\b|\btrack\b|relay|sumo|outdoor|\bcaves?\b|cavern|grotto/, 1],
  ],
  gallery: [
    [/museum|galler|showroom|minimalis|\bmodern\b|luxury|boutique|\boffice|\bbank\b|\bvault\b|hotel|lobby|\bvillas?\b|classroom/, 2],
    [/\bclean\b|\bmall\b|\bstore\b|\bshop\b|hospital|airport|train|railway|subway|\bmetro\b|\bstation\b|escape room|bowling|basketball|dodgeball|volleyball|badminton|\bgym\b|indoor|\bstudio|theat|heist|laser grid|\bschool/, 1],
  ],
  desert: [
    [/desert|\bsand|\bdunes?\b|canyon|\bmesa|cact|oasis|sahara|egypt|pyramid|pharaoh|wild west|western|cowboy|saloon|badlands|savann?ah?|safari|wasteland|\barid\b|\bbeach(es)?\b|seashell|sea ?shell|\bshore|tropical island|\bpalms?\b|lagoon|castaway|pirate|volcan|magma/, 2],
    [/\bdust|\btomb|scorpion|camel|\bcoast|desert island|treasure island|\bsurf|\bocean|\btide\b|\bsea\b|treasure/, 1],
  ],
  snow: [
    [/\bsnow|\bicy\b|\bice\b(?! ?cream)|frozen|winter|arctic|antarctic|\bpolar|glacier|igloo|penguin|\bski\b|skiing|\bsled|blizzard|\bfrost|tundra|\byeti|north pole|skating|hockey|\beis|schnee|\bsnih|\bled\b/, 2],
    [/christmas|\bcold\b|\bpines?\b/, 1],
  ],
  space: [
    [/\bspace|starship|spaceship|orbital|galax|\bplanet|\bmoon ?base|\blunar|\bmars\b|martian|asteroid|\balien|\bufo\b|sci-?fi|astronaut|zero-?g|zero gravity|low gravity|\brobot|\bcyborg|\bandroid|\bmech\b/, 2],
    [/futuristic|\brocket|airlock|reactor|laborator|hangar|cockpit|derelict|\bcrater|\bdrone|starfield|\bstars?\b|breaker|circuit|server|power core/, 1],
  ],
  haunted: [
    [/haunt|\bghost|spook|creepy|horror|zombie|undead|vampire|graveyard|cemetery|\bcrypt|gothic|halloween|cursed|nightmare|asylum|\beerie|werewolf|pumpkin|\bduch|strasid|\bgeist|\bspuk/, 3],
    [/\bdark\b|abandoned|\bskelet|\bbones?\b|candle|cobweb|pavucin|\bbats?\b|\bwitch|\bmonster|shadow|\bdecay|ruined|flicker/, 1],
  ],
  medieval: [
    [/medieval|\bcastle|chateau|knights?\b|\bsiege|fortress|kingdom|dungeon|\bthrone|\bdragon|wizard|sorcer|\bpotion|alchem|\bspells?\b|viking|battlement|catapult|\bhrad|\bburg\b|schloss|ritter|\bgoblin|\borcs?\b|\belves|\belf\b|dwarf/, 2],
    [/\bvillage|tavern|\bsword|\barmou?r|\bbanner|\btorch|lighthouse|monastery|\bstone wall|drawbridge|\bmoat|\bguards?\b|\barchers?\b|cauldron|\bstraz|\bmagic|enchant|fantasy/, 1],
  ],
  candy: [
    [/\bcandy|\bcandies|\bsweets?\b|\bsugar|chocolate|lollipop|gumdrop|\bcake|cupcake|dessert|ice ?cream|\btoys?\b|\btoon|cartoon|\bcircus|carnival|funfair|\bclowns?\b|birthday|\bparty|bouncy|playground|rainbow|unicorn|pastel|kawaii|big top|trampoline|domino/, 2],
    [/\bfair\b|balloon|marshmallow|cookie|gingerbread|jelly|\bgame show/, 1],
  ],
  jungle: [
    [/jungle|rainforest|tropical(?! island)|\bvines?\b|swamp|bayou|\bmarsh|amazon|aztec|\bmaya|\binca\b|lost city|overgrown/, 2],
    [/\btemple|\bruins?\b|ancient|\bmoss|explorer|\bidol\b|rotting|\bfern|crumbl|dinosaur|\bparrot|\bmonkey/, 1],
  ],
  home: [
    [/\bhome\b|\bhouse\b|cottage|\bcabin|\bcozy|\bcosy|kitchen|bedroom|living room|apartment|\bcafe|coffee|tea ?house|bakery|restaurant|\bdiner\b|\binn\b|library|bookshop|bookstore|\bdojo|ryokan|dollhouse|fireplace|\battic/, 2],
    [/\bsofa|\bcouch|\bbooks?\b|bookcase|bookshel|\brug\b|\btea\b|japanese|tatami|shoji|\bzen\b|\bstudy\b|\bnook|\bshop\b|latte|barista/, 1],
  ],
};

// Ties go to the more specific look (the order a person would name them in).
const ORDER: readonly LookId[] = ["haunted", "candy", "space", "snow", "desert", "medieval", "jungle", "home", "neon", "gallery", "grove"];

/** Under the sea, whatever else it is: a sandy seabed outside, an aquarium's blue inside. */
const UNDERWATER = /underwater|aquarium|\breef\b|submarine|deep sea|ocean floor|seabed|shipwreck|\bcoral|sunken|atlantis|mermaid/;

const VARIANTS: Partial<Record<LookId, readonly (readonly [RegExp, string])[]>> = {
  desert: [[/\bbeach(es)?\b|seashell|sea ?shell|\bshore|\bcoast|tropical|\bpalms?\b|lagoon|\bisland|\bsurf|pirate|\bocean|\bsea\b|\btide|castaway/, "beach"]],
  space: [[/\bmoon\b|moon ?base|\blunar|\bcrater|\bmars\b|martian|asteroid|planet surface|regolith/, "moon"]],
  medieval: [[/wizard|\bmagic|sorcer|\bpotion|alchem|\bspells?\b|enchant|\bwitch|arcane|warlock|\bmage\b/, "magic"]],
  snow: [[/\bcaves?\b|cavern|hohle|grotto|crystal|kristall|ice palace/, "cave"]],
  home: [
    [/japan|tea ?house|\bdojo|ninja|samurai|shoji|tatami|\bzen\b|pagoda|ryokan|sakura|kimono/, "japanese"],
    [/librar|bookshop|bookstore|bookcase|bookshel|archive/, "library"],
  ],
  haunted: [[/librar|bookcase|bookshel|archive/, "library"]],
};

/** Outdoor packs default to the grove, floor plans to the gallery, the rest to the neon city. */
const PACK_LOOK: Record<string, LookId> = { outdoor: "grove", floor_plan: "gallery" };
/** Packs with rooms: the only ones a home's furniture fits in. */
const ROOMS = new Set(["floor_plan", "maze"]);

export const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

const score = (text: string, words: Words) => words.reduce((s, [re, w]) => s + (re.test(text) ? w : 0), 0);

/** The look and how it is lit and what falls from its sky. */
export function pickLook(c: Cue): Pick {
  const look = norm(c.look === "default" ? "" : c.look);
  const setting = norm(c.setting);
  const names = norm(c.names);
  const all = `${look} | ${setting} | ${names}`;
  const words = `${look} | ${setting}`;
  const [valence, , tension] = c.mood;

  let id: LookId = PACK_LOOK[c.pack] ?? "neon";
  let best = 0;
  for (const k of ORDER) {
    if (k === "home" && !ROOMS.has(c.pack)) continue;
    // the look words weigh three times a name, the setting twice
    let s = score(look, WORDS[k]) * 3 + score(setting, WORDS[k]) * 2 + score(names, WORDS[k]);
    // the mood only breaks a near tie: dread leans haunted, carefree joy leans candy
    if (s > 0 && k === "haunted" && valence < -0.3 && tension > 0.6) s += 0.5;
    if (s > 0 && k === "candy" && valence > 0.6 && tension < 0.3) s += 0.5;
    if (s > best) ((best = s), (id = k));
  }
  if (best < 2) id = PACK_LOOK[c.pack] ?? "neon"; // one passing name is not enough to restyle a world
  // "haunted" restyles whatever it names: a haunted carnival is a haunted place first
  if (WORDS.haunted[0]![0].test(words)) id = "haunted";

  let variant = VARIANTS[id]?.find(([re]) => re.test(all))?.[1] ?? "";
  if (UNDERWATER.test(words)) ((id = c.pack === "floor_plan" ? "gallery" : "desert"), (variant = "underwater"));
  const pinned = pinnedLook(c);
  if (pinned) [id, variant] = pinned;

  const w = norm(c.weather);
  const dust = /sand ?storm|dust ?storm|\bdust/.test(w) || /sand ?storm|dust ?storm/.test(words);
  const snow = /snow|blizzard|flurr|sleet/.test(w) || /snowing|snowfall|blizzard|snow ?storm/.test(words);
  const storm = !dust && !snow && (/storm|thunder|lightning|hurricane|typhoon|tempest/.test(w) || /stormy|thunder ?storm|lightning storm/.test(words));
  const rain = storm || /rain|drizzle|shower|monsoon|wet/.test(w) || /\brain\b|rainy|rain-soaked|downpour|drizzl/.test(words);
  const fog = /fog|mist|haze|smog/.test(w) || /\bfog|foggy|misty|\bmist\b/.test(words);
  const overcast = /overcast|cloudy|grey|gray|gloom/.test(w) || /overcast|cloudy sky|grey sky|gloomy/.test(words);

  const h = c.timeOfDay;
  let phase: Pick["phase"] = h >= 19.5 || h < 5.5 ? "night" : h >= 17 || h < 7 ? "dusk" : "day";
  // a glowing look word means the dark it glows in (the setting's "glowing islands" may be noon)
  if (/\bnight|midnight|moonlit|moonlight|nocturnal|starry|after dark/.test(words) || /biolumin|\bglow/.test(look)) phase = "night";
  else if (/sunset|\bdusk|twilight|\bdawn|sunrise|evening|golden hour/.test(words)) phase = "dusk";
  if (id === "neon" && phase === "day") phase = "night"; // the city is a night look; at dusk it gets a sunset
  if (id === "haunted" && phase === "day") phase = "night"; // haunted means moonlight
  if (/\bcaves?\b|cavern|grotto|hohle|underground/.test(words) && id !== "space") phase = "night"; // under rock: no sun
  if (c.pin?.phase) phase = c.pin.phase;

  const under = variant === "underwater";
  const pick: Pick = { id, variant, phase, rain: rain && !snow && !dust && !under, storm: storm && !under, snow, fog, dust, overcast: overcast || storm, indoor: c.pack === "floor_plan" };
  // a weather the person picked is the whole sky: none of the words' rain under a clear one
  const pw = c.pin?.weather;
  if (pw) Object.assign(pick, { rain: !under && (pw === "rain" || pw === "storm"), storm: !under && pw === "storm", snow: pw === "snow", fog: pw === "fog", dust: false, overcast: pw === "storm" });
  return pick;
}

/** Every look and sub-style a person can pick on the Intent card, as "id" or "id/variant", with its name. */
export const LOOK_CHOICES: readonly { value: string; label: string; rooms?: true }[] = [
  { value: "neon", label: "Neon city" }, { value: "grove", label: "Grove" }, { value: "gallery", label: "Gallery" }, { value: "gallery/underwater", label: "Aquarium" },
  { value: "desert", label: "Desert" }, { value: "desert/beach", label: "Beach" }, { value: "desert/underwater", label: "Seabed" },
  { value: "snow", label: "Snow" }, { value: "snow/cave", label: "Ice cave" }, { value: "space", label: "Space station" }, { value: "space/moon", label: "Moon" },
  { value: "haunted", label: "Haunted" }, { value: "haunted/library", label: "Haunted library" }, { value: "medieval", label: "Medieval" }, { value: "medieval/magic", label: "Wizard school" },
  { value: "candy", label: "Candy" }, { value: "jungle", label: "Jungle" },
  { value: "home", label: "Home", rooms: true }, { value: "home/japanese", label: "Tea house", rooms: true }, { value: "home/library", label: "Library", rooms: true },
];

/** The pinned look, if it is one this pack can wear (a home's furniture needs rooms). */
function pinnedLook(c: Cue): [LookId, string] | null {
  const choice = c.pin?.look ? LOOK_CHOICES.find((x) => x.value === c.pin!.look) : undefined;
  if (!choice || (choice.rooms && !ROOMS.has(c.pack))) return null;
  const [id, variant = ""] = choice.value.split("/") as [LookId, string?];
  return [id, variant];
}

/** The cue a bundle carries by itself (the fill's raw meta line and the intent add to it). */
export function cueOf(b: WorldBundle, extra: { setting?: string; meta?: RawMeta | null } = {}): Cue {
  const m = extra.meta;
  const c = b.cosmetic;
  const names = [
    ...b.zones.map((z) => z.name),
    ...b.entities.map((e) => e.noun),
    ...c.dress.map((d) => d.noun),
    ...c.posters.map((p) => p.prompt),
  ].filter(Boolean);
  return {
    look: m?.look ?? c.look,
    setting: extra.setting ?? "",
    names: names.join(" | "),
    weather: m?.weather ?? c.weather,
    timeOfDay: m?.timeOfDay ?? c.timeOfDay,
    mood: m?.mood ?? c.mood,
    pack: b.pack.id,
    ...(m?.pin ? { pin: m.pin } : {}),
  };
}

/** The meta line's cosmetic words as written, before the parser's checks. */
export interface RawMeta {
  look?: string;
  weather?: string;
  timeOfDay?: number;
  mood?: [number, number, number];
  setting?: string;
  pin?: LookPin;
}

const PHASES: readonly string[] = ["day", "dusk", "night"];
const WEATHERS: readonly string[] = ["clear", "rain", "snow", "fog", "storm"];

/** The card's pin as written: only the fields it can hold, each one of its words. */
function readPin(x: unknown): LookPin | null {
  if (!x || typeof x !== "object") return null;
  const p = x as Record<string, unknown>;
  const out: LookPin = {};
  if (typeof p.look === "string" && LOOK_CHOICES.some((c) => c.value === p.look)) out.look = p.look;
  if (typeof p.phase === "string" && PHASES.includes(p.phase)) out.phase = p.phase as LookPin["phase"] & string;
  if (typeof p.weather === "string" && WEATHERS.includes(p.weather)) out.weather = p.weather as LookPin["weather"] & string;
  return Object.keys(out).length ? out : null;
}

/** Read the fill's meta line as written (null when there is none or it isn't JSON). */
export function rawMeta(fill: string): RawMeta | null {
  const first = fill.split("\n", 1)[0] ?? "";
  try {
    const m = JSON.parse(first) as Record<string, unknown>;
    if (m.op !== "meta") return null;
    const out: RawMeta = {};
    if (typeof m.look === "string") out.look = m.look;
    if (typeof m.weather === "string") out.weather = m.weather;
    if (typeof m.timeOfDay === "number" && Number.isFinite(m.timeOfDay)) out.timeOfDay = m.timeOfDay;
    if (Array.isArray(m.mood) && m.mood.length === 3 && m.mood.every((x) => typeof x === "number" && Number.isFinite(x))) out.mood = m.mood as [number, number, number];
    if (typeof m.setting === "string") out.setting = m.setting;
    const pin = readPin(m.pin);
    if (pin) out.pin = pin;
    return out;
  } catch {
    return null;
  }
}

/** A weather word the parser doesn't know, as the nearest one it does (for the cosmetic layer). */
export function weatherWord(w: string): WorldBundle["cosmetic"]["weather"] {
  const x = norm(w);
  if (/snow|blizzard|flurr|sleet/.test(x)) return "snow";
  if (/sand|dust/.test(x)) return "fog";
  if (/storm|thunder|lightning|hurricane|typhoon/.test(x)) return "storm";
  if (/rain|drizzle|shower|monsoon/.test(x)) return "rain";
  if (/fog|mist|haze|smog/.test(x)) return "fog";
  return "clear";
}

/** A look word per look (and sub-style) that draws its own materials, for the shader prewarm. */
// One per look and the commonest sub-styles: every warm sample stays in memory, so not all of them.
const SAMPLES: readonly (readonly [string, string])[] = [
  ["sandstone desert canyon", "outdoor"], ["sunny beach", "outdoor"], ["snowy mountain", "outdoor"], ["space station", "floor_plan"],
  ["haunted mansion", "floor_plan"], ["medieval castle", "arena"], ["wizard school", "floor_plan"], ["candy land", "outdoor"],
  ["jungle temple", "outdoor"], ["cozy cottage", "floor_plan"],
];

/** Copies of sample worlds wearing every newer look, so the background prewarm compiles their shaders too. */
export function lookSamples(bundles: readonly WorldBundle[]): WorldBundle[] {
  const out: WorldBundle[] = [];
  for (const [look, pack] of SAMPLES) {
    const b = bundles.find((x) => x.pack.id === pack) ?? bundles[0];
    if (b) out.push({ ...b, cosmetic: { ...b.cosmetic, look, timeOfDay: 12, weather: "clear" } });
  }
  return out;
}
