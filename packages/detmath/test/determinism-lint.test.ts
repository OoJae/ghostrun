// Determinism lint (stand-in for the planned ESLint rule): the simulation path must not use
// operations whose results can differ between JS engines (Chromium, WebKit, Firefox, Node,
// workerd) or that read wall-clock time / unseeded randomness.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIRS = ["packages/detmath/src", "packages/ir/src", "packages/sim/src", "packages/nav/src", "packages/proof/src", "packages/layout/src", "packages/packs", "packages/bots/src", "packages/kits/src"];
const BANNED: [RegExp, string][] = [
  [/Math\.(sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b/, "transcendental Math (use detmath)"],
  [/Math\.random\b/, "unseeded randomness (use detmath stream())"],
  [/[^*/]\*\*[^*/=]|\*\*=/, "exponentiation (not bit-identical across engines)"],
  [/\bnew Date\b|\bDate\.now\b/, "wall clock"],
  [/localeCompare|\bIntl\./, "locale-dependent ordering"],
];
// Reading the clock is allowed only to *report* durations, via this exact idiom.
const ALLOWED_CLOCK = /globalThis\.performance\?\.now\?\.\(\)/;

function* files(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== "test" && f !== "node_modules") yield* files(p);
    } else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.includes("vite-plugin") && !p.endsWith("node.ts")) yield p;
  }
}

describe("determinism lint", () => {
  it("simulation-path packages use only engine-identical operations", () => {
    const hits: string[] = [];
    for (const d of DIRS) {
      for (const f of files(join(ROOT, d))) {
        readFileSync(f, "utf8").split("\n").forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
          if (code.trim().startsWith("*")) return; // JSDoc continuation
          for (const [re, why] of BANNED) if (re.test(code)) hits.push(`${f.replace(ROOT, "")}:${i + 1}: ${why}: ${line.trim()}`);
          if (/performance\.now/.test(code) && !ALLOWED_CLOCK.test(code)) hits.push(`${f.replace(ROOT, "")}:${i + 1}: clock read outside the reporting idiom: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
