// Export a world to take elsewhere: geometry as glTF (named by id, with kind, noun, zone and verbs
// in each node's extras), the logic as logic.json in triggers / states / rules terms (each rule as
// a sentence and as data, with its proof status), and the receipt as a standalone HTML report.
import type { Rule, WorldBundle } from "@ghostrun/ir";
import { verb } from "@ghostrun/kits";
import { chipLine, type Receipt } from "@ghostrun/proof";
import { BoxGeometry, CapsuleGeometry, Color, Group, Mesh, MeshStandardMaterial, SphereGeometry } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const SURFACE: Record<string, string> = { floor: "#5b5f6e", wall: "#30323d", ledge: "#7a7f95", roof: "#7a7f95", glass: "#9fd6ff", water: "#3a86c8", hazard: "#ff4a1c" };
const KIND: Record<string, string> = { pickup: "#ffe45c", goal: "#3dffa8", hazard: "#ff4a1c", door: "#8a6a4a", switch: "#19e3ff", plate: "#ffb02e", npc: "#ff3b5c", portal: "#ff2bd6", checkpoint: "#ffb02e", spawn: "#ffffff" };

const name = (b: WorldBundle, id: string) => (id.startsWith("team:") ? `${id.slice(5)} team` : b.entities.find((e) => e.id === id)?.noun || id.replace(/_/g, " "));

/** A rule as one readable sentence (the same reading as the Logic X-ray). */
export function sentence(b: WorldBundle, r: Rule): string {
  const w = r.when;
  const n = (id: string) => (id ? name(b, id) : "anything");
  const when =
    w.t === "score_gte" ? `${n(w.a)} reaches ${w.n}` : w.t === "state_is" ? `${n(w.a)} becomes ${w.s}` : w.t === "timer_end" ? "the timer runs out" : w.t === "every" ? `every ${w.n} s` : `${n(w.a)} ${w.t.replace("_", " ")}s ${n(w.b)}`;
  const iff = r.if.map((c) => `${n(c.l.split(".")[0]!)} ${c.l.split(".").slice(1).join(" ")} ${c.op} ${String(c.r)}`).join(" and ");
  const then = r.then
    .map((e) => (e.e === "score" ? `+${e.n || 1} ${n(e.target)}` : e.e === "win" || e.e === "lose" ? `you ${e.e}` : e.e === "set_state" ? `${n(e.target)} becomes ${String(e.v)}` : e.e === "emit" ? `effect ${e.fx}` : `${e.e} ${n(e.target)}`))
    .join(", ");
  return `WHEN ${when}${iff ? ` IF ${iff}` : ""} THEN ${then}${r.once ? " (once)" : ""}`;
}

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

function report(b: WorldBundle, spec: string, receipt: Receipt | null, prompt: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const chips = receipt ? receipt.chips.map((c) => `<li class="${c.status}">${esc(chipLine(c))}</li>`).join("") : "<li>not proved yet</li>";
  const rules = b.rules.map((r) => `<li>${esc(sentence(b, r))}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GHOSTRUN playtest report</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1b1d2b;background:#fafafa}h1{font-size:22px}code{font-size:12px}li{margin:4px 0}.counterexample{color:#b3123b}.verified,.played{color:#0b7a4b}.not_checkable{color:#777}</style></head><body>
<h1>Playtest report</h1><p><b>Prompt:</b> ${esc(prompt)}</p><p><b>Spec</b> <code>${spec}</code> · ${esc(b.pack.id)} · ${esc(b.mode)}</p>
${receipt?.headline ? `<p><b>Headline:</b> ${esc(receipt.headline.text)} — <b>${esc(receipt.headline.status.replace("_", " "))}</b> (${esc(receipt.headline.method)})</p>` : ""}
${receipt?.par ? `<p><b>AI par:</b> ${receipt.par.goldS} s · ${receipt.par.won} of ${receipt.par.runs} AI runners won</p>` : ""}
<h2>Receipt</h2><ul>${chips}</ul><h2>Rules</h2><ul>${rules}</ul>
<p style="color:#777;font-size:13px">Every number names its method; fewer than 30 trials print as "k of n". Generated by GHOSTRUN.</p></body></html>`;
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function exportWorld(b: WorldBundle, spec: string, receipt: Receipt | null, prompt: string) {
  const slug = (prompt || "world").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "world";
  download(`${slug}.glb`, await gltf(b), "model/gltf-binary");
  download(`${slug}.logic.json`, JSON.stringify(logicJson(b, spec, receipt), null, 2), "application/json");
  download(`${slug}.report.html`, report(b, spec, receipt, prompt), "text/html");
}
