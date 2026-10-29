// Nicknames on a world's best-times board: 3 to 12 letters, digits and spaces, and none of a short
// list of slurs and swearwords (look-alike digits folded, spaces dropped). Basic on purpose: the
// edge enforces it on every entry, and the client checks first so the answer comes at once.

/** Matched anywhere in the folded name: long enough that no ordinary name contains them. */
const ANYWHERE = ["fuck", "shit", "cunt", "nigg", "fagg", "bitch", "whore", "slut", "nazi", "hitler", "retard", "pussy", "penis", "vagina", "dildo", "bollock"];
/** Matched only as a whole word, or as the whole name: short ones hide inside real names (Cassie, Grape, Dickens). */
const WHOLE = ["ass", "arse", "fag", "cum", "tit", "tits", "dick", "cock", "piss", "twat", "wank", "rape", "porn", "sex", "jizz", "kike", "spic", "chink", "coon", "homo", "kys"];
const LOOKALIKE: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" };

export type Nickname = { ok: true; name: string } | { ok: false; why: string };

export function nickname(raw: string): Nickname {
  const name = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  const n = [...name].length;
  if (n < 3 || n > 12) return { ok: false, why: "3 to 12 characters" };
  if (!/^[\p{L}\p{N} ]+$/u.test(name)) return { ok: false, why: "letters, digits and spaces only" };
  const fold = (s: string) => s.toLowerCase().replace(/[0134578]/g, (c) => LOOKALIKE[c] ?? c);
  const words = fold(name).split(" ");
  const joined = words.join("");
  if (ANYWHERE.some((w) => joined.includes(w)) || WHOLE.some((w) => joined === w || words.includes(w))) return { ok: false, why: "pick another name" };
  return { ok: true, name };
}
