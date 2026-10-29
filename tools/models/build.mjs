// Rebuilds apps/web/public/models/ from the CC0 KayKit packs that provenance.json lists.
//
//   node tools/models/build.mjs <packs dir>
//
// <packs dir> holds each pack's repository as GitHub zips it (KayKit-…-1.0-main/). The downloads are
// only ever read as data: a GLB's JSON is cut here (clips, held weapons, a character's parts joined
// into one skinned draw), then glTF Transform (pinned, through pnpm dlx) prunes, resamples,
// quantises and meshopt-compresses it and re-encodes its texture as WebP.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GLTF_TRANSFORM = "@gltf-transform/cli@4.5.1";
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../../apps/web/public/models");
const packs = process.argv[2];
if (!packs) throw new Error("usage: node tools/models/build.mjs <packs dir>");

const ADV = "KayKit-Character-Pack-Adventures-1.0-main/addons/kaykit_character_pack_adventures";
const SKEL = "KayKit-Character-Pack-Skeletons-1.0-main/addons/kaykit_character_pack_skeletons";
const DUN = "KayKit-Dungeon-Remastered-1.0-main/addons/kaykit_dungeon_remastered/Assets/gltf";
const FUR = "KayKit-Furniture-Bits-1.0-main/addons/kaykit_furniture_bits/Assets/gltf";
const HAL = "KayKit-Halloween-Bits-1.0-main/addons/kaykit_halloween_bits/Assets/gltf";
const PRO = "KayKit-Prototype-Bits-1.0-main/addons/kaykit_prototype_bits/Assets/gltf";
const CITY = "KayKit-City-Builder-Bits-1.0-main/addons/kaykit_city_builder_bits/Assets/gltf";
const HEX = "KayKit-Medieval-Hexagon-Pack-1.0-main/addons/kaykit_medieval_hexagon_pack/Assets/gltf";

/** The clips every character shares (one rig, Rig_Medium): cut from the knight's file. */
const CLIPS = [
  "Idle", "Walking_A", "Running_A", "Jump_Start", "Jump_Idle", "Jump_Land", "Interact", "Hit_A",
  "Death_A", "Cheer", "Spellcast_Shoot", "1H_Ranged_Shoot", "Unarmed_Melee_Attack_Punch_A",
];

/** Bones of the rig that only steer others in Blender (IK targets, foot roll). */
const RIG_CONTROLS = /IK|^control-/;

/** Weapons and shields the packs pose in the hands: the characters walk in empty-handed. */
const HELD = /^(1H_|2H_|Knife|Throwable|Spellbook|Mug$|.*Shield$)/;

const characters = [
  { id: "knight", from: `${ADV}/Characters/gltf/Knight.glb` },
  { id: "rogue", from: `${ADV}/Characters/gltf/Rogue_Hooded.glb` },
  { id: "mage", from: `${ADV}/Characters/gltf/Mage.glb` },
  { id: "barbarian", from: `${ADV}/Characters/gltf/Barbarian.glb` },
  // the undead keep their own shamble
  { id: "skeleton", from: `${SKEL}/Characters/gltf/Skeleton_Minion.glb`, clips: ["Walking_D_Skeletons"] },
];

/** Props by id: the file each one is cut from (render/props.ts says which nouns pick them). */
const props = {
  key: `${DUN}/key.gltf.glb`,
  coin: `${DUN}/coin.gltf.glb`,
  coins: `${DUN}/coin_stack_medium.gltf.glb`,
  chest: `${DUN}/chest_gold.glb`,
  crate: `${HEX}/decoration/props/crate_A_big.gltf`,
  barrel: `${DUN}/barrel_large.gltf.glb`,
  sack: `${HEX}/decoration/props/sack.gltf`,
  banner_red: `${DUN}/banner_patternA_red.gltf.glb`,
  banner_blue: `${DUN}/banner_patternA_blue.gltf.glb`,
  flag: `${HEX}/decoration/props/flag_yellow.gltf`,
  flag_red: `${HEX}/decoration/props/flag_red.gltf`,
  flag_blue: `${HEX}/decoration/props/flag_blue.gltf`,
  trophy: `${DUN}/sword_shield_gold.gltf.glb`,
  potion: `${DUN}/bottle_A_labeled_green.gltf.glb`,
  candle: `${DUN}/candle_triple.gltf.glb`,
  torch: `${DUN}/torch_lit.gltf.glb`,
  bookcase: `${FUR}/shelf_B_large_decorated.gltf`,
  table: `${FUR}/table_medium.gltf`,
  chair: `${FUR}/chair_A.gltf`,
  lamp: `${FUR}/lamp_standing.gltf`,
  lantern: `${HAL}/lantern_standing.gltf`,
  pumpkin: `${HAL}/pumpkin_orange_jackolantern.gltf`,
  gravestone: `${HAL}/gravestone.gltf`,
  skull: `${HAL}/skull.gltf`,
  gate: `${HAL}/fence_gate.gltf`,
  door: `${PRO}/Door_A.gltf`,
  target: `${HEX}/decoration/props/target.gltf`,
  tree: `${HEX}/decoration/nature/tree_single_B.gltf`,
  rock: `${HEX}/decoration/nature/rock_single_C.gltf`,
  bush: `${CITY}/bush.gltf`,
  sword: `${ADV}/Assets/gltf/sword_1handed.gltf`,
  wand: `${ADV}/Assets/gltf/wand.gltf`,
  staff: `${ADV}/Assets/gltf/staff.gltf`,
  crossbow: `${ADV}/Assets/gltf/crossbow_1handed.gltf`,
  shield: `${ADV}/Assets/gltf/shield_round_color.gltf`,
  book: `${ADV}/Assets/gltf/spellbook_closed.gltf`,
  mug: `${ADV}/Assets/gltf/mug_full.gltf`,
  bomb: `${ADV}/Assets/gltf/smokebomb.gltf`,
};

// ---- GLB/glTF JSON cuts (no third-party code touches the downloads before glTF Transform) ------

const pad4 = (b, fill = 0) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);

/** A GLB, or a .gltf with its external buffers and images folded into one binary chunk. */
function load(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) === 0x46546c67) {
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
    const binAt = 20 + jsonLen;
    return { json, bin: binAt < buf.length ? buf.subarray(binAt + 8, binAt + 8 + buf.readUInt32LE(binAt)) : Buffer.alloc(0) };
  }
  const json = JSON.parse(buf.toString("utf8"));
  const parts = [];
  let at = 0;
  const add = (data) => {
    const o = at;
    parts.push(pad4(data));
    at += pad4(data).length;
    return o;
  };
  const offsets = (json.buffers ?? []).map((b) => add(readFileSync(join(dirname(path), decodeURIComponent(b.uri)))));
  for (const v of json.bufferViews ?? []) {
    v.byteOffset = (v.byteOffset ?? 0) + offsets[v.buffer];
    v.buffer = 0;
  }
  for (const img of json.images ?? []) {
    if (!img.uri || img.uri.startsWith("data:")) continue;
    const data = readFileSync(join(dirname(path), decodeURIComponent(img.uri)));
    json.bufferViews.push({ buffer: 0, byteOffset: add(data), byteLength: data.length });
    img.bufferView = json.bufferViews.length - 1;
    img.mimeType = img.uri.endsWith(".png") ? "image/png" : "image/jpeg";
    delete img.uri;
  }
  return { json, bin: Buffer.concat(parts) };
}

function pack({ json, bin }) {
  json.buffers = bin.length ? [{ byteLength: bin.length }] : [];
  const jsonPad = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const binPad = pad4(bin);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jsonPad.length + (binPad.length ? 8 + binPad.length : 0), 8);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([head, chunk(0x4e4f534a, jsonPad), ...(binPad.length ? [chunk(0x004e4942, binPad)] : [])]);
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const ARRAYS = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

/** An accessor's elements as a flat typed array (strided views unpacked). */
function read({ json, bin }, index) {
  const a = json.accessors[index];
  const v = json.bufferViews[a.bufferView];
  const Arr = ARRAYS[a.componentType];
  const n = COMPONENTS[a.type];
  const out = new Arr(a.count * n);
  const size = Arr.BYTES_PER_ELEMENT;
  const stride = v.byteStride ?? n * size;
  const base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const get = { 5121: (o) => dv.getUint8(o), 5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true) }[a.componentType];
  for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = get(base + i * stride + c * size);
  return out;
}

/** Appends a typed array as a new accessor; returns its index. */
function write(g, arr, type, componentType) {
  const n = COMPONENTS[type];
  g.json.bufferViews.push({ buffer: 0, byteOffset: g.bin.length, byteLength: arr.byteLength });
  g.bin = Buffer.concat([g.bin, pad4(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))]);
  const acc = { bufferView: g.json.bufferViews.length - 1, componentType, count: arr.length / n, type };
  if (type === "VEC3") {
    acc.min = [Infinity, Infinity, Infinity];
    acc.max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < arr.length; i++) {
      acc.min[i % 3] = Math.min(acc.min[i % 3], arr[i]);
      acc.max[i % 3] = Math.max(acc.max[i % 3], arr[i]);
    }
  }
  g.json.accessors.push(acc);
  return g.json.accessors.length - 1;
}

// column-major 4×4 matrices, glTF's layout
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
/** Inverse of an affine matrix (rotation·scale plus translation): what an inverse bind matrix inverts to. */
function invertAffine(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const r = [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
  const [tx, ty, tz] = [m[12], m[13], m[14]];
  return [
    r[0], r[3], r[6], 0,
    r[1], r[4], r[7], 0,
    r[2], r[5], r[8], 0,
    -(r[0] * tx + r[1] * ty + r[2] * tz), -(r[3] * tx + r[4] * ty + r[5] * tz), -(r[6] * tx + r[7] * ty + r[8] * tz), 1,
  ];
}
function local(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/**
 * One draw per material for a whole character: every skinned part, and every rigid part riding a
 * bone (a helmet on the head, a cape on the chest), joined into one skinned primitive. A rigid part
 * is baked into the bind pose and weighted fully to its bone, so it moves exactly as it did.
 */
function mergeSkinned(g) {
  const j = g.json;
  const skin = j.skins?.[0];
  if (!skin) return;
  const ibm = read(g, skin.inverseBindMatrices);
  const parentOf = new Map();
  j.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));
  const parts = [];
  j.nodes.forEach((n, i) => {
    if (n.mesh === undefined) return;
    let bone = -1;
    let m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    if (n.skin === undefined) {
      bone = skin.joints.indexOf(parentOf.get(i));
      if (bone < 0) return; // not riding a bone: left as it is
      m = mul(invertAffine([...ibm.slice(bone * 16, bone * 16 + 16)]), local(n));
    }
    for (const prim of j.meshes[n.mesh].primitives) parts.push({ node: i, prim, bone, m });
  });
  const byMaterial = new Map();
  for (const p of parts) byMaterial.set(p.prim.material, [...(byMaterial.get(p.prim.material) ?? []), p]);
  const prims = [];
  for (const [material, group] of byMaterial) {
    const pos = [], nor = [], uv = [], jnt = [], wgt = [], idx = [];
    for (const { prim, bone, m } of group) {
      const base = pos.length / 3;
      const P = read(g, prim.attributes.POSITION);
      const N = read(g, prim.attributes.NORMAL);
      const T = read(g, prim.attributes.TEXCOORD_0);
      const count = P.length / 3;
      for (let v = 0; v < count; v++) {
        const [x, y, z] = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
        pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        const [a, b, c] = [N[v * 3], N[v * 3 + 1], N[v * 3 + 2]];
        const [nx, ny, nz] = [m[0] * a + m[4] * b + m[8] * c, m[1] * a + m[5] * b + m[9] * c, m[2] * a + m[6] * b + m[10] * c];
        const l = Math.hypot(nx, ny, nz) || 1;
        nor.push(nx / l, ny / l, nz / l);
        uv.push(T[v * 2], T[v * 2 + 1]);
      }
      if (bone < 0) {
        jnt.push(...read(g, prim.attributes.JOINTS_0));
        wgt.push(...read(g, prim.attributes.WEIGHTS_0));
      } else {
        for (let v = 0; v < count; v++) {
          jnt.push(bone, 0, 0, 0);
          wgt.push(1, 0, 0, 0);
        }
      }
      for (const k of read(g, prim.indices)) idx.push(base + k);
    }
    const big = pos.length / 3 > 65535;
    prims.push({
      attributes: {
        POSITION: write(g, new Float32Array(pos), "VEC3", 5126),
        NORMAL: write(g, new Float32Array(nor), "VEC3", 5126),
        TEXCOORD_0: write(g, new Float32Array(uv), "VEC2", 5126),
        JOINTS_0: write(g, new Uint8Array(jnt), "VEC4", 5121),
        WEIGHTS_0: write(g, new Float32Array(wgt), "VEC4", 5126),
      },
      indices: write(g, big ? new Uint32Array(idx) : new Uint16Array(idx), "SCALAR", big ? 5125 : 5123),
      material,
    });
  }
  const first = parts.find((p) => p.bone < 0).node;
  for (const { node } of parts) {
    delete j.nodes[node].mesh;
    delete j.nodes[node].skin;
  }
  j.meshes.push({ name: "body", primitives: prims });
  j.nodes[first].mesh = j.meshes.length - 1;
  j.nodes[first].skin = 0;
}

/**
 * Keeps the named clips (none by default), drops meshes from the nodes `drop` matches (all, for a
 * clips-only file), and joins what is left of a character into one skinned draw.
 */
function cut(src, { clips = [], drop = null, meshes = true, merge = false } = {}) {
  const g = load(src);
  const j = g.json;
  j.animations = (j.animations ?? []).filter((a) => clips.includes(a.name));
  // the rig's IK and roll controls weigh no vertex, and no bone scales: their channels are dead weight
  for (const a of j.animations) a.channels = a.channels.filter((c) => c.target.path !== "scale" && !RIG_CONTROLS.test(j.nodes[c.target.node].name ?? ""));
  if (!j.animations.length) delete j.animations;
  for (const n of j.nodes ?? []) {
    if (n.mesh === undefined) continue;
    if (!meshes || (drop && drop.test(n.name ?? ""))) {
      delete n.mesh;
      delete n.skin;
    }
  }
  if (!meshes) delete j.skins;
  if (merge) mergeSkinned(g);
  return pack(g);
}

// ---- glTF Transform ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "ghostrun-models-"));
const gt = (...args) => execFileSync("pnpm", ["dlx", GLTF_TRANSFORM, ...args], { stdio: ["ignore", "ignore", "inherit"] });

function emit(id, glb, { textureSize = 256, flat = true } = {}) {
  const raw = join(tmp, `${id.replace("/", "_")}.raw.glb`);
  writeFileSync(raw, glb);
  const out = join(OUT, `${id}.glb`);
  mkdirSync(dirname(out), { recursive: true });
  // characters keep their node tree (the bones); props flatten and join into as few draws as their
  // materials allow
  gt("optimize", raw, out,
    "--compress", "meshopt", "--texture-compress", "webp", "--texture-size", String(textureSize),
    "--simplify", "false", "--instance", "false", "--palette", "false",
    "--flatten", String(flat), "--join", String(flat), "--join-named", String(flat));
  return statSync(out).size;
}

// ---- provenance --------------------------------------------------------------------------------

/** Where each pack came from: KayKit's own repositories (the zip GitHub serves for the main branch). */
const REPO = (dir) => `https://github.com/KayKit-Game-Assets/${dir.replace(/-main$/, "")}`;

/** A pack's bundled licence, checked: anything but CC0 stops the build. */
function licence(dir) {
  const base = join(packs, dir, "addons");
  const sub = readdirSync(base).find((d) => !d.startsWith(".")) ?? "";
  const file = [join(base, sub, "LICENSE.txt"), join(base, sub, "Assets", "LICENSE.txt")].find((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });
  const text = readFileSync(file, "utf8");
  if (!/License: \(Creative Commons Zero, CC0\)/.test(text)) throw new Error(`${dir}: not CC0`);
  const line = (re) => text.split("\n").map((l) => l.trim()).find((l) => re.test(l)) ?? "";
  return { title: line(/^KayKit/), created: line(/^Creation date/).replace("Creation date: ", ""), licenceFile: file.slice(join(packs, dir).length + 1) };
}

rmSync(OUT, { recursive: true, force: true });
const sizes = {};
const made = [];
const record = (id, from, cutNote) => made.push({ file: `models/${id}.glb`, bytes: sizes[id], pack: from.split("/")[0], from: from.split("/").slice(1).join("/"), cut: cutNote });
sizes.anims = emit("anims", cut(join(packs, characters[0].from), { clips: CLIPS, meshes: false }), { flat: false });
record("anims", characters[0].from, `clips only: ${CLIPS.join(", ")}`);
for (const c of characters) {
  sizes[c.id] = emit(c.id, cut(join(packs, c.from), { clips: c.clips ?? [], drop: HELD, merge: true }), { flat: false });
  record(c.id, c.from, `mesh and rig${c.clips ? `, own clips ${c.clips.join(", ")}` : ""}; held weapons removed; parts joined into one skinned draw`);
}
for (const [id, from] of Object.entries(props)) {
  sizes[`props/${id}`] = emit(`props/${id}`, cut(join(packs, from)), { textureSize: 128 });
  record(`props/${id}`, from, "as is");
}
rmSync(tmp, { recursive: true, force: true });

const used = [...new Set(made.map((m) => m.pack))];
writeFileSync(join(OUT, "provenance.json"), `${JSON.stringify({
  about: "Third-party 3D models in this folder: what each file is, where it came from and under which licence. Rebuilt by tools/models/build.mjs.",
  author: "Kay Lousberg (www.kaylousberg.com)",
  licence: "CC0-1.0 (Creative Commons Zero 1.0 Universal, https://creativecommons.org/publicdomain/zero/1.0/), as each pack's bundled LICENSE.txt states",
  downloaded: "2026-10-29",
  optimised: `${GLTF_TRANSFORM} optimize: prune, resample, quantise, meshopt compression, textures to WebP (256 px characters, 128 px props)`,
  packs: used.map((dir) => ({ pack: dir, ...licence(dir), source: REPO(dir), download: `https://codeload.github.com/KayKit-Game-Assets/${dir.replace(/-main$/, "")}/zip/refs/heads/main` })),
  files: made,
}, null, 2)}\n`);
const sum = (pick) => Object.entries(sizes).filter(([k]) => pick(k)).reduce((s, [, v]) => s + v, 0);
for (const [k, v] of Object.entries(sizes)) console.log(`${k.padEnd(18)} ${(v / 1024).toFixed(1).padStart(7)} KB`);
console.log(`characters + clips ${(sum((k) => !k.startsWith("props/")) / 1024).toFixed(1)} KB, props ${(sum((k) => k.startsWith("props/")) / 1024).toFixed(1)} KB`);
