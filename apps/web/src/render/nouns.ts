// What a world's nouns look like: a CC0 prop for a thing ("rusty key" → key) and a body for a
// character ("shambling zombie" → skeleton). Pure lookups over the noun the fill wrote: they never
// see the simulation, and null keeps the primitive the renderer already draws (the glowing orb, the
// neon door, the capsule a robot is drawn as).
import type { EntityKind } from "@ghostrun/ir";

/** Props with a model in public/models/props (tools/models/build.mjs), plus the gem drawn in code. */
export const PROP_IDS = [
  "key", "coin", "coins", "chest", "crate", "barrel", "sack", "banner", "flag", "trophy", "potion", "candle",
  "torch", "bookcase", "table", "chair", "lamp", "lantern", "pumpkin", "gravestone", "skull", "gate", "door",
  "target", "tree", "rock", "bush", "sword", "wand", "staff", "crossbow", "shield", "book", "mug", "bomb", "gem",
] as const;
export type PropId = (typeof PROP_IDS)[number];

/** Props that come in team colours (a file per team, the plain one for no team). */
export const TEAM_PROPS: ReadonlySet<PropId> = new Set(["banner", "flag"]);

/** Held things: drawn in the carrier's hand, not over its head. */
export const HELD_PROPS: ReadonlySet<PropId> = new Set(["sword", "wand", "staff", "crossbow", "shield"]);

export type CharacterId = "knight" | "rogue" | "mage" | "barbarian" | "skeleton";

/** Kinds whose look is the game's own language (goals, pads, hazards, portals…): never swapped. */
const PROP_KINDS: ReadonlySet<EntityKind> = new Set(["pickup", "prop", "switch", "door"]);

// Words → prop, head noun first ("treasure chest" is a chest, "key card" no key). English with the
// cheap wins in Czech, German, Spanish and French (the languages the gallery and evals use).
const PROP_WORDS: Record<PropId, readonly string[]> = {
  key: ["key", "keys", "klic", "schlussel", "llave", "cle", "clef", "chiave"],
  coin: ["coin", "token", "doubloon", "mince", "munze", "moneda", "moneta"],
  coins: ["loot", "treasure", "gold", "money", "cash", "poklad", "schatz", "tesoro", "tresor"],
  chest: ["chest", "truhla", "truhe", "cofre", "coffre", "lockbox", "safe"],
  crate: ["crate", "box", "bedna", "kiste", "caja", "caisse", "package", "parcel", "supply", "supplies", "cargo"],
  barrel: ["barrel", "keg", "cask", "sud", "fass", "barril", "tonneau"],
  sack: ["sack", "bag", "handbag", "purse", "backpack", "satchel", "pytel", "tasche", "bolsa", "sac"],
  banner: ["banner", "pennant", "standard", "prapor"],
  flag: ["flag", "vlajka", "fahne", "flagge", "bandera", "drapeau"],
  trophy: ["trophy", "chalice", "goblet", "idol", "artifact", "artefact", "relic", "medal", "crown", "harp", "trofej", "pokal", "trofeo", "trophee"],
  potion: ["potion", "elixir", "flask", "vial", "bottle", "tonic", "lektvar", "trank", "pocion", "fiole"],
  candle: ["candle", "candles", "svicka", "kerze", "vela", "bougie"],
  torch: ["torch", "flare", "pochoden", "fackel", "antorcha", "torche"],
  bookcase: ["bookcase", "bookshelf", "shelf", "shelves", "regal", "estanteria"],
  table: ["table", "desk", "counter", "workbench", "stul", "tisch", "mesa"],
  chair: ["chair", "stool", "seat", "throne", "zidle", "stuhl", "silla", "chaise"],
  lamp: ["lamp", "gaslight", "lampa", "lampe", "lampara", "streetlight", "floodlight"],
  lantern: ["lantern", "lucerna", "laterne", "linterna", "lanterne"],
  pumpkin: ["pumpkin", "jackolantern", "dyne", "kurbis", "calabaza", "citrouille"],
  gravestone: ["gravestone", "tombstone", "grave", "headstone", "hrob", "grabstein", "lapida"],
  skull: ["skull", "lebka", "schadel", "calavera", "crane", "bones", "bone"],
  gate: ["gate", "portcullis", "brana", "tor", "verja", "portail", "grille"],
  door: ["door", "dvere", "tur", "puerta", "porte"],
  target: ["target", "bullseye", "dartboard", "terc", "zielscheibe", "diana", "cible"],
  tree: ["tree", "oak", "pine", "willow", "bonsai", "strom", "baum", "arbol", "arbre"],
  rock: ["rock", "boulder", "stone", "stones", "pebble", "kamen", "stein", "fels", "roca", "piedra", "rocher", "pierre"],
  bush: ["bush", "shrub", "hedge", "plant", "fern", "ker", "busch", "arbusto", "buisson"],
  sword: ["sword", "blade", "sabre", "saber", "katana", "dagger", "knife", "mec", "schwert", "espada", "epee"],
  wand: ["wand", "hulka", "zauberstab", "varita", "baguette"],
  staff: ["staff", "stave", "rod", "scepter", "sceptre", "hul", "stab", "baston", "baton"],
  crossbow: ["crossbow", "bow", "kus", "luk", "armbrust", "bogen", "ballesta", "arco", "arbalete", "arc"],
  shield: ["shield", "stit", "schild", "escudo", "bouclier"],
  book: ["book", "tome", "spellbook", "grimoire", "journal", "diary", "manuscript", "scroll", "kniha", "buch", "libro", "livre"],
  mug: ["mug", "cup", "latte", "coffee", "tea", "teacup", "cocoa", "hrnek", "tasse", "taza"],
  bomb: ["bomb", "grenade", "dynamite", "explosive", "bomba", "bombe"],
  gem: ["gem", "jewel", "crystal", "diamond", "sapphire", "ruby", "emerald", "amethyst", "topaz", "kristall", "krystal", "drahokam", "gema", "joya", "gemme", "cristal", "shard", "seed"],
};

/** Words that mean the thing isn't the prop its head noun suggests (a vault door is no wooden door). */
const NOT_PROP: Partial<Record<PropId, RegExp>> = {
  door: /vault|steel|safe|airlock|blast|hatch|shoji|sliding|laser|energy|force|stone|metal|iron|security|bulkhead|sci|cell door/,
  gate: /laser|energy|force|neon|start|finish|checkpoint|race|slalom|ice/,
  key: /keycard|key card|card|keyboard|code/,
  chest: /chest piece|armou?r|plate/,
  coins: /gold coin|golden coin|gold key|golden key|goldfish/,
  rock: /rock band|rocket/,
  tree: /treehouse|tree house/,
  lamp: /lamp post/,
  crossbow: /bowl|bowling|rainbow|elbow/,
  staff: /staff room|staffer|rodent/,
  table: /timetable|periodic/,
  shield: /shield generator|force shield|energy shield/,
  torch: /flashlight/,
};

/** Lower case, accents off, punctuation to spaces: "Klíč k východu" → "klic k vychodu". */
export function normNoun(noun: string): string {
  return noun
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]s\b/g, "")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A plural's singular, simply ("candies" → "candy", "boxes" → "box", "keys" → "key"). */
export function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

const WORD_PROP = new Map<string, PropId>();
for (const id of PROP_IDS) for (const w of PROP_WORDS[id]) WORD_PROP.set(w, id);

function lookup(words: readonly string[], table: ReadonlyMap<string, string>): string | null {
  // the head noun (last word) first, then the rest right to left: "golden key ring" → key
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]!;
    const hit = table.get(w) ?? table.get(stem(w));
    if (hit) return hit;
  }
  return null;
}

/** The prop a thing is drawn as, or null to keep the renderer's own shape. */
export function propFor(noun: string, kind: EntityKind): PropId | null {
  if (!PROP_KINDS.has(kind)) return null;
  const n = normNoun(noun);
  if (!n) return null;
  const words = n.split(" ");
  let id = lookup(words, WORD_PROP) as PropId | null;
  if (id && NOT_PROP[id]?.test(n)) id = null;
  if (!id) return null;
  // a stone you pick up is a precious one ("glowing stone", "moon stone")
  if (id === "rock" && kind === "pickup") return "gem";
  // a door (kind) can only be a door or a gate; a switch is something you use where it stands
  if (kind === "door") return id === "door" || id === "gate" ? id : null;
  if (kind === "switch" && !["candle", "torch", "lamp", "lantern", "book", "skull", "target", "chest", "crate", "barrel", "pumpkin", "trophy"].includes(id)) return null;
  return id;
}

// Characters: who reads as what. Robots, drones, ghosts of light and animals keep the capsule.
const CHARACTER_WORDS: Record<CharacterId, readonly string[]> = {
  skeleton: ["zombie", "zombies", "undead", "skeleton", "creature", "monster", "ghoul", "mummy", "lich", "corpse", "revenant", "ghost", "spectre", "specter", "phantom", "wraith", "spirit", "poltergeist", "banshee", "vampire", "necromancer", "reaper", "duch", "zombi", "gespenst", "fantasma", "fantome", "geist"],
  mage: ["wizard", "witch", "mage", "sorcerer", "sorceress", "warlock", "druid", "shaman", "alchemist", "enchanter", "enchantress", "magician", "oracle", "seer", "librarian", "professor", "scholar", "sage", "priest", "monk", "fortune", "kouzelnik", "carodejnice", "zauberer", "hexe", "mago", "bruja", "sorcier", "magicien"],
  knight: ["knight", "guard", "guards", "soldier", "police", "policeman", "officer", "cop", "sentry", "sentinel", "warden", "paladin", "captain", "sheriff", "marshal", "keeper", "gatekeeper", "goalkeeper", "goalie", "security", "patrol", "trooper", "commander", "general", "king", "queen", "prince", "princess", "rytir", "straznik", "strazce", "ritter", "wache", "caballero", "guardia", "chevalier", "garde"],
  barbarian: ["barbarian", "viking", "pirate", "brute", "wrestler", "giant", "ogre", "troll", "minotaur", "orc", "gladiator", "warrior", "bandit", "thug", "boxer", "lumberjack", "sumo", "bouncer", "blacksmith", "dwarf", "berserker", "raider", "boarding", "chef", "cook", "farmer", "miner", "pirat", "obr", "riese", "pirata", "gigante", "geant"],
  rogue: ["thief", "rogue", "ninja", "assassin", "spy", "rival", "racer", "runner", "skater", "player", "opponent", "enemy", "hunter", "archer", "ranger", "scout", "explorer", "adventurer", "traveler", "traveller", "guide", "barista", "shopkeeper", "merchant", "vendor", "villager", "citizen", "tourist", "visitor", "kid", "child", "student", "teacher", "doctor", "nurse", "driver", "rider", "pilot", "agent", "detective", "hacker", "chaser", "seeker", "hider", "teammate", "ally", "friend", "stranger", "person", "man", "woman", "boy", "girl", "zlodej", "dieb", "ladron", "voleur"],
};
/** Not people: whatever else the noun says ("security robot", "zombie dog"), these keep the capsule. */
const NOT_CHARACTER = new Set([
  "robot", "droid", "drone", "android", "cyborg", "mech", "turret", "machine", "bot", "ai", "computer", "shark", "fish", "whale",
  "dolphin", "ray", "jellyfish", "octopus", "dog", "cat", "bird", "owl", "chicken", "duck", "horse", "cow", "pig", "sheep", "goat",
  "wolf", "bear", "fox", "deer", "rabbit", "dragon", "dinosaur", "snake", "spider", "bee", "bat", "rat", "mouse", "slime", "blob",
  "orb", "wisp", "light", "flame", "fire", "eye", "tank", "car", "kart", "ship", "boat", "plane", "ufo", "alien",
]);

const WORD_CHARACTER = new Map<string, CharacterId>();
for (const id of Object.keys(CHARACTER_WORDS) as CharacterId[]) for (const w of CHARACTER_WORDS[id]) WORD_CHARACTER.set(w, id);

/**
 * The body a character wears. Anyone who reads as a person and names no role is the rogue; the
 * player is whoever the world's role names ("a wizard apprentice" the mage) and otherwise the
 * knight, whatever the role says (a robot player still needs a body). null keeps the capsule.
 */
export function characterFor(noun: string, player = false): CharacterId | null {
  const words = normNoun(noun).split(" ");
  const named = lookup(words, WORD_CHARACTER) as CharacterId | null;
  if (player) return named ?? "knight";
  if (words.some((w) => NOT_CHARACTER.has(w) || NOT_CHARACTER.has(stem(w)))) return null;
  return named ?? "rogue";
}
