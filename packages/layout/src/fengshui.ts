// Feng Shui for one named school, the Form School (形勢派, the oldest branch: it reads the shape of a
// place and how qi flows through it). Its room principles, each stated so it can be checked on a
// placed world (rooms and doorways from the pack, positions, sizes and facings of things, the nouns
// the fill wrote), each with the published source it comes from. The check reads a world and never
// changes the simulation. For a world that says it is Feng Shui, the placer applies the safe repairs
// (a mirror off the wall that faces the front door, a desk to the command position and turned to its
// door), each logged. Words come out as keys with values: the proof's labels word them in English.
import type { Entity, Vec3, WorldBundle } from "@ghostrun/ir";
import type { ZoneSpec } from "@ghostrun/plugin-api";

export const FENG_SHUI_SCHOOL = "Form School";

export type FengShuiRuleId = "command" | "straight" | "mirror" | "entry" | "clutter" | "elements";
export type Element = "wood" | "fire" | "earth" | "metal" | "water";
export const ELEMENTS: readonly Element[] = ["wood", "fire", "earth", "metal", "water"];

export interface FengShuiSource {
  by: string;
  title: string;
  where: string;
  date: string;
  url: string;
  /** What it says that the rule rests on, quoted or closely paraphrased. */
  says: string;
}

export interface FengShuiRule {
  id: FengShuiRuleId;
  /** Its name on the receipt. */
  name: string;
  /** The principle as the school states it. */
  principle: string;
  /** How it is checked on a world, with the numbers the check uses. */
  check: string;
  sources: readonly FengShuiSource[];
}

/** The school itself: the oldest branch, reading forms and the flow of qi (not compass directions). */
export const FENG_SHUI_SCHOOL_SOURCE: FengShuiSource = {
  by: "Wikipedia contributors", title: "Feng shui", where: "Wikipedia", date: "read 2 November 2026", url: "https://en.wikipedia.org/wiki/Feng_shui",
  says: "The Form branch is the oldest branch of feng shui; it analyzes the shape of the land and flow of the wind and water to find a place with ideal qi, and considers the traditional five elements.",
};

const YAP: Omit<FengShuiSource, "says"> = {
  by: "Joey Yap, interviewed by Qanvast", title: "Bring Luck to Every Room with Joey Yap's Feng Shui Hacks", where: "Qanvast", date: "15 January 2019",
  url: "https://qanvast.com/sg/articles/bring-luck-to-every-room-with-joey-yaps-feng-shui-hacks-1744",
};
const CHAN = (title: string, url: string, says: string): FengShuiSource => ({ by: "Master Sean Chan", title, where: "masterseanchan.com", date: "updated 30 April 2026", url, says });

export const FENG_SHUI_RULES: readonly FengShuiRule[] = [
  {
    id: "command",
    name: "Command position",
    principle: "The bed, the desk or counter and the main sofa sit in the command position: across the room from its door and not in line with it, backed by a solid wall, with the door in view.",
    check: "Each bed, desk, counter or sofa is in the far half of its room from the door the room is entered by, clear of that door's width straight in (plus 0.3 m), within 0.9 m of a solid wall other than the door's (no doorway or window behind it), with nothing taller than 1.2 m between it and the door; where its facing is recorded, it faces the door's side.",
    sources: [
      CHAN("Is Sleeping with Feet Toward the Door the “Coffin Position”?", "https://www.masterseanchan.com/feng-shui-coffin-position-myth/", "The bed should be positioned such that the sleeper can see the door from the bed, but is not directly in line with it; at an angle to the entry, the bed-head against a structural wall, not a window."),
      { ...YAP, says: "Avoid aligning the desk with your door. Don't have your seat (and therefore back) facing directly towards the door." },
    ],
  },
  {
    id: "straight",
    name: "No straight line through",
    principle: "Looking in from the front door, you don't see straight through to a back door or a window: qi that comes in would go straight out.",
    check: "Three sightlines straight in from the front door (its middle and 0.3 m to each side) run through any doorways in line to the first wall or solid thing taller than 1.2 m; a window, back door or exit on the way (one not curtained) fails it, as does a line that leaves the building.",
    sources: [
      { ...YAP, says: "Don't align the main door with the kitchen door/back door: having the two doors aligned means allowing the good energies to simply pass through." },
      CHAN("Does Front Door Aligned with Back Door Drain Wealth?", "https://www.masterseanchan.com/feng-shui-front-back-door-myth/", "The concern is specifically about visual / qi line-of-sight from entry door to exit door / large window; a console table, a tall floor plant or a curtain over the rear window breaks the line."),
    ],
  },
  {
    id: "mirror",
    name: "No mirror facing the front door",
    principle: "No mirror faces the front door: in the classical reading a mirror doubles what it reflects, here the door (BTB practitioners differ).",
    check: "No mirror within 30° of straight in from the front door, in sight of it, faces back toward it (hung on the wall across from it, or turned to it).",
    sources: [
      CHAN("Does Hanging a Bagua Mirror Deflect Bad Feng Shui?", "https://www.masterseanchan.com/feng-shui-bagua-mirror-myth/", "Mirrors in classical interior feng shui are read as doubling whatever they reflect: double the door (qi confusion)."),
      { by: "Amiya Baratan", title: "Is It Okay to Have a Mirror Facing a Door in Feng Shui?", where: "Livingetc", date: "20 April 2025", url: "https://www.livingetc.com/advice/feng-shui-mirror-facing-door", says: "It depends on the school of Feng Shui: in the BTB school a mirror facing the front door is fine (Anjie Cho). This rule follows the classical reading." },
    ],
  },
  {
    id: "entry",
    name: "A clear way in",
    principle: "Nothing obstructs the main door, inside or out, so qi can come in.",
    check: "No solid thing 0.25 m tall or more stands within 0.45 m of the way from 1.5 m outside the front door to 3 m inside it, toward the middle of the room it opens into (doors and people aside).",
    sources: [
      { ...YAP, says: "Don't obstruct the main door. Keep it free from obstructions both inside and outside to allow positive energies to flow smoothly into your space." },
      CHAN("Front Door (大门) — Feng Shui Room Reference", "https://www.masterseanchan.com/fengshui-front-door/", "A door that opens into a wall or a closed-off small foyer chokes the flow."),
    ],
  },
  {
    id: "clutter",
    name: "Uncluttered rooms",
    principle: "Rooms are kept uncluttered so qi circulates: a clear way from each room's door to its middle, and floor left to move on.",
    check: "In every room, the way from the door it is entered by to its middle is clear as for the main door (what stands in the middle is its centrepiece), and solid things cover at most a third of its floor.",
    sources: [{ ...YAP, says: "Rather than overwhelming your space with artwork and items, focus on finding and circulating the good 'Qi'. Keep it clean and organised." }],
  },
  {
    id: "elements",
    name: "Five elements in balance",
    principle: "The five elements (wood, fire, earth, metal, water) are balanced in the materials and colours of a place.",
    check: "At least 3 of the 5 elements appear in the materials and colours the world's things are named with (classical colours and the usual materials; words in English, Czech, German, Spanish, French, Italian, Portuguese and Polish, and a few Chinese and Japanese characters).",
    sources: [
      { by: "Catherine Smith", title: "Balancing act – feng shui", where: "Resene habitat, issue 4", date: "winter 2006", url: "https://www.resene.co.nz/homeown/habitat/4_balancing_act.htm", says: "Feng shui balances the five key elements of fire, earth, metal, water and wood: wood and plants such as rattan and bamboo; candles; pottery, tile and crystals; metals and golds; water, glass and mirrors." },
      { by: "Wikipedia contributors", title: "Wuxing (Chinese philosophy)", where: "Wikipedia", date: "read 2 November 2026", url: "https://en.wikipedia.org/wiki/Wuxing_(Chinese_philosophy)", says: "Feng shui is based on wuxing; the phases' colours are wood green-blue, fire red, earth yellow, metal white and water black." },
    ],
  },
];

export type FengShuiVerdict = "holds" | "fails" | "not_checkable";

/** The values a reason or a fix is worded from (nouns and room names in the world's own words). */
export interface FengShuiVars {
  thing?: string;
  /** The thing's id (to highlight it, or name it to the edit path). */
  id?: string;
  room?: string;
  /** Where a fix moves it: an anchor of its room ("corner_ne", "wall_e"). */
  to?: string;
  by?: string;
  /** Metres from the front door (negative: outside it). */
  m?: number;
  /** A share of a floor (0–1). */
  share?: number;
  rooms?: number;
  have?: number;
  counts?: Record<Element, number>;
  missing?: Element[];
  /** Its facing is recorded (rotY), not assumed. */
  facing?: boolean;
  more?: number;
}

export interface FengShuiFix {
  key: string;
  vars: FengShuiVars;
  /** The change in words the edit path takes, ids included so the model changes the right thing. */
  change: string;
}

export interface FengShuiFinding {
  rule: FengShuiRuleId;
  verdict: FengShuiVerdict;
  /** Why, as a key; the receipt's labels word it from `vars`. */
  why: string;
  vars: FengShuiVars;
  /** For a failed rule, what would fix it, where the edit path can apply it. */
  fix: FengShuiFix | null;
}

export interface FengShuiSection {
  school: string;
  findings: FengShuiFinding[];
  /** Principles that hold, of those that could be checked. */
  holds: number;
  checked: number;
}

// ---- words ------------------------------------------------------------------------------------

/** Lower case, accents off, punctuation to spaces: "Zrcadlo v předsíni" → "zrcadlo v predsini". */
export function normWords(s: string): string {
  return s.toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC").replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, " ").trim();
}
/** Whole words (with their endings where a pattern allows them), and characters anywhere for Chinese and Japanese. */
const words = (alts: string, cjk = "") => new RegExp(`(^| )(${alts})( |$)${cjk ? `|${cjk}` : ""}`);

/** The prompt (or a world's own words) asks for Feng Shui: English, Czech, German, Chinese and the rest. */
export const asksFengShui = (text: string): boolean => /feng[\s-]*(shui|šuej|suej|schui)|fengshui|風水|风水/i.test(text);

/** A world that says it is Feng Shui: its look, room names, promises, things or what they say. */
export function saysFengShui(b: WorldBundle): boolean {
  const said = [b.cosmetic.look, ...b.zones.map((z) => z.name), ...b.expects.map((x) => x.text), ...b.entities.map((e) => e.noun), ...b.verbs.map((v) => String(v.params.text ?? ""))];
  return said.some(asksFengShui);
}

const MIRROR = words("mirrors?|looking glass|zrcadl[a-z]*|zrcatk[a-z]*|spiegel[a-z]*|espejos?|miroirs?|specchi[a-z]*|espelhos?|lustr[oa]|lustrem|lusterk[a-z]*", "鏡|镜|ミラー");
const NOT_MIRROR = /mirror (ball|lake|pond|pool|image|maze)|disco/;
const WINDOW = words("windows?|french windows?|skylights?|back door|rear door|garden door|patio door|glass door|exit door|fire exit|emergency exit|exit|okn[aoe]|okno|zadni dvere|vychod|fenster|hintertur|ausgang|ventanas?|salida|puerta trasera|fenetres?|sortie|finestr[ae]|uscita|janelas?|saida|wyjscie", "窓|窗");
const NOT_WINDOW = /window (display|box|seat|sill|shop)|shop window|vitrine/;
const COVERED = words("curtain[a-z]*|blinds?|shutter[a-z]*|screened|frosted|stained|opaque|zaclon[a-z]*|zaves[a-z]*|rolet[a-z]*|zaluzie|vorhang[a-z]*|gardine[a-z]*|jalousie|rollladen|cortina[a-z]*|rideau[x]?|tend[ae]|zaslon[a-z]*");
// the pieces the command position is about; English compounds name their head noun last ("reception desk" is a desk, a "desk lamp" a lamp)
const COMMAND_EN = /(^| )((desk|bed|counter|reception|cashier|sofa|settee|futon|workbench)s?|couch(es)?)$/;
const COMMAND_OTHER = words("postel|luzko|psaci stul|pracovni stul|recepce|recepcni pult|pult|pokladna|pohovka|gauc|sedacka|bett|schreibtisch|empfang|rezeption|theke|tresen|kasse|cama|escritorio|mostrador|recepcion|comptoir|canape|letto|scrivania|bancone|divano|escrivaninha|balcao|recepcao|lozko|biurko|lada|recepcja|kanapa", "ベッド|机|沙发|ソファ");
const NOT_COMMAND = /flower bed|garden bed|bed of|river bed|sea bed|sofa table|bedside|counter ?weight|countertop/;

/** Materials and colours by element: classical colours (Wikipedia, Wuxing) and the usual materials (Resene). */
const ELEMENT_WORDS: Record<Element, RegExp> = {
  wood: words("wood|wooden|woods|oak|oaken|walnut|teak|cedar|pine|maple|birch|mahogany|ebony|bamboo|rattan|wicker|timber|plank|plants?|potted|trees?|bonsai|ferns?|palms?|ivy|moss|flowers?|orchids?|lotus|lily|lilies|leaf|leaves|green|emerald|jade|olive|mint|linen|cotton|hemp|paper|drev[a-z]*|dub[a-z]*|bambus[a-z]*|ratan[a-z]*|prouten[a-z]*|rostlin[a-z]*|strom[a-z]*|kvet[a-z]*|kvetin[a-z]*|orchide[a-z]*|bonsaj|zelen[a-z]*|smaragd[a-z]*|nefrit[a-z]*|bavln[a-z]*|papir[a-z]*|holz[a-z]*|eiche[a-z]*|pflanze[a-z]*|baum|baume|blume[a-z]*|grun|grune|gruner|grunes|grunen|gruen|papier[a-z]*|madera|bambu|bambou|planta|plante|pianta|arbol|arbre|albero|arvore|flor|fleur|fiore|verde|vert|verte|bois|legno|madeira|drewn[a-z]*|drzew[a-z]*|rosli[a-z]*|kwiat[a-z]*|zielon[a-z]*", "木|竹|植|緑|绿"),
  fire: words("red|crimson|scarlet|ruby|rubies|burgundy|maroon|vermilion|orange|pink|magenta|purple|violet|lavender|fire|flame|flames|fiery|candles?|fireplace|hearth|lanterns?|lamps?|torch|torches|cerven[a-z]*|rud[ay]|rude|rubin[a-z]*|oranzov[a-z]*|ruzov[a-z]*|fialov[a-z]*|purpur[a-z]*|ohen|ohniv[a-z]*|plamen[a-z]*|svick[a-z]*|svicn[a-z]*|krb|lamp[a-z]*|lucern[a-z]*|pochod[a-z]*|rot|rote|roter|rotes|roten|rosa|lila|violett[a-z]*|feuer[a-z]*|flamme[a-z]*|kerze[a-z]*|kamin[a-z]*|laterne[a-z]*|rojo|roja|naranja|morado|fuego|vela|velas|chimenea|farol|rouge|rose|feu|bougies?|cheminee|lanterne|rosso|rossa|arancione|viola|fuoco|candela|lanterna|vermelho|vermelha|laranja|roxo|fogo|lareira|czerwon[a-z]*|pomaranczow[a-z]*|rozow[a-z]*|fiolet[a-z]*|ogien|swiec[a-z]*|kominek|latarni[a-z]*", "火|赤|红|紅|灯|燈|炎"),
  earth: words("stone|stones|stoneware|marble|granite|slate|clay|terracotta|ceramic|ceramics|porcelain|pottery|tiles?|tiled|brick|bricks|sand|sandstone|crystal|crystals|quartz|amethyst|earthenware|yellow|ochre|mustard|brown|kamen[a-z]*|mramor[a-z]*|zul[a-z]*|bridlic[a-z]*|hlin[aeouy]|hliny|hlinen[a-z]*|terakot[a-z]*|keramik[a-z]*|keramick[a-z]*|porcelan[a-z]*|cihl[a-z]*|pisek|piskov[a-z]*|krystal[a-z]*|kristal[a-z]*|zlut[a-z]*|hned[a-z]*|okr[a-z]*|stein[a-z]*|marmor[a-z]*|granit[a-z]*|terrakotta|porzellan[a-z]*|ziegel[a-z]*|kristall[a-z]*|gelb[a-z]*|braun[a-z]*|ocker|piedra|marmol|arcilla|ceramica|porcelana|ladrillo|cristal|amarill[oa]|marron|pierre|marbre|argile|ceramique|porcelaine|brique|jaune|brun|brune|pietra|marmo|argilla|porcellana|mattone|sabbia|cristallo|giall[oa]|marrone|pedra|marmore|argila|tijolo|areia|amarel[oa]|marrom|kamien[a-z]*|kamienn[a-z]*|marmur[a-z]*|glin[a-z]*|cegl[a-z]*|piasek|krysztal[a-z]*|zolt[a-z]*|brazow[a-z]*", "土|石|陶|瓷|黄|黃"),
  metal: words("metal|metallic|steel|iron|brass|bronze|copper|gold|golden|gilded|gilt|silver|chrome|aluminium|aluminum|tin|pewter|platinum|white|grey|gray|pearl|pearls|ivory|kov[a-z]*|ocel[a-z]*|zelez[a-z]*|mosaz[a-z]*|bronz[a-z]*|zlat[a-z]*|stribr[a-z]*|chrom[a-z]*|hlinik[a-z]*|bil[yaei]|bileho|bilou|bilem|sed[yae]|sedeho|sedou|perlet[a-z]*|perl[a-z]*|metall[a-z]*|stahl[a-z]*|eisen[a-z]*|messing[a-z]*|kupfer[a-z]*|silber[a-z]*|weiss[a-z]*|grau[a-z]*|acero|hierro|laton|bronce|cobre|oro|dorad[oa]|plata|platead[oa]|blanc[oa]|blanc|blanche|gris|perla|perle|acier|fer|laiton|cuivre|doree?|argent[a-z]*|metallo|acciaio|ferro|ottone|bronzo|rame|dorat[oa]|argento|bianc[oa]|grigi[oa]|aco|latao|ouro|dourad[oa]|prata|pratead[oa]|branc[oa]|cinza|perola|stal|stali|stalow[a-z]*|zelaz[a-z]*|mosiadz[a-z]*|miedz[a-z]*|zlot[a-z]*|srebr[a-z]*|bial[a-z]*|szar[a-z]*", "金|銀|银|鉄|铁|鋼|钢|白"),
  water: words("water|waters|fountain|fountains|aquarium|fish|koi|pond|pool|waterfall|river|stream|lake|wave|waves|glass|mirror|mirrors|blue|navy|azure|cobalt|sapphire|turquoise|black|vod[a-z]*|fontan[a-z]*|kasn[a-z]*|akvari[a-z]*|ryb[a-z]*|jezir[a-z]*|jezer[a-z]*|vodopad[a-z]*|rek[ay]|sklo|skla|sklen[a-z]*|zrcadl[a-z]*|modr[a-z]*|cern[a-z]*|namorn[a-z]*|wasser[a-z]*|brunnen|aquarium|fisch[a-z]*|teich[a-z]*|fluss|welle[a-z]*|glas[a-z]*|spiegel[a-z]*|blau[a-z]*|schwarz[a-z]*|agua|fuente|acuario|pez|peces|estanque|cascada|rio|ola|vidrio|espejo|azul|negr[oa]|eau|fontaine|poisson|bassin|cascade|riviere|vague|verre|miroir|bleue?|noire?|acqua|fontana|acquario|pesce|stagno|cascata|fiume|onda|vetro|specchio|blu|ner[oa]|fonte|aquario|peixe|lago|vidro|espelho|pret[oa]|wod[a-z]*|fontann[a-z]*|akwari[a-z]*|staw[a-z]*|wodospad|rzek[a-z]*|szkl[a-z]*|niebiesk[a-z]*|granatow[a-z]*|czarn[a-z]*", "水|池|魚|鱼|鏡|镜|黒|黑|藍|蓝|玻璃"),
};

export const isMirror = (noun: string) => {
  const n = normWords(noun);
  return MIRROR.test(n) && !NOT_MIRROR.test(n);
};
/** A window or a way out, curtained or not (either way it is the wall's, not something standing in the room). */
const isWindowish = (noun: string) => {
  const n = normWords(noun);
  return WINDOW.test(n) && !NOT_WINDOW.test(n);
};
/** One you can see out of: not curtained, screened or frosted. */
const isWindow = (noun: string) => isWindowish(noun) && !COVERED.test(normWords(noun));
/** A bed, desk, counter or sofa: the pieces the command position is about. */
export const isCommanding = (noun: string) => {
  const n = normWords(noun);
  return (COMMAND_EN.test(n) || COMMAND_OTHER.test(n)) && !NOT_COMMAND.test(n);
};
/** The elements a thing's name gives it ("golden bamboo bench": metal and wood). */
export function elementsOf(noun: string): Element[] {
  const n = normWords(noun);
  return ELEMENTS.filter((el) => ELEMENT_WORDS[el].test(n));
}

// ---- geometry ---------------------------------------------------------------------------------

interface Room {
  spec: ZoneSpec;
  /** The fill's zone on this slot, if it named one. */
  zone: string;
  name: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}
interface Door {
  x: number;
  z: number;
  half: number;
  /** The rooms it opens into, each with its inward normal from that room's side. */
  rooms: { room: Room; nx: number; nz: number }[];
}
/** The door a room is entered by (from the front door) and its inward normal. */
interface Way {
  door: Door;
  nx: number;
  nz: number;
}
interface Plan {
  rooms: Room[];
  doors: Door[];
  front: Way | null;
  frontRoom: Room | null;
  ways: Map<Room, Way>;
}

const SLOT_NAMES: Record<string, string> = { entrance: "the entrance", main_room: "the main room", room_sw: "the south-west room", room_se: "the south-east room", room_nw: "the north-west room", room_ne: "the north-east room" };
const INWARD: Record<string, [number, number]> = { s: [0, 1], n: [0, -1], w: [1, 0], e: [-1, 0] };
const EYE = 1.5; // sightlines are at eye height
const TALL = 1.2; // a thing this tall above the floor hides what's behind it
const LOW = 0.25; // lower than this is walked over (a rug, a mat)
const BODY = 0.45; // half a body's width: what a way must keep clear on each side

function planOf(b: WorldBundle, zones: readonly ZoneSpec[]): Plan | null {
  const named = new Map(b.zones.map((z) => [z.slot, z]));
  const rooms: Room[] = zones
    .filter((s) => s.tag !== "outside" && Object.keys(s.anchors).some((k) => k.startsWith("doorway_")))
    .map((spec) => {
      const z = named.get(spec.slot);
      return { spec, zone: z?.id ?? "", name: z?.name || SLOT_NAMES[spec.slot] || spec.slot.replace(/_/g, " "), minX: spec.bounds.min[0], minZ: spec.bounds.min[2], maxX: spec.bounds.max[0], maxZ: spec.bounds.max[2] };
    });
  if (!rooms.length) return null;
  const doors: Door[] = [];
  for (const room of rooms) {
    for (const k of Object.keys(room.spec.anchors).filter((a) => a.startsWith("doorway_")).sort()) {
      const [x, , z] = room.spec.anchors[k]!;
      const [nx, nz] = INWARD[k.slice(8)] ?? [0, 0];
      const at = doors.find((d) => Math.abs(d.x - x) < 0.05 && Math.abs(d.z - z) < 0.05);
      if (at) at.rooms.push({ room, nx, nz });
      else {
        // its width from the lintel over it, where the pack has one
        const lintel = b.statics.find((s) => s.surf === "wall" && s.pos[1] - s.size[1] / 2 > 1.8 && Math.abs(s.pos[0] - x) < 0.15 && Math.abs(s.pos[2] - z) < 0.15);
        doors.push({ x, z, half: lintel ? Math.max(lintel.size[0], lintel.size[2]) / 2 : 0.45, rooms: [{ room, nx, nz }] });
      }
    }
  }
  // the front door opens to the outside (into one room only); the visitor comes in at the one nearest their spawn
  const spawn = b.entities.find((e) => e.kind === "spawn" && e.team === "red") ?? b.entities.find((e) => e.kind === "spawn");
  const outer = doors.filter((d) => d.rooms.length === 1);
  const far = (d: Door) => (spawn ? (d.x - spawn.pos[0]) * (d.x - spawn.pos[0]) + (d.z - spawn.pos[2]) * (d.z - spawn.pos[2]) : 0);
  const fd = [...outer].sort((p, q) => far(p) - far(q) || p.x - q.x || p.z - q.z)[0];
  const ways = new Map<Room, Way>();
  if (!fd) return { rooms, doors, front: null, frontRoom: null, ways };
  // the way each room is entered: the doorway on its edge nearest the front door, walking room to room
  const dist = new Map<Door, number>([[fd, 0]]);
  const done = new Set<Door>();
  for (;;) {
    let cur: Door | null = null;
    for (const d of doors) if (!done.has(d) && dist.has(d) && (!cur || dist.get(d)! < dist.get(cur)!)) cur = d;
    if (!cur) break;
    done.add(cur);
    for (const { room } of cur.rooms) {
      for (const d of doors) {
        if (d === cur || !d.rooms.some((r) => r.room === room)) continue;
        const nd = dist.get(cur)! + Math.sqrt((d.x - cur.x) * (d.x - cur.x) + (d.z - cur.z) * (d.z - cur.z));
        if (nd < (dist.get(d) ?? Infinity)) dist.set(d, nd);
      }
    }
  }
  for (const room of rooms) {
    let best: Way | null = null;
    let bestD = Infinity;
    for (const d of doors) {
      const side = d.rooms.find((r) => r.room === room);
      const dd = dist.get(d);
      if (side && dd !== undefined && dd < bestD) ((bestD = dd), (best = { door: d, nx: side.nx, nz: side.nz }));
    }
    if (best) ways.set(room, best);
  }
  const front = fd.rooms[0]!;
  return { rooms, doors, front: { door: fd, nx: front.nx, nz: front.nz }, frontRoom: front.room, ways };
}

const inRoom = (r: Room, x: number, z: number) => x > r.minX + 0.01 && x < r.maxX - 0.01 && z > r.minZ + 0.01 && z < r.maxZ - 0.01;
const roomAt = (p: Plan, x: number, z: number) => p.rooms.find((r) => inRoom(r, x, z)) ?? null;

/** Where along a→b (0–1) the segment first enters the box, or null. */
function enter(ax: number, az: number, bx: number, bz: number, minX: number, minZ: number, maxX: number, maxZ: number): number | null {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  for (const [p, q] of [[-dx, ax - minX], [dx, maxX - ax], [-dz, az - minZ], [dz, maxZ - az]] as const) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return t0;
}

const solid = (e: Entity) => (e.body === "fixed" || e.body === "kinematic" || e.body === "dynamic") && e.kind !== "spawn" && e.kind !== "npc" && e.kind !== "door" && e.kind !== "vehicle" && !e.tags.includes("area") && !e.tags.includes("bonus") && e.size[1] >= LOW;
const tall = (e: Entity) => solid(e) && e.pos[1] + e.size[1] / 2 >= TALL;
const label = (e: { id: string; noun: string }) => e.noun.trim() || e.id.replace(/_/g, " ");

/** A rotY the check can read: a quarter turn (no trig on this path), as the way the thing faces. */
function facingOf(rotY: number): [number, number] | null {
  const q = rotY / (Math.PI / 2);
  const k = Math.round(q);
  if (rotY === 0 || Math.abs(q - k) > 1e-6) return null; // 0 is what a fill leaves unwritten
  return ([[0, 1], [1, 0], [0, -1], [-1, 0]] as const)[((k % 4) + 4) % 4] as [number, number];
}
/** The rotY that faces (fx, fz), a unit axis; +z is 0, which reads as "not recorded". */
function rotYFor(fx: number, fz: number): number {
  if (fz > 0.5) return 0;
  if (fx > 0.5) return Math.PI / 2;
  if (fx < -0.5) return -Math.PI / 2;
  return Math.PI;
}

/** The first thing a sightline from a to b meets: a wall at eye height, or a solid thing taller than TALL. */
function blocker(b: WorldBundle, ax: number, az: number, bx: number, bz: number, skip: ReadonlySet<string>): { t: number; e: Entity | null } | null {
  let best: { t: number; e: Entity | null } | null = null;
  for (const s of b.statics) {
    if (s.surf !== "wall" || s.pos[1] - s.size[1] / 2 > EYE || s.pos[1] + s.size[1] / 2 < EYE) continue;
    const t = enter(ax, az, bx, bz, s.pos[0] - s.size[0] / 2, s.pos[2] - s.size[2] / 2, s.pos[0] + s.size[0] / 2, s.pos[2] + s.size[2] / 2);
    if (t !== null && (!best || t < best.t)) best = { t, e: null };
  }
  for (const e of b.entities) {
    if (skip.has(e.id) || !tall(e)) continue;
    const t = enter(ax, az, bx, bz, e.pos[0] - e.size[0] / 2, e.pos[2] - e.size[2] / 2, e.pos[0] + e.size[0] / 2, e.pos[2] + e.size[2] / 2);
    if (t !== null && (!best || t < best.t)) best = { t, e };
  }
  return best;
}

/** The first solid thing on the way from a to b, within `pad` of it: what you'd walk into. */
function inTheWay(b: WorldBundle, ax: number, az: number, bx: number, bz: number, pad: number, skip: (e: Entity) => boolean): { t: number; e: Entity } | null {
  let best: { t: number; e: Entity } | null = null;
  for (const e of b.entities) {
    if (!solid(e) || skip(e)) continue;
    const t = enter(ax, az, bx, bz, e.pos[0] - e.size[0] / 2 - pad, e.pos[2] - e.size[2] / 2 - pad, e.pos[0] + e.size[0] / 2 + pad, e.pos[2] + e.size[2] / 2 + pad);
    if (t !== null && (!best || t < best.t || (t === best.t && e.id < best.e.id))) best = { t, e };
  }
  return best;
}

/** A thing the check can place: an entity, or a dress item on its zone's anchor. */
interface Placed {
  id: string;
  noun: string;
  x: number;
  y: number;
  z: number;
  hx: number;
  hz: number;
  anchor: string;
  zone: string;
  rotY: number;
  dress: boolean;
}
function placedThings(b: WorldBundle, zones: readonly ZoneSpec[]): Placed[] {
  const bySlot = new Map(zones.map((s) => [s.slot, s]));
  const slotOf = new Map(b.zones.map((z) => [z.id, z.slot]));
  const out: Placed[] = b.entities.map((e) => ({ id: e.id, noun: e.noun, x: e.pos[0], y: e.pos[1], z: e.pos[2], hx: e.size[0] / 2, hz: e.size[2] / 2, anchor: e.anchor, zone: e.zone, rotY: e.rotY, dress: false }));
  for (const d of b.cosmetic.dress) {
    const at = bySlot.get(slotOf.get(d.zone) ?? "")?.anchors[d.anchor];
    if (at) out.push({ id: d.id, noun: d.noun, x: at[0], y: at[1], z: at[2], hx: 0.4, hz: 0.4, anchor: d.anchor, zone: d.zone, rotY: 0, dress: true });
  }
  return out;
}

/** Which way a mirror (or window) on a wall faces: away from the wall it hangs on; null if free-standing and unturned. */
function wallFacing(t: Placed, room: Room | null): [number, number] | null {
  const f = facingOf(t.rotY);
  if (f) return f;
  const side = /^wall_([nsew])$/.exec(t.anchor)?.[1];
  if (side) return INWARD[side]!;
  if (!room) return null;
  const gaps: [number, string][] = [[t.z - room.minZ, "s"], [room.maxZ - t.z, "n"], [t.x - room.minX, "w"], [room.maxX - t.x, "e"]];
  const [gap, s] = gaps.sort((p, q) => p[0] - q[0])[0]!;
  return gap < 0.5 ? INWARD[s]! : null;
}

// ---- the rules ---------------------------------------------------------------------------------

const fail = (rule: FengShuiRuleId, why: string, vars: FengShuiVars, fix: FengShuiFix | null): FengShuiFinding => ({ rule, verdict: "fails", why, vars, fix });
const holds = (rule: FengShuiRuleId, why: string, vars: FengShuiVars = {}): FengShuiFinding => ({ rule, verdict: "holds", why, vars, fix: null });
const unknown = (rule: FengShuiRuleId, why: string, vars: FengShuiVars = {}): FengShuiFinding => ({ rule, verdict: "not_checkable", why, vars, fix: null });

/** Why a piece at (x, z) with half-extents (hx, hz) isn't in the command position (null: it is). */
function commandFault(b: WorldBundle, p: Plan, room: Room, way: Way, id: string, x: number, z: number, hx: number, hz: number, rotY: number): { why: string; by?: string } | null {
  const { door, nx, nz } = way;
  const [tx, tz] = [nz, -nx];
  const [rx, rz] = [x - door.x, z - door.z];
  const depth = rx * nx + rz * nz;
  const side = rx * tx + rz * tz;
  const roomDepth = nx !== 0 ? room.maxX - room.minX : room.maxZ - room.minZ;
  const halfAcross = Math.abs(tx) * hx + Math.abs(tz) * hz;
  if (Math.abs(side) < door.half + halfAcross + 0.3) return { why: "command_in_line" };
  if (depth < roomDepth / 2) return { why: "command_near" };
  // its back: the side it faces away from if it is turned, else any solid wall close by but the door's
  const f = facingOf(rotY);
  const walls: { s: string; gap: number }[] = [
    { s: "s", gap: z - hz - room.minZ }, { s: "n", gap: room.maxZ - z - hz }, { s: "w", gap: x - hx - room.minX }, { s: "e", gap: room.maxX - x - hx },
  ];
  const doorSide = walls.find((w) => INWARD[w.s]![0] === nx && INWARD[w.s]![1] === nz)!.s;
  const back = walls.filter((w) => w.gap <= 0.9 && w.s !== doorSide && (!f || (INWARD[w.s]![0] === f[0] && INWARD[w.s]![1] === f[1])));
  const behind = (w: { s: string }) => {
    // a doorway or a window in that wall right behind it is no wall to lean on
    const along = w.s === "n" || w.s === "s" ? x : z;
    const halfAlong = w.s === "n" || w.s === "s" ? hx : hz;
    const line = w.s === "n" ? room.maxZ : w.s === "s" ? room.minZ : w.s === "e" ? room.maxX : room.minX;
    const onLine = (px: number, pz: number) => Math.abs((w.s === "n" || w.s === "s" ? pz : px) - line) < 0.6;
    const nearAlong = (px: number, pz: number, reach: number) => Math.abs((w.s === "n" || w.s === "s" ? px : pz) - along) < halfAlong + reach;
    if (p.doors.some((d) => onLine(d.x, d.z) && nearAlong(d.x, d.z, d.half + 0.3))) return false;
    return !b.entities.some((e) => e.id !== id && isWindow(e.noun) && onLine(e.pos[0], e.pos[2]) && nearAlong(e.pos[0], e.pos[2], e.size[0] / 2 + 0.3));
  };
  if (!back.some(behind)) return { why: "command_no_wall" };
  const hid = blocker(b, x, z, door.x + nx * 0.15, door.z + nz * 0.15, new Set([id]));
  if (hid?.e) return { why: "command_hidden", by: label(hid.e) };
  if (f && f[0] * -rx + f[1] * -rz <= 0) return { why: "command_away" };
  return null;
}

/** A free corner of a room where a piece would hold the command position, farthest from its door. */
function commandCorner(b: WorldBundle, p: Plan, room: Room, way: Way, e: Entity): string | null {
  const taken = new Set(b.entities.filter((o) => o.id !== e.id && o.zone === e.zone).map((o) => o.anchor));
  const corners = Object.entries(room.spec.anchors).filter(([k]) => k.startsWith("corner_") && !taken.has(k));
  const ok = corners.filter(([, a]) => !commandFault(b, p, room, way, e.id, a[0], a[2], e.size[0] / 2, e.size[2] / 2, 0));
  const far = ([, a]: [string, Vec3]) => (a[0] - way.door.x) * (a[0] - way.door.x) + (a[2] - way.door.z) * (a[2] - way.door.z);
  return ok.sort((u, v) => far(v) - far(u) || (u[0] < v[0] ? -1 : 1))[0]?.[0] ?? null;
}

function command(b: WorldBundle, p: Plan): FengShuiFinding {
  const pieces = b.entities.filter((e) => e.kind !== "npc" && e.kind !== "spawn" && isCommanding(e.noun)).sort((u, v) => (u.id < v.id ? -1 : 1));
  const inside = pieces.map((e) => ({ e, room: roomAt(p, e.pos[0], e.pos[2]) })).filter((x): x is { e: Entity; room: Room } => x.room !== null && p.ways.has(x.room));
  if (!inside.length) return unknown("command", "command_none");
  for (const { e, room } of inside) {
    const way = p.ways.get(room)!;
    const fault = commandFault(b, p, room, way, e.id, e.pos[0], e.pos[2], e.size[0] / 2, e.size[2] / 2, e.rotY);
    if (!fault) continue;
    const to = commandCorner(b, p, room, way, e);
    const vars: FengShuiVars = { thing: label(e), id: e.id, room: room.name, ...(fault.by ? { by: fault.by } : {}) };
    const where = room.zone ? ` of zone ${room.zone}` : "";
    return fail("command", fault.why, vars, {
      key: "move_command",
      vars: { thing: label(e), id: e.id, room: room.name, ...(to ? { to } : {}) },
      change: to
        ? `Move ${e.id} (the ${label(e)}) to anchor ${to}${where}: across the room from its door, its back to the wall, facing the door.`
        : `Move ${e.id} (the ${label(e)}) across the room from its door, out of the door's line, with its back to a solid wall.`,
    });
  }
  const [first] = inside;
  return holds("command", "command_ok", { thing: label(first!.e), id: first!.e.id, room: first!.room.name, facing: facingOf(first!.e.rotY) !== null, ...(inside.length > 1 ? { more: inside.length - 1 } : {}) });
}

function straight(b: WorldBundle, p: Plan, things: readonly Placed[]): FengShuiFinding {
  const { door, nx, nz } = p.front!;
  const [tx, tz] = [nz, -nx];
  // windows and ways out: things named so, hung on a room's wall (an exit sign mid-room is no way out)
  const onWall = (t: Placed) => p.rooms.some((r) => inRoom(r, t.x, t.z) && Math.min(t.x - r.minX, r.maxX - t.x, t.z - r.minZ, r.maxZ - t.z) < 0.7);
  const targets = things.filter((t) => isWindow(t.noun) && onWall(t));
  const skip = new Set(things.filter((t) => !t.dress && isWindowish(t.noun)).map((t) => t.id));
  const LEN = 80;
  let worst: FengShuiFinding | null = null;
  let stop: FengShuiFinding | null = null;
  for (const off of [0, -0.3, 0.3]) {
    const ax = door.x + tx * off + nx * 0.15;
    const az = door.z + tz * off + nz * 0.15;
    const [bx, bz] = [ax + nx * LEN, az + nz * LEN];
    const hit = blocker(b, ax, az, bx, bz, skip);
    const tHit = hit ? hit.t : 1;
    const seen = targets
      .map((t) => ({ t, at: enter(ax, az, bx, bz, t.x - Math.max(t.hx, 0.2) - 0.15, t.z - Math.max(t.hz, 0.2) - 0.15, t.x + Math.max(t.hx, 0.2) + 0.15, t.z + Math.max(t.hz, 0.2) + 0.15) }))
      .filter((x): x is { t: Placed; at: number } => x.at !== null && x.at <= tHit + 0.3 / LEN)
      .sort((u, v) => u.at - v.at || (u.t.id < v.t.id ? -1 : 1))[0];
    if (seen) {
      const room = roomAt(p, seen.t.x, seen.t.z);
      worst ??= fail("straight", "straight_window", { thing: label(seen.t), id: seen.t.id, ...(room ? { room: room.name } : {}) }, seen.t.dress ? null : {
        key: "cover_window",
        vars: { thing: label(seen.t), id: seen.t.id },
        change: `Hang a curtain over ${seen.t.id} (the ${label(seen.t)}), or stand a tall plant between it and the front door.`,
      });
      continue;
    }
    const [hx, hz] = [ax + (bx - ax) * tHit, az + (bz - az) * tHit];
    const before = roomAt(p, hx - nx * 0.3, hz - nz * 0.3);
    if (!hit || !before) {
      // nothing stops it inside: it leaves the building
      const last = [...p.rooms].filter((r) => enter(ax, az, bx, bz, r.minX, r.minZ, r.maxX, r.maxZ) !== null).sort((u, v) => (enter(ax, az, bx, bz, v.minX, v.minZ, v.maxX, v.maxZ) ?? 0) - (enter(ax, az, bx, bz, u.minX, u.minZ, u.maxX, u.maxZ) ?? 0))[0];
      worst ??= fail("straight", "straight_out", last ? { room: last.name } : {}, {
        key: "screen_out",
        vars: last ? { room: last.name } : {},
        change: `Stand a folding screen or a tall plant${last?.zone ? ` in zone ${last.zone}` : ""}, in line with the front door, so the way in doesn't look straight out.`,
      });
      continue;
    }
    if (off === 0) stop = hit.e ? holds("straight", "straight_blocked", { thing: label(hit.e), id: hit.e.id }) : holds("straight", "straight_wall", { room: before.name });
  }
  return worst ?? stop ?? holds("straight", "straight_wall", { room: p.frontRoom!.name });
}

function mirror(b: WorldBundle, p: Plan, things: readonly Placed[]): FengShuiFinding {
  const mirrors = things.filter((t) => isMirror(t.noun)).sort((u, v) => (u.id < v.id ? -1 : 1));
  if (!mirrors.length) return holds("mirror", "mirror_none");
  let unsure: Placed | null = null;
  for (const t of mirrors) {
    const f = facesFront(b, p, t);
    if (f === "faces") {
      const room = roomAt(p, t.x, t.z);
      const to = room && !t.dress ? mirrorWall(b, p, t, room) : null;
      const where = room?.zone ? ` of zone ${room.zone}` : "";
      return fail("mirror", "mirror_faces", { thing: label(t), id: t.id, ...(room ? { room: room.name } : {}) }, t.dress ? null : {
        key: "move_mirror",
        vars: { thing: label(t), id: t.id, ...(room ? { room: room.name } : {}), ...(to ? { to } : {}) },
        change: to ? `Move ${t.id} (the ${label(t)}) to anchor ${to}${where}, a side wall out of line with the front door.` : `Move ${t.id} (the ${label(t)}) to a side wall, out of line with the front door.`,
      });
    }
    if (f === "unknown") unsure ??= t;
  }
  if (unsure) return unknown("mirror", "mirror_unknown", { thing: label(unsure), id: unsure.id });
  return holds("mirror", "mirror_aside", { thing: label(mirrors[0]!), id: mirrors[0]!.id, ...(mirrors.length > 1 ? { more: mirrors.length - 1 } : {}) });
}

/** Does a mirror face the front door: in its view (30° either side), in sight, turned back toward it? */
function facesFront(b: WorldBundle, p: Plan, t: Placed): "faces" | "aside" | "unknown" {
  const { door, nx, nz } = p.front!;
  const [rx, rz] = [t.x - door.x, t.z - door.z];
  const depth = rx * nx + rz * nz;
  const side = rx * nz - rz * nx;
  if (depth < 0.5 || Math.abs(side) > 0.58 * depth + door.half) return "aside";
  // (a mirror hung on a wall stands just in front of it; the sightline ends at its face)
  const len = Math.sqrt(rx * rx + rz * rz);
  const [ex, ez] = [t.x - (rx / len) * 0.15, t.z - (rz / len) * 0.15];
  if (blocker(b, door.x + nx * 0.15, door.z + nz * 0.15, ex, ez, new Set([t.id]))) return "aside";
  const f = wallFacing(t, roomAt(p, t.x, t.z));
  if (!f) return "unknown";
  return (f[0] * -rx + f[1] * -rz) / len >= 0.7 ? "faces" : "aside";
}

/** A free wall anchor of a mirror's room where it no longer faces the front door. */
function mirrorWall(b: WorldBundle, p: Plan, t: Placed, room: Room): string | null {
  const taken = new Set([...b.entities.filter((o) => o.id !== t.id && o.zone === t.zone).map((o) => o.anchor), ...b.cosmetic.dress.filter((d) => d.id !== t.id && d.zone === t.zone).map((d) => d.anchor)]);
  for (const k of ["wall_e", "wall_w", "wall_n", "wall_s"]) {
    const a = room.spec.anchors[k];
    if (!a || k === t.anchor || taken.has(k)) continue;
    if (facesFront(b, p, { ...t, x: a[0], y: a[1], z: a[2], anchor: k, rotY: 0 }) === "aside") return k;
  }
  return null;
}

function entry(b: WorldBundle, p: Plan): FengShuiFinding {
  const { door, nx, nz } = p.front!;
  const room = p.frontRoom!;
  const [cx, cz] = [(room.minX + room.maxX) / 2, (room.minZ + room.maxZ) / 2];
  // straight through the doorway, then toward the middle of the room, for its first 3 m inside
  const [ix, iz] = [door.x + nx * 0.5, door.z + nz * 0.5];
  const toMid = Math.sqrt((cx - ix) * (cx - ix) + (cz - iz) * (cz - iz));
  const k = toMid > 2.5 ? 2.5 / toMid : 1;
  const [mx, mz] = [ix + (cx - ix) * k, iz + (cz - iz) * k];
  const out = inTheWay(b, door.x - nx * 1.5, door.z - nz * 1.5, ix, iz, BODY, () => false);
  const inn = inTheWay(b, ix, iz, mx, mz, BODY, () => false);
  const hit = out?.e ?? inn?.e;
  if (!hit) return holds("entry", "entry_clear", { room: room.name });
  // how far in (or out) it stands, measured straight in from the door
  const m = Math.round(((hit.pos[0] - door.x) * nx + (hit.pos[2] - door.z) * nz) * 10) / 10;
  return fail("entry", "entry_blocked", { thing: label(hit), id: hit.id, m }, {
    key: "clear_entry",
    vars: { thing: label(hit), id: hit.id },
    change: `Move ${hit.id} (the ${label(hit)}) out of the way in from the front door, to a corner anchor of its zone.`,
  });
}

function clutter(b: WorldBundle, p: Plan): FengShuiFinding {
  let checked = 0;
  let fullest = 0;
  for (const room of [...p.rooms].sort((u, v) => (u.spec.slot < v.spec.slot ? -1 : 1))) {
    const way = p.ways.get(room);
    if (!way) continue;
    checked++;
    const [cx, cz] = [(room.minX + room.maxX) / 2, (room.minZ + room.maxZ) / 2];
    const inside = b.entities.filter((e) => solid(e) && inRoom(room, e.pos[0], e.pos[2]));
    // (the front door's room is the clear way in's to judge)
    if (room !== p.frontRoom) {
      const [ix, iz] = [way.door.x + way.nx * 0.5, way.door.z + way.nz * 0.5];
      const len = Math.sqrt((cx - ix) * (cx - ix) + (cz - iz) * (cz - iz));
      if (len > 1.2) {
        const k = (len - 1) / len;
        const centrepiece = (e: Entity) => Math.abs(e.pos[0] - cx) <= e.size[0] / 2 + 0.3 && Math.abs(e.pos[2] - cz) <= e.size[2] / 2 + 0.3;
        const hit = inTheWay(b, ix, iz, ix + (cx - ix) * k, iz + (cz - iz) * k, BODY, (e) => centrepiece(e) || !inRoom(room, e.pos[0], e.pos[2]));
        if (hit) {
          return fail("clutter", "clutter_path", { thing: label(hit.e), id: hit.e.id, room: room.name }, {
            key: "clear_path",
            vars: { thing: label(hit.e), id: hit.e.id, room: room.name },
            change: `Move ${hit.e.id} (the ${label(hit.e)}) off the way from the door of ${room.zone || room.name} to its middle, to a corner anchor.`,
          });
        }
      }
    }
    const area = (room.maxX - room.minX) * (room.maxZ - room.minZ);
    const share = inside.reduce((s, e) => s + e.size[0] * e.size[2], 0) / area;
    if (share > 1 / 3) {
      const pct = Math.round(share * 100) / 100;
      return fail("clutter", "clutter_full", { room: room.name, share: pct }, {
        key: "fewer_things",
        vars: { room: room.name },
        change: `Take out some of the solid things in ${room.zone ? `zone ${room.zone}` : room.name}: they cover ${Math.round(share * 100)}% of its floor.`,
      });
    }
    fullest = Math.max(fullest, share);
  }
  if (!checked) return unknown("clutter", "no_front_door");
  return holds("clutter", "clutter_ok", { rooms: checked, share: Math.round(fullest * 100) / 100 });
}

const ELEMENT_EXAMPLE: Record<Element, string> = { wood: "a bamboo plant", fire: "a red paper lantern", earth: "a stone bench", metal: "a brass bowl", water: "a small fountain" };

function elements(b: WorldBundle): FengShuiFinding {
  const counts: Record<Element, number> = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  let named = 0;
  const nouns = [...b.entities.filter((e) => e.kind !== "spawn" && !e.tags.includes("bonus")).map((e) => e.noun), ...b.cosmetic.dress.map((d) => d.noun)];
  for (const n of nouns) {
    const els = elementsOf(n);
    if (els.length) named++;
    for (const el of els) counts[el]++;
  }
  if (named < 2) return unknown("elements", "elements_unnamed", { counts });
  const have = ELEMENTS.filter((el) => counts[el] > 0).length;
  if (have >= 3) return holds("elements", "elements_ok", { have, counts });
  const missing = ELEMENTS.filter((el) => counts[el] === 0);
  return fail("elements", "elements_few", { have, counts, missing }, {
    key: "add_elements",
    vars: { missing },
    change: `Add ${missing.slice(0, 3).map((el) => ELEMENT_EXAMPLE[el]).join(", ")} to the rooms, each named with its material or colour.`,
  });
}

/**
 * The Form School's principles on a placed world: rooms and doorways from the pack's zones, the
 * rest from the bundle. Pure: the same world gives the same section everywhere.
 */
export function fengShui(b: WorldBundle, zones: readonly ZoneSpec[]): FengShuiSection {
  const p = planOf(b, zones);
  const things = placedThings(b, zones);
  const geometric = (id: FengShuiRuleId, run: (p: Plan) => FengShuiFinding): FengShuiFinding => (!p ? unknown(id, "not_interior") : !p.front ? unknown(id, "no_front_door") : run(p));
  const findings = [
    geometric("command", (q) => command(b, q)),
    geometric("straight", (q) => straight(b, q, things)),
    geometric("mirror", (q) => mirror(b, q, things)),
    geometric("entry", (q) => entry(b, q)),
    geometric("clutter", (q) => clutter(b, q)),
    elements(b),
  ];
  const checked = findings.filter((f) => f.verdict !== "not_checkable").length;
  return { school: FENG_SHUI_SCHOOL, findings, holds: findings.filter((f) => f.verdict === "holds").length, checked };
}

// ---- the placer's repairs -----------------------------------------------------------------------

/** Only decor and exhibits are moved: nothing a rule names, so no rule can change what it does. */
function movable(b: WorldBundle, e: Entity): boolean {
  if (e.kind !== "prop" && e.kind !== "sign") return false;
  return !b.rules.some((r) => r.when.a === e.id || r.when.b === e.id || r.if.some((c) => c.l.split(".")[0] === e.id) || r.then.some((x) => x.target === e.id || x.v === e.id));
}

function moveTo(e: Entity, spec: ZoneSpec, anchor: string) {
  const a = spec.anchors[anchor]!;
  e.anchor = anchor;
  e.pos = [a[0], a[1] + e.size[1] / 2, a[2]];
}

/**
 * For a world that says it is Feng Shui: a mirror facing the front door moves to a side wall, a
 * bed, desk, counter or sofa out of the command position moves to a free corner where it holds it,
 * and one that holds it is turned to face its door (a quarter turn swaps its footprint, as a door's
 * does). Only decor and exhibits no rule names; each move is logged.
 */
export function repairFengShui(b: WorldBundle, zones: readonly ZoneSpec[], bound: ReadonlyMap<string, ZoneSpec>): string[] {
  if (!saysFengShui(b)) return [];
  const p = planOf(b, zones);
  if (!p) return [];
  const notes: string[] = [];
  if (p.front) {
    for (const e of b.entities.filter((x) => isMirror(x.noun) && movable(b, x)).sort((u, v) => (u.id < v.id ? -1 : 1))) {
      const t = placedThings(b, zones).find((x) => x.id === e.id)!;
      const room = roomAt(p, t.x, t.z);
      const spec = bound.get(e.zone);
      if (!room || !spec || spec !== room.spec || facesFront(b, p, t) !== "faces") continue;
      const to = mirrorWall(b, p, t, room);
      if (!to) continue;
      notes.push(`${e.id}: moved from '${e.anchor || "zone"}' to '${to}' (Feng Shui: no mirror faces the front door)`);
      moveTo(e, spec, to);
    }
    for (const d of b.cosmetic.dress.filter((x) => isMirror(x.noun)).sort((u, v) => (u.id < v.id ? -1 : 1))) {
      const t = placedThings(b, zones).find((x) => x.id === d.id && x.dress);
      const room = t ? roomAt(p, t.x, t.z) : null;
      if (!t || !room || facesFront(b, p, t) !== "faces") continue;
      const to = mirrorWall(b, p, t, room);
      if (!to) continue;
      notes.push(`${d.id}: moved from '${d.anchor}' to '${to}' (Feng Shui: no mirror faces the front door)`);
      d.anchor = to;
    }
  }
  for (const e of b.entities.filter((x) => isCommanding(x.noun) && movable(b, x)).sort((u, v) => (u.id < v.id ? -1 : 1))) {
    const room = roomAt(p, e.pos[0], e.pos[2]);
    const way = room ? p.ways.get(room) : undefined;
    const spec = bound.get(e.zone);
    if (!room || !way || !spec || spec !== room.spec) continue;
    if (commandFault(b, p, room, way, e.id, e.pos[0], e.pos[2], e.size[0] / 2, e.size[2] / 2, e.rotY)) {
      const to = commandCorner(b, p, room, way, e);
      if (!to) continue;
      notes.push(`${e.id}: moved from '${e.anchor || "zone"}' to '${to}' (Feng Shui: the command position, across the room from its door with its back to a wall)`);
      moveTo(e, spec, to);
    }
    if (facingOf(e.rotY)) continue;
    // its back to the wall across from the door if that is the one behind it, else the side wall
    const turn = faceDoor(b, p, room, way, e);
    if (turn) notes.push(`${e.id}: turned to face its door (Feng Shui: the command position)`);
  }
  return notes;
}

/** Turn a piece in the command position to face its door, its back to the wall behind it. */
function faceDoor(b: WorldBundle, p: Plan, room: Room, way: Way, e: Entity): boolean {
  const gaps: { f: [number, number]; gap: number; across: boolean }[] = [
    { f: [0, 1], gap: e.pos[2] - e.size[2] / 2 - room.minZ, across: way.nz === -1 },
    { f: [0, -1], gap: room.maxZ - e.pos[2] - e.size[2] / 2, across: way.nz === 1 },
    { f: [1, 0], gap: e.pos[0] - e.size[0] / 2 - room.minX, across: way.nx === -1 },
    { f: [-1, 0], gap: room.maxX - e.pos[0] - e.size[0] / 2, across: way.nx === 1 },
  ];
  const [rx, rz] = [way.door.x - e.pos[0], way.door.z - e.pos[2]];
  const back = gaps.filter((g) => g.gap <= 0.9 && g.f[0] * rx + g.f[1] * rz > 0).sort((u, v) => Number(v.across) - Number(u.across) || u.gap - v.gap)[0];
  if (!back) return false;
  const rotY = rotYFor(back.f[0], back.f[1]);
  if (rotY === 0) return false; // facing +z is how an unturned thing already reads
  const quarter = back.f[0] !== 0;
  const size: Vec3 = quarter ? [e.size[2], e.size[1], e.size[0]] : e.size;
  // a turned footprint that would reach into a doorway's way, or into something solid, stays as it was
  const [hx, hz] = [size[0] / 2, size[2] / 2];
  const clash = p.doors.some((d) => Math.abs(d.x - e.pos[0]) < hx + d.half + 0.5 && Math.abs(d.z - e.pos[2]) < hz + d.half + 0.5) ||
    b.entities.some((o) => o.id !== e.id && solid(o) && Math.abs(o.pos[0] - e.pos[0]) < hx + o.size[0] / 2 && Math.abs(o.pos[2] - e.pos[2]) < hz + o.size[2] / 2);
  if (quarter && clash) return false;
  if (commandFault(b, p, room, way, e.id, e.pos[0], e.pos[2], hx, hz, rotY)) return false;
  e.rotY = rotY;
  e.size = size;
  return true;
}
