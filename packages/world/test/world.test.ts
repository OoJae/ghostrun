// The shared placer: one fill, one seed, one world, wherever it is placed; the engine hash is the
// pinned Rapier build's; the proof version moves with any source a receipt depends on.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { specHash } from "@ghostrun/ir";
import { RAPIER_WASM_PATH } from "@ghostrun/sim/node";
import { ENGINE_HASH, placeFill, PROOF_VERSION } from "../src";
import { proofVersion } from "../src/version";

const fixture = (name: string) => readFileSync(new URL(`../../ir/fixtures/${name}.jsonl`, import.meta.url), "utf8");
const seedOf = (fill: string) => (JSON.parse(fill.split("\n", 1)[0]!) as { seed?: number }).seed ?? 7;

describe("placeFill", () => {
  it("binds the pinned Rapier build's hash", () => {
    expect(createHash("sha256").update(readFileSync(RAPIER_WASM_PATH)).digest("hex")).toBe(ENGINE_HASH);
  });

  it("places the same world from the same fill, seed, pack and mode", async () => {
    for (const name of ["ctf-neon", "zombie-survival", "kart-race", "vault-heist"]) {
      const fill = fixture(name);
      const [a, b] = [placeFill(fill, seedOf(fill)), placeFill(fill, seedOf(fill))];
      expect(await specHash(ENGINE_HASH, a.bundle)).toBe(await specHash(ENGINE_HASH, b.bundle));
      expect(a.bundle.engine).toBe(ENGINE_HASH);
    }
  });

  it("places into the pack it is told and the mode the intent chose", () => {
    const fill = fixture("ctf-neon");
    const p = placeFill(fill, 7, { pack: "arena", mode: "wander" });
    expect([p.pack, p.bundle.pack.id, p.bundle.mode]).toEqual(["arena", "arena", "wander"]);
    const unknown = placeFill(fill.replace('"pack":"city_block"', '"pack":"moon_base"'), 7);
    expect(unknown.notes[0]).toMatch(/pack 'moon_base' not available, using '/);
  });

  it("is not stamped under test", () => expect(PROOF_VERSION).toBe("dev"));
});

describe("proofVersion", () => {
  const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

  it("hashes the packages the proof depends on, and changes when one of them does", () => {
    const v = proofVersion(repo);
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(proofVersion(repo)).toBe(v);
    // a copy of the tree with one line of the simulation changed has another version; a change to
    // an app (which never proves) does not move it
    const tmp = mkdtempSync(join(tmpdir(), "gr-version-"));
    try {
      cpSync(join(repo, "packages"), join(tmp, "packages"), { recursive: true, filter: (p) => !p.includes("node_modules") });
      cpSync(join(repo, "pnpm-lock.yaml"), join(tmp, "pnpm-lock.yaml"));
      expect(proofVersion(tmp)).toBe(v);
      const sim = join(tmp, "packages/sim/src/index.ts");
      writeFileSync(sim, `${readFileSync(sim, "utf8")}\n// changed\n`);
      expect(proofVersion(tmp)).not.toBe(v);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
