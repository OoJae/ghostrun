// A clip of the run. While you play, the canvas (with the game's sound, tapped from the master
// bus) is recorded in short segments and only the last two are kept, so the last ten seconds or
// so are always on hand and memory stays bounded (under 10 MB). When the run ends the segments are joined into one file that
// ends there (webm.ts). Cosmetic and client-only: it reads the canvas and the mix, never the
// simulation. Where the browser can't record a canvas, there are simply no clips.
import { probe } from "./probe";
import { joinWebm, readWebm, type Segment as WebmSegment } from "./webm";

/**
 * How long each recording runs before the next takes over. The last two are kept: 8.5–17 s on
 * hand, so with the tail after the end there are always the ten seconds a clip wants.
 */
export const SEGMENT_MS = 8500;
/** The clip: about the last ten seconds, ending at the win or the loss. */
export const WANT_MS = 10_000;
/** A keyframe this often (where the browser lets us ask), so the clip can start close to ten seconds back. */
const KEY_MS = 2000;
/** Under 10 MB for two segments of video and sound, and the tail. */
const BITS = { video: 4_000_000, audio: 128_000 };

/** One recording: a file of its own, made of the recorder's chunks. */
export interface Segment {
  n: number;
  chunks: Blob[];
  bytes: number;
  /** Time spent recording (not paused). */
  ms: number;
  audio: boolean;
  type: string;
}

/** The segments kept: the newest `keep`, the one recording now among them; older ones are let go. */
export class Segments {
  readonly keep: number;
  readonly #list: Segment[] = [];
  #n = 0;

  constructor(keep = 2) {
    this.keep = Math.max(1, keep);
  }

  start(audio: boolean, type: string): Segment {
    while (this.#list.length >= this.keep) this.#list.shift();
    const s: Segment = { n: this.#n++, chunks: [], bytes: 0, ms: 0, audio, type };
    this.#list.push(s);
    return s;
  }

  /** A recorder's data, kept only while its segment is (a stopped recorder's last chunk can land after it has gone). */
  add(s: Segment, data: Blob) {
    if (!data.size || !this.#list.includes(s)) return;
    s.chunks.push(data);
    s.bytes += data.size;
  }

  get list(): readonly Segment[] {
    return this.#list;
  }

  get bytes(): number {
    return this.#list.reduce((n, s) => n + s.bytes, 0);
  }
}

/** What this browser records into: WebM joins segments; MP4 (Safari before it took WebM) can't. */
export interface Types {
  ext: "webm" | "mp4";
  joinable: boolean;
  video: string;
  /** With the game's sound too (null: video only). */
  sound: string | null;
}

const KINDS = [
  { ext: "webm", joinable: true, video: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"], sound: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"] },
  { ext: "mp4", joinable: false, video: ["video/mp4;codecs=avc1", "video/mp4"], sound: ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4"] },
] as const;

export function pickTypes(ok: (type: string) => boolean): Types | null {
  for (const k of KINDS) {
    const video = k.video.find(ok);
    if (video) return { ext: k.ext, joinable: k.joinable, video, sound: k.sound.find(ok) ?? null };
  }
  return null;
}

/** Clips are on unless ?clip=0; on phones (a coarse pointer) only with ?clip=1, where encoding costs frames and battery. */
export function clipsOn(search: string, coarse: boolean): boolean {
  const p = new URLSearchParams(search).get("clip");
  return p === "1" || (p !== "0" && !coarse);
}

/** "ghostrun-capture-the-flag-0-42.webm": the world in a few words, and the run's clock. */
export function clipName(title: string, ticks: number, ext: string, suffix = ""): string {
  const slug =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40)
      .replace(/^-+|-+$/g, "") || "world";
  const s = Math.floor(Math.max(0, ticks) / 60);
  return `ghostrun-${slug}-${Math.floor(s / 60)}-${String(s % 60).padStart(2, "0")}${suffix ? `-${suffix}` : ""}.${ext}`;
}

export interface Clip {
  blob: Blob;
  ms: number;
  ext: string;
}

type Mode = "off" | "rolling" | "held" | "take";

/**
 * The recorder over one canvas. "rolling" rotates segments and keeps the last two; "take" records
 * one segment until it is cut (a clean replay, saved whole). It pauses while the tab is hidden and
 * while there is no run to record, and a segment starts with sound only while there is sound (not
 * yet started, or muted: video only), so each segment is all one or the other.
 */
export class ClipRecorder {
  readonly types: Types;
  readonly #video: MediaStream;
  readonly #tap: () => MediaStream | null;
  #segs = new Segments();
  #seg: Segment | null = null;
  #rec: MediaRecorder | null = null;
  #mode: Mode = "off";
  /** Why it is paused: the tab is hidden, or no run is on screen. */
  readonly #why = new Set<"hidden" | "idle">();
  #timer: ReturnType<typeof setInterval> | undefined;
  #last = 0;
  #failed = false;
  /** MP4 keeps one segment (they can't be joined here), so it runs twice as long. */
  readonly #segMs: number;

  /** Null where this browser can't record a canvas (no captureStream, no MediaRecorder, no type it records). */
  static create(canvas: HTMLCanvasElement, tap: () => MediaStream | null): ClipRecorder | null {
    const no = () => ((probe().clip = { state: "unsupported", segments: 0, bytes: 0, type: "" }), null);
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function" || typeof canvas.captureStream !== "function") return no();
    const types = pickTypes((t) => MediaRecorder.isTypeSupported(t));
    if (!types) return no();
    try {
      return new ClipRecorder(canvas.captureStream(30), types, tap);
    } catch {
      return no();
    }
  }

  private constructor(video: MediaStream, types: Types, tap: () => MediaStream | null) {
    this.#video = video;
    this.types = types;
    this.#tap = tap;
    this.#segMs = types.joinable ? SEGMENT_MS : 2 * SEGMENT_MS;
    if (document.hidden) this.#why.add("hidden");
    document.addEventListener("visibilitychange", () => this.#pause("hidden", document.hidden));
    this.#report();
  }

  /** Start over: a new run is recorded from here (whatever was kept is let go). */
  start(mode: "rolling" | "take") {
    this.stop();
    if (this.#failed) return;
    this.#mode = mode;
    this.#segs = new Segments(mode === "rolling" && this.types.joinable ? 2 : 1);
    this.#timer = setInterval(() => this.#tick(), 500);
    this.#begin();
  }

  /** Stop and let everything go. */
  stop() {
    this.#mode = "off";
    clearInterval(this.#timer);
    void this.#end();
    this.#segs = new Segments();
    this.#report();
  }

  /**
   * The run is over: the segment recording now runs on to the cut, and no new one starts (one
   * started in the moments after the end would push out the segment that leads up to it).
   */
  hold() {
    if (this.#mode === "rolling") this.#mode = "held";
    this.#report();
  }

  /** No run to record (a world building, a VR session): paused until there is. */
  idle(on: boolean) {
    this.#pause("idle", on);
  }

  /**
   * Stop recording and make the clip: the kept segments joined, the last `wantMs` of them
   * (Infinity: all). MP4 can't be joined here, so there it is the newest segment as recorded.
   */
  async cut(wantMs: number): Promise<Clip | null> {
    const segs = this.#segs;
    this.#mode = "off";
    clearInterval(this.#timer);
    await this.#end();
    this.#report();
    const list = segs.list.filter((s) => s.bytes > 0);
    const newest = list.at(-1);
    if (!newest) return null;
    if (!this.types.joinable) return { blob: new Blob(newest.chunks, { type: newest.type.split(";")[0]! }), ms: newest.ms, ext: this.types.ext };
    const parts: WebmSegment[] = [];
    for (const s of list) {
      const p = readWebm(new Uint8Array(await new Blob(s.chunks).arrayBuffer()));
      if (p) parts.push(p);
    }
    const joined = joinWebm(parts, wantMs);
    return joined && { blob: new Blob([joined.bytes], { type: "video/webm" }), ms: joined.ms, ext: "webm" };
  }

  #begin() {
    const sound = this.types.sound ? (this.#tap()?.getAudioTracks() ?? []) : [];
    const type = sound.length ? this.types.sound! : this.types.video;
    const segs = this.#segs;
    try {
      // (videoKeyFrameIntervalDuration is newer than the DOM types; browsers without it ignore it)
      const opts = { mimeType: type, videoBitsPerSecond: BITS.video, ...(sound.length ? { audioBitsPerSecond: BITS.audio } : {}), videoKeyFrameIntervalDuration: KEY_MS } as MediaRecorderOptions;
      const rec = new MediaRecorder(new MediaStream([...this.#video.getVideoTracks(), ...sound]), opts);
      const seg = segs.start(sound.length > 0, type);
      rec.ondataavailable = (e) => segs.add(seg, e.data);
      rec.onerror = () => this.#fail();
      rec.start(1000);
      if (this.#why.size) rec.pause();
      this.#rec = rec;
      this.#seg = seg;
      this.#last = performance.now();
    } catch (e) {
      console.warn("clips unavailable", e);
      this.#fail();
    }
  }

  /** Stop the recorder; resolves once its last chunk is in (or soon after, if it never says). */
  #end(): Promise<void> {
    const rec = this.#rec;
    this.#rec = null;
    this.#seg = null;
    if (!rec || rec.state === "inactive") return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      rec.addEventListener("stop", () => (clearTimeout(t), resolve()), { once: true });
      try {
        rec.stop();
      } catch {
        resolve();
      }
    });
  }

  #tick() {
    const now = performance.now();
    const seg = this.#seg;
    if (seg && this.#rec?.state === "recording") seg.ms += now - this.#last;
    this.#last = now;
    // a full segment, or the sound came or went: the next segment takes over (not while paused:
    // a hidden tab's sound is suspended too, and comes back with it)
    const sound = this.types.sound !== null && this.#tap() !== null;
    if (seg && this.#mode === "rolling" && !this.#why.size && (seg.ms >= this.#segMs || sound !== seg.audio)) {
      void this.#end();
      this.#begin();
    }
    this.#report();
  }

  #pause(why: "hidden" | "idle", on: boolean) {
    if (on) this.#why.add(why);
    else this.#why.delete(why);
    const rec = this.#rec;
    try {
      if (rec?.state === "recording" && this.#why.size) rec.pause();
      else if (rec?.state === "paused" && !this.#why.size) rec.resume();
    } catch {
      // a recorder that was just stopped
    }
    this.#last = performance.now();
    this.#report();
  }

  #fail() {
    this.#failed = true;
    this.#mode = "off";
    clearInterval(this.#timer);
    void this.#end();
    this.#report();
  }

  #report() {
    const state = this.#failed ? "failed" : this.#mode === "off" ? "off" : this.#why.size ? "paused" : this.#mode;
    probe().clip = { state, segments: this.#segs.list.length, bytes: this.#segs.bytes, type: this.#seg?.type ?? this.types.video };
  }
}
