// Id-addressed JSON-Patch (RFC 6902 subset: add/remove/replace/test, no move/copy) over the IR.
// Collections are addressed by record id, never by array index, so concurrent edits from
// different origins (user, AI fill, repair, director…) cannot shift each other's targets.
import * as v from "valibot";
import { canonical } from "./hash";
import { clampLaws } from "./laws";
import { COLLECTIONS, type Collection, WorldBundle } from "./schema";
import { AI_ORIGINS, type Origin } from "./vocab";

export type PatchOp =
  | { op: "add" | "replace" | "test"; path: string; value: unknown }
  | { op: "remove"; path: string };

export class PatchError extends Error {
  constructor(message: string, readonly op?: PatchOp) {
    super(message);
  }
}

const COLLECTION_SET = new Set<string>(COLLECTIONS);
const COSMETIC_COLLECTIONS = new Set(["dress", "posters"]);

type Json = Record<string, unknown> | unknown[];

function parsePath(path: string): string[] {
  if (!path.startsWith("/")) throw new PatchError(`path must start with '/': ${path}`);
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function findById(arr: unknown[], id: string, path: string): number {
  const i = arr.findIndex((r) => (r as { id?: string }).id === id);
  if (i < 0) throw new PatchError(`no record '${id}' at ${path}`);
  return i;
}

/** Resolve a path to [container, key] inside the draft, addressing records by id. */
function locate(draft: WorldBundle, segs: string[], path: string): [Json, string | number] {
  let node: unknown = draft;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const idAddressed =
      (i === 1 && COLLECTION_SET.has(segs[0]!)) || (i === 2 && segs[0] === "cosmetic" && COSMETIC_COLLECTIONS.has(segs[1]!));
    if (Array.isArray(node)) {
      node = idAddressed ? node[findById(node, seg, path)] : node[Number(seg)];
    } else if (node && typeof node === "object") {
      node = (node as Record<string, unknown>)[seg];
    } else {
      node = undefined;
    }
    if (node === undefined) throw new PatchError(`path not found: ${path}`);
  }
  const last = segs[segs.length - 1]!;
  const idAddressed =
    (segs.length === 2 && COLLECTION_SET.has(segs[0]!)) ||
    (segs.length === 3 && segs[0] === "cosmetic" && COSMETIC_COLLECTIONS.has(segs[1]!));
  if (Array.isArray(node)) {
    if (last === "-") return [node, node.length];
    if (idAddressed) return [node, last]; // resolved by id in applyOp
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx > node.length) throw new PatchError(`bad index in ${path}`);
    return [node, idx];
  }
  if (!node || typeof node !== "object") throw new PatchError(`path not found: ${path}`);
  return [node as Json, last];
}

const deepEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function applyOp(draft: WorldBundle, op: PatchOp): string | undefined {
  const segs = parsePath(op.path);
  const top = segs[0]!;
  if (!(COLLECTION_SET.has(top) || top === "laws" || top === "cosmetic" || top === "pack" || top === "mode")) {
    throw new PatchError(`not patchable: /${top}`, op);
  }
  if (segs.length === 1) {
    if (op.op !== "replace" && op.op !== "test") throw new PatchError(`only replace/test at /${top}`, op);
    if (op.op === "test") {
      if (!deepEqual((draft as Record<string, unknown>)[top], op.value)) throw new PatchError(`test failed: ${op.path}`, op);
    } else (draft as Record<string, unknown>)[top] = structuredClone(op.value);
    return undefined;
  }
  const [container, key] = locate(draft, segs, op.path);
  const touched = COLLECTION_SET.has(top) ? segs[1] : undefined;

  if (Array.isArray(container) && typeof key === "string") {
    // id-addressed record in a collection
    const exists = container.findIndex((r) => (r as { id?: string }).id === key);
    switch (op.op) {
      case "add": {
        if (exists >= 0) throw new PatchError(`record '${key}' already exists`, op);
        if ((op.value as { id?: string })?.id !== key) throw new PatchError(`value.id must equal '${key}'`, op);
        container.push(structuredClone(op.value));
        break;
      }
      case "remove":
        if (exists < 0) throw new PatchError(`no record '${key}'`, op);
        container.splice(exists, 1);
        break;
      case "replace":
        if (exists < 0) throw new PatchError(`no record '${key}'`, op);
        if ((op.value as { id?: string })?.id !== key) throw new PatchError(`value.id must equal '${key}'`, op);
        container[exists] = structuredClone(op.value);
        break;
      case "test":
        if (exists < 0 || !deepEqual(container[exists], op.value)) throw new PatchError(`test failed: ${op.path}`, op);
        break;
    }
    return touched;
  }

  if (Array.isArray(container)) {
    const idx = key as number;
    switch (op.op) {
      case "add":
        container.splice(idx, 0, structuredClone(op.value));
        break;
      case "remove":
        if (idx >= container.length) throw new PatchError(`no element ${idx}`, op);
        container.splice(idx, 1);
        break;
      case "replace":
        if (idx >= container.length) throw new PatchError(`no element ${idx}`, op);
        container[idx] = structuredClone(op.value);
        break;
      case "test":
        if (!deepEqual(container[idx], op.value)) throw new PatchError(`test failed: ${op.path}`, op);
        break;
    }
    return touched;
  }

  const obj = container as Record<string, unknown>;
  const k = key as string;
  switch (op.op) {
    case "add":
    case "replace":
      if (op.op === "replace" && !(k in obj)) throw new PatchError(`no field '${k}'`, op);
      obj[k] = structuredClone(op.value);
      break;
    case "remove":
      if (!(k in obj)) throw new PatchError(`no field '${k}'`, op);
      delete obj[k];
      break;
    case "test":
      if (!deepEqual(obj[k], op.value)) throw new PatchError(`test failed: ${op.path}`, op);
      break;
  }
  return touched;
}

export interface IrStore {
  get(path: string): unknown;
  apply(ops: PatchOp[], origin: Origin): void;
  compile(): WorldBundle;
  touched(origin: Origin): ReadonlySet<string>;
}

/** Plain in-memory store. YStore (Yjs, client only) must be observably identical. */
export class JsonStore implements IrStore {
  #b: WorldBundle;
  #touched = new Map<Origin, Set<string>>();

  constructor(bundle: WorldBundle) {
    this.#b = v.parse(WorldBundle, structuredClone(bundle));
    this.#b.laws = clampLaws(this.#b.laws);
  }

  get(path: string): unknown {
    const segs = parsePath(path);
    if (segs.length === 1) return structuredClone((this.#b as Record<string, unknown>)[segs[0]!]);
    const [container, key] = locate(this.#b, segs, path);
    if (Array.isArray(container) && typeof key === "string") {
      return structuredClone(container[findById(container, key, path)]);
    }
    return structuredClone((container as Record<string | number, unknown>)[key]);
  }

  /** Atomic: either every op applies and the result validates, or nothing changes. */
  apply(ops: PatchOp[], origin: Origin): void {
    if (AI_ORIGINS.includes(origin)) {
      const bad = ops.find((o) => o.path.startsWith("/expects"));
      if (bad) throw new PatchError(`origin '${origin}' may not write /expects`, bad);
    }
    const draft = structuredClone(this.#b);
    const touched: string[] = [];
    for (const op of ops) {
      const t = applyOp(draft, op);
      if (t) touched.push(t);
    }
    const parsed = v.safeParse(WorldBundle, draft);
    if (!parsed.success) {
      const issue = parsed.issues[0]!;
      throw new PatchError(`invalid after patch at ${v.getDotPath(issue) ?? "?"}: ${issue.message}`);
    }
    parsed.output.laws = clampLaws(parsed.output.laws);
    this.#b = parsed.output;
    let set = this.#touched.get(origin);
    if (!set) this.#touched.set(origin, (set = new Set()));
    for (const t of touched) set.add(t);
  }

  compile(): WorldBundle {
    return canonical(structuredClone(this.#b));
  }

  touched(origin: Origin): ReadonlySet<string> {
    return this.#touched.get(origin) ?? new Set();
  }
}

export const isCollection = (s: string): s is Collection => COLLECTION_SET.has(s);
