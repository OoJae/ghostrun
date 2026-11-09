// The playtest report as one self-contained HTML file: no external requests (inline CSS, the map an
// inline SVG, no scripts), readable offline and printable. It says what the receipt says, in the
// receipt's own words (every line from @ghostrun/proof's labels, English, each number with its
// method; fewer than 30 trials as "k of n"): the prompt, the headline and every chip, the difficulty
// band, what the AI runners revealed (the heat map with the experts' routes and the places runs went
// wrong drawn on the ground, where the time went, the fights, the pacing, what nobody went near, the
// design notes), Feng Shui when the world has it, the rules, the spec and engine hashes, and the
// share link that plays the world again.
import type { FengShuiSection } from "@ghostrun/layout";
import { FENG_SHUI_RULES, FENG_SHUI_SCHOOL_SOURCE } from "@ghostrun/layout";
import type { WorldBundle } from "@ghostrun/ir";
import type { Homage } from "@ghostrun/llm/homage";
import { allRuns, bandLine, chipLineAt, crossLine, failLine, fengShuiFix, fengShuiHead, fengShuiWhy, fightLine, fraction, insights, paceLine, revealed, statusWord, timesLine, type CrossCheck, type Receipt, type Revealed } from "@ghostrun/proof/light";
import { sentence } from "./host";
import { designNotes } from "./notes";

export interface ReportInput {
  bundle: WorldBundle;
  spec: string;
  engine: string;
  receipt: Receipt | null;
  /** The prompt as the person wrote it (the world was built from its homage, when it named a brand). */
  prompt: string;
  homages?: readonly Homage[];
  fengShui?: FengShuiSection | null;
  /** Where the receipt was proved, and whether the cloud and this device agreed. */
  cross?: CrossCheck;
  /** The world's share link (plays it again from the top), or null when none could be made. */
  link: string | null;
  /** When the report was made (ISO), for its footer. */
  at?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const r1 = (x: number) => Math.round(x * 10) / 10;
const TONE: Record<string, string> = { holds: "verified", fails: "counterexample", not_checkable: "not_checkable" };

/**
 * The ground seen from above, with where the AI runners spent their time (the heat map, every run
 * at every level), the experts' routes (green won, red didn't) and the places runs went wrong
 * (numbered as in the list). x runs left to right, z top to bottom; 1 unit is 1 m.
 */
export function heatMapSvg(b: WorldBundle, receipt: Receipt, rv: Revealed): string {
  const ground = b.statics.filter((s) => s.surf !== "wall");
  const xs = [...b.statics.flatMap((s) => [s.pos[0] - s.size[0] / 2, s.pos[0] + s.size[0] / 2]), ...b.entities.map((e) => e.pos[0])];
  const zs = [...b.statics.flatMap((s) => [s.pos[2] - s.size[2] / 2, s.pos[2] + s.size[2] / 2]), ...b.entities.map((e) => e.pos[2])];
  if (!xs.length) return "";
  const pad = 2;
  const [x0, x1, z0, z1] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...zs) - pad, Math.max(...zs) + pad];
  const [w, h] = [r1(x1 - x0), r1(z1 - z0)];
  const rect = (s: (typeof b.statics)[number], fill: string) => `<rect x="${r1(s.pos[0] - s.size[0] / 2)}" y="${r1(s.pos[2] - s.size[2] / 2)}" width="${r1(s.size[0])}" height="${r1(s.size[2])}" fill="${fill}"/>`;
  // lower ground first, so a ledge or a roof draws over the street under it
  const floors = [...ground].sort((p, q) => p.pos[1] - q.pos[1]).map((s) => rect(s, s.surf === "hazard" ? "#f4c4b8" : s.surf === "water" ? "#cfe3f5" : s.pos[1] > 0.6 ? "#dcdde6" : "#eceef3"));
  const walls = b.statics.filter((s) => s.surf === "wall").map((s) => rect(s, "#5b5f6e"));
  const c = rv.heat.cell;
  const heat = [];
  for (let i = 0; i + 3 < rv.heat.cells.length; i += 4) {
    const [hx, , hz, wt] = [rv.heat.cells[i]!, rv.heat.cells[i + 1]!, rv.heat.cells[i + 2]!, rv.heat.cells[i + 3]!];
    heat.push(`<rect x="${r1(hx - c / 2)}" y="${r1(hz - c / 2)}" width="${c}" height="${c}" fill="#ff5a1f" fill-opacity="${Math.round((0.12 + 0.78 * wt) * 100) / 100}"/>`);
  }
  const routes = (receipt.trails ?? []).slice(0, 24).map((t) => {
    const pts: string[] = [];
    for (let i = 0; i + 2 < t.xyz.length; i += 3) pts.push(`${r1(t.xyz[i]!)},${r1(t.xyz[i + 2]!)}`);
    return pts.length > 1 ? `<polyline points="${pts.join(" ")}" fill="none" stroke="${t.won ? "#0b7a4b" : "#b3123b"}" stroke-width="0.25" stroke-opacity="0.7" stroke-linejoin="round"/>` : "";
  });
  const marks = b.entities
    .filter((e) => e.kind === "goal" || e.kind === "spawn" || e.kind === "pickup" || e.kind === "npc")
    .filter((e) => !e.tags.includes("bonus"))
    .map((e) => `<circle cx="${r1(e.pos[0])}" cy="${r1(e.pos[2])}" r="0.7" fill="${{ goal: "#3dffa8", spawn: "#ffffff", pickup: "#ffd21f", npc: "#ff3b5c" }[e.kind as "goal"]}" stroke="#1b1d2b" stroke-width="0.2"><title>${esc(e.noun || e.id)}</title></circle>`);
  const fails = rv.fails.map((f, i) => `<g><circle cx="${r1(f.x)}" cy="${r1(f.z)}" r="1.3" fill="#b3123b"/><text x="${r1(f.x)}" y="${r1(f.z + 0.55)}" font-size="1.6" text-anchor="middle" fill="#fff" font-weight="700">${i + 1}</text></g>`);
  const width = 680;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Heat map of where the AI runners went" viewBox="${r1(x0)} ${r1(z0)} ${w} ${h}" width="${width}" height="${Math.round((width * h) / Math.max(1, w))}" style="max-width:100%;height:auto;background:#f7f7fa;border:1px solid #d9dbe3;border-radius:8px">${floors.join("")}${walls.join("")}${heat.join("")}${routes.join("")}${marks.join("")}${fails.join("")}</svg>`;
}

/** The whole report: one HTML document with nothing to fetch. */
export function reportHtml(x: ReportInput): string {
  const { bundle: b, receipt: r } = x;
  const link = x.link && /^https?:\/\//i.test(x.link) ? x.link : null; // a link to follow, never a script
  const rv = r ? revealed(b, r) : null;
  const seen = r?.trails ? insights(b, allRuns(r)) : null;
  const out: string[] = [];
  const p = (html: string, cls = "") => out.push(`<p${cls ? ` class="${cls}"` : ""}>${html}</p>`);
  const list = (items: string[], cls = "") => out.push(`<ul${cls ? ` class="${cls}"` : ""}>${items.join("")}</ul>`);

  out.push(`<h1>Playtest report</h1>`);
  p(`<b>Prompt:</b> ${esc(x.prompt || "(none recorded)")}`);
  if (x.homages?.length) p(esc(`Homage: ${x.homages.map((h) => `'${h.from}' → '${h.to}'`).join(", ")}; we don't use trademarked names. The world was built from the rewritten words.`), "muted");
  p(link ? `<b>Play it:</b> <a href="${esc(link)}">${esc(link)}</a>` : "<b>Play it:</b> no share link (the live service wasn't reachable when this report was made)");
  p(`${esc(b.pack.id)} · ${b.mode === "wander" ? "a place to explore" : "a game"} · seed ${b.seed} · ${b.entities.length} things, ${b.rules.length} rules`, "muted");

  // the receipt: the headline, then every chip with its method
  out.push(`<h2>Receipt</h2>`);
  if (!r) p("Not proved yet: the AI runners hadn't finished when this was exported.");
  else {
    p(esc(x.cross ? crossLine(x.cross) : crossLine({ shown: r.host, cloud: "off", device: "done" })), "muted");
    if (r.headline) p(`<b>Headline:</b> ${esc(r.headline.text)}: <b class="${r.headline.status}">${esc(statusWord(r.headline.status))}</b> <span class="method">(${esc(r.headline.method)})</span>`, "headline");
    list(r.chips.map((c) => `<li class="${c.status}">${esc(chipLineAt(c, r.host))}</li>`), "chips");
    if (r.par) p(esc(`AI par ${r.par.goldS} s · ${fraction(r.par.won, r.par.runs)} AI runners won (physics, ${r.par.runs} AI runners)`));
  }

  // the playtest: how hard, and what the runs revealed
  if (r && (r.playtest || rv)) {
    out.push(`<h2>Difficulty</h2>`);
    p(r.playtest ? `<b>${esc(bandLine(r.playtest, r))}</b>` : "The novice and average AI runners hadn't finished when this was exported.");
    if (rv?.times) p(esc(timesLine(rv.times)));
  }
  if (r && rv) {
    out.push(`<h2>What the AI runners revealed</h2>`);
    p(esc(`${rv.runs} runs at every skill level, ${rv.samples} positions sampled.`), "muted");
    out.push(`<figure>${heatMapSvg(b, r, rv)}<figcaption>Seen from above. Orange: where the runners spent their time (darker is longer). Lines: the expert runners' routes (green won, red didn't). Numbered: where runs went wrong. Dots: the goal (green), the start (white), pickups (yellow), characters (red).</figcaption></figure>`);
    const hot = seen?.hot.filter((h) => h.share >= 0.03 && h.near) ?? [];
    // a share of thousands of positions, so a percentage is fair (as the receipt prints it)
    if (hot.length) p(esc(`Most time: ${hot.map((h) => `near the ${h.near} (${Math.round(h.share * 100)}%)`).join(", ")}`));
    if (rv.fails.length) {
      p("<b>Where runs went wrong:</b>");
      out.push(`<ol>${rv.fails.map((f) => `<li>${esc(failLine(f, rv.runs))}</li>`).join("")}</ol>`);
    }
    if (rv.fights) p(esc(`Fights: ${rv.fights.spots.map(fightLine).join("; ")} (${fightLine(rv.fights)} in all)`));
    if (rv.pace.length) p(esc(`Pacing (median first times): ${paceLine(rv.pace, rv.runs)}`));
    const unused = [...new Set(seen?.unused.map((u) => u.noun) ?? [])];
    p(esc(unused.length ? `Nobody went near: ${unused.map((u) => `the ${u}`).join(", ")}.` : "Every route passed everything there is to use."), unused.length ? "warn" : "");
  }

  // the design notes: each place a change could answer, with the changes it suggests
  const notes = r ? designNotes(b, seen, rv, x.fengShui ?? null) : [];
  if (notes.length) {
    out.push(`<h2>Design notes</h2>`);
    p("Changes a designer could make, each written as it would be typed into “Change it”; in the app, AI runners re-prove a change on a copy before it is offered.", "muted");
    const what = (key: string) => {
      const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      if (kind === "unused") return `Nobody went near the ${seen?.unused.find((u) => u.id === id)?.noun ?? id.replace(/_/g, " ")}`;
      if (kind === "fail" && rv) return `Runs went wrong ${failLine(rv.fails[Number(id)]!, rv.runs)}`;
      if (kind === "fengshui") return `Feng Shui: ${FENG_SHUI_RULES.find((q) => q.id === id)?.name ?? id}`;
      return key;
    };
    list(notes.map((n) => `<li>${esc(what(n.key))}: ${(n.said ?? n.changes).map((c) => `“${esc(c)}”`).join(" or ")}</li>`));
  }

  // Feng Shui, when the world is an interior or asked for it
  const fs = x.fengShui;
  if (fs) {
    out.push(`<h2>Feng Shui</h2>`);
    const tone = !fs.checked ? "not_checkable" : fs.holds === fs.checked ? "verified" : "counterexample";
    p(`<b class="${tone}">${esc(fengShuiHead(fs))}</b> <span class="method">(checked on the placed world: its rooms and doorways, where things stand and what they are named)</span>`);
    list(
      fs.findings.map((f) => {
        const rule = FENG_SHUI_RULES.find((q) => q.id === f.rule);
        const mark = { holds: "✓", fails: "✗", not_checkable: "–" }[f.verdict];
        const src = rule?.sources.map((s) => `<a href="${esc(s.url)}">${esc(`${s.by}, ${s.title}`)}</a>`).join("; ") ?? "";
        return `<li class="${TONE[f.verdict]}">${mark} <b>${esc(rule?.name ?? f.rule)}</b>: ${esc(fengShuiWhy(f))}.${f.fix ? ` Fix: ${esc(fengShuiFix(f.fix))}.` : ""}${src ? ` <span class="muted">Source: ${src}</span>` : ""}</li>`;
      }),
    );
    p(`The ${esc(fs.school)}, the oldest branch of feng shui, reads the shape of a place and how qi flows through it (<a href="${esc(FENG_SHUI_SCHOOL_SOURCE.url)}">${esc(`${FENG_SHUI_SCHOOL_SOURCE.title}, ${FENG_SHUI_SCHOOL_SOURCE.where}`)}</a>). A design reading, not a claim about luck.`, "muted");
  }

  // the rules, as the X-ray says them, each with its proof
  out.push(`<h2>Rules</h2>`);
  const status = (id: string) => r?.chips.find((c) => c.id === `T2:${id}`)?.status;
  list(b.rules.map((rule) => {
    const s = status(rule.id);
    return `<li${s ? ` class="${s}"` : ""}>${esc(sentence(b, rule))}${s ? ` <span class="method">(${esc(statusWord(s))})</span>` : ""}</li>`;
  }));

  out.push(`<h2>Identity</h2>`);
  list([`<li>Spec hash <code>${esc(x.spec)}</code> (the world document: the same hash is the same world)</li>`, `<li>Engine hash <code>${esc(x.engine)}</code> (the placer and simulation it was proved with)</li>`, ...(r ? [`<li>Proved ${esc(r.host === "edge" ? "in the cloud" : r.host === "node" ? "in Node" : "on the player's device")} in ${r.ms} ms</li>`] : [])]);
  p(`Every number names its method; fewer than 30 trials print as “k of n”, never a percentage. Generated by GHOSTRUN${x.at ? ` on ${esc(x.at.slice(0, 10))}` : ""}.`, "muted");

  const css = "body{font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1b1d2b;background:#fafafa}h1{font-size:24px;margin-bottom:8px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid #e3e4ea;padding-bottom:4px}code{font-size:12px;word-break:break-all}li{margin:4px 0}a{color:#2952cc}figure{margin:12px 0}figcaption{font-size:13px;color:#666;margin-top:6px}.muted,.method{color:#6b6e7c;font-size:13px}.counterexample{color:#b3123b}.verified,.played{color:#0b7a4b}.modelled{color:#8a6100}.not_checkable{color:#777}.warn{color:#8a4b00}.chips li{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}@media print{body{margin:0;background:#fff}}";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GHOSTRUN playtest report: ${esc((r?.headline?.text ?? x.prompt).slice(0, 80))}</title><style>${css}</style></head><body>\n${out.join("\n")}\n</body></html>\n`;
}
