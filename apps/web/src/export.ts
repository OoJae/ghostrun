// Export a world to take elsewhere: geometry as glTF (named by id, with kind, noun, zone and verbs
// in each node's extras), the logic as logic.json in triggers / states / rules terms (each rule as
// a sentence and as data, with its proof status), and the playtest report as one self-contained
// HTML file (report.ts). The export menu offers each, or all three.
import type { WorldBundle } from "@ghostrun/ir";
import { verb } from "@ghostrun/kits";
import type { Receipt } from "@ghostrun/proof";
import { BoxGeometry, CapsuleGeometry, Color, Group, Mesh, MeshStandardMaterial, SphereGeometry } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { sentence } from "./host";
import { reportHtml, type ReportInput } from "./report";

const SURFACE: Record<string, string> = { floor: "#5b5f6e", wall: "#30323d", ledge: "#7a7f95", roof: "#7a7f95", glass: "#9fd6ff", water: "#3a86c8", hazard: "#ff4a1c" };
const KIND: Record<string, string> = { pickup: "#ffe45c", goal: "#3dffa8", hazard: "#ff4a1c", door: "#8a6a4a", switch: "#19e3ff", plate: "#ffb02e", npc: "#ff3b5c", portal: "#ff2bd6", checkpoint: "#ffb02e", spawn: "#ffffff" };

export function logicJson(b: WorldBundle, spec: string, receipt: Receipt | null) {
  const status = (id: string) => receipt?.chips.find((c) => c.id === id)?.status ?? "not_checked";
  return {
    format: "ghostrun.logic/1",
    spec,
    world: { mode: b.mode, pack: b.pack.id, seed: b.seed, laws: b.laws, units: "metres, seconds; y is up" },
    entities: b.entities.map((e) => ({ id: e.id, kind: e.kind, noun: e.noun, zone: e.zone, team: e.team, body: e.body, position: e.pos, size: e.size, states: e.states, initial: e.init })),
    verbs: b.verbs.map((v) => ({ id: v.id, verb: v.verb, on: v.on, params: v.params, does: verb(v.verb)?.line ?? "" })),
    rules: b.rules.map((r) => ({ id: r.id, text: sentence(b, r), when: r.when, if: r.if, then: r.then, once: r.once, cooldownS: r.cooldownS, proof: status(`T2:${r.id}`) })),
    npcs: b.cast.map((c) => ({ npc: c.npc, role: c.role, menu: c.menu, default: c.dflt })),
    expectations: b.expects.map((x) => ({ id: x.id, prop: x.prop, text: x.text, headline: x.headline, a: x.a, b: x.b, need: x.need })),
    receipt: receipt && { headline: receipt.headline, par: receipt.par, chips: receipt.chips.map((c) => ({ id: c.id, status: c.status, text: c.text, method: c.method, k: c.k, n: c.n, counterexample: c.cx?.text ?? null })) },
  };
}

/** Plain meshes from the world document: statics coloured by surface, entities by kind. */
async function gltf(b: WorldBundle): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = "ghostrun_world";
  const mat = new Map<string, MeshStandardMaterial>();
  const m = (hex: string) => {
    if (!mat.has(hex)) mat.set(hex, new MeshStandardMaterial({ color: new Color(hex), roughness: 0.8 }));
    return mat.get(hex)!;
  };
  for (const s of b.statics) {
    const mesh = new Mesh(new BoxGeometry(...s.size), m(SURFACE[s.surf] ?? "#666a78"));
    mesh.position.set(...s.pos);
    mesh.name = s.id;
    mesh.userData = { ghostrun: "static", surface: s.surf, zone: s.zone };
    root.add(mesh);
  }
  for (const e of b.entities) {
    const [w, h, d] = e.size;
    const geo = e.kind === "npc" ? new CapsuleGeometry(Math.min(w, d) / 2, Math.max(0.01, h - Math.min(w, d)), 4, 12) : e.shape === "sphere" ? new SphereGeometry(Math.max(w, h, d) / 2, 16, 12) : new BoxGeometry(w, h, d);
    const mesh = new Mesh(geo, m(KIND[e.kind] ?? "#9aa0b5"));
    mesh.position.set(...e.pos);
    mesh.name = e.id;
    mesh.userData = { ghostrun: "entity", kind: e.kind, noun: e.noun, zone: e.zone, team: e.team, body: e.body, verbs: b.verbs.filter((v) => v.on === e.id).map((v) => v.verb) };
    root.add(mesh);
  }
  const out = await new GLTFExporter().parseAsync(root, { binary: true });
  return out as ArrayBuffer;
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** What the export menu offers: everything, or one of the three files. */
export type ExportKind = "all" | "glb" | "logic" | "report";

/** The file name a world exports under: its prompt, made safe. */
export const exportSlug = (prompt: string) => (prompt || "world").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "world";

export async function exportWorld(kind: ExportKind, b: WorldBundle, spec: string, receipt: Receipt | null, report: Omit<ReportInput, "bundle" | "spec" | "receipt">) {
  const slug = exportSlug(report.prompt);
  if (kind === "all" || kind === "glb") download(`${slug}.glb`, await gltf(b), "model/gltf-binary");
  if (kind === "all" || kind === "logic") download(`${slug}.logic.json`, JSON.stringify(logicJson(b, spec, receipt), null, 2), "application/json");
  if (kind === "all" || kind === "report") download(`${slug}.report.html`, reportHtml({ bundle: b, spec, receipt, ...report }), "text/html");
}
