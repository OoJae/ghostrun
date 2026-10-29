import { describe, expect, it } from "vitest";
import { clipName, clipsOn, pickTypes, Segments } from "../src/clip";
import { cat, el, joinWebm, readWebm, simpleBlock, uint, WEBM_ID as ID } from "../src/webm";

const text = (s: string) => new TextEncoder().encode(s);
/** An element of unknown size, as live recorders write the segment and its clusters. */
const open = (id: number, body: Uint8Array[]) => cat([Uint8Array.from(id.toString(16).match(/../g)!.map((h) => parseInt(h, 16))), Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), ...body]);

/**
 * A segment the way Chrome's MediaRecorder writes one: a VP9 track (a frame every 40 ms, a
 * keyframe every `keyMs`) and, with sound, an Opus track (a packet every 20 ms), in clusters of
 * unknown size that start on each video keyframe. Each payload says which segment, track and
 * frame it is, so a joined file can be checked frame by frame.
 */
function segment(seg: number, ms: number, o: { sound?: boolean; keyMs?: number; scale?: number; twin?: boolean } = {}): Uint8Array {
  const keyMs = o.keyMs ?? 2000;
  const tracks = [el(ID.TrackEntry, [uint(ID.TrackNumber, 1), uint(ID.TrackType, 1), el(ID.CodecID, text("V_VP9"))])];
  if (o.sound) tracks.push(el(ID.TrackEntry, [uint(ID.TrackNumber, 2), uint(ID.TrackType, 2), el(ID.CodecID, text("A_OPUS")), el(ID.CodecPrivate, text("OpusHead"))]));
  const frames: { track: number; t: number; key: boolean; i: number }[] = [];
  for (let i = 0; i * 40 < ms; i++) frames.push({ track: 1, t: o.twin && i === 1 ? 0 : i * 40, key: (i * 40) % keyMs === 0, i });
  if (o.sound) for (let i = 0; i * 20 < ms; i++) frames.push({ track: 2, t: i * 20, key: true, i });
  frames.sort((a, b) => a.t - b.t || a.track - b.track);
  const clusters: Uint8Array[] = [];
  let blocks: Uint8Array[] = [];
  let ct = 0;
  const flush = () => blocks.length && clusters.push(open(ID.Cluster, [uint(ID.Timecode, ct), ...blocks]));
  for (const f of frames) {
    if (f.track === 1 && f.key) ((flush(), (blocks = []), (ct = f.t)));
    blocks.push(simpleBlock(f.track, f.t - ct, f.key ? 0x80 : 0, Uint8Array.from([seg, f.track, f.i >> 8, f.i & 0xff])));
  }
  flush();
  const ebml = el(ID.EBML, el(0x4282, text("webm")));
  const info = el(ID.Info, [uint(ID.TimecodeScale, o.scale ?? 1_000_000), el(ID.MuxingApp, text("Chrome"))]);
  return cat([ebml, open(ID.Segment, [info, el(ID.Tracks, tracks), ...clusters])]);
}

const who = (p: Uint8Array) => ({ seg: p[0]!, track: p[1]!, i: (p[2]! << 8) | p[3]! });

/** The Duration written into the file's Info (a float64 after its id and size). */
function duration(b: Uint8Array): number | null {
  for (let i = 0; i + 11 <= b.length; i++) if (b[i] === 0x44 && b[i + 1] === 0x89 && b[i + 2] === 0x88) return new DataView(b.buffer, b.byteOffset + i + 3, 8).getFloat64(0);
  return null;
}

describe("the clip's segments", () => {
  it("keeps the newest two: a third pushes out the oldest, and a stopped recorder's late chunk for it is let go", () => {
    const s = new Segments(2);
    const a = s.start(false, "video/webm;codecs=vp9");
    s.add(a, new Blob([new Uint8Array(100)]));
    const b = s.start(true, "video/webm;codecs=vp9,opus");
    s.add(b, new Blob([new Uint8Array(50)]));
    s.add(b, new Blob([])); // an empty chunk counts for nothing
    expect(s.list.map((x) => x.n)).toEqual([0, 1]);
    expect(s.bytes).toBe(150);
    const c = s.start(true, "video/webm;codecs=vp9,opus");
    s.add(a, new Blob([new Uint8Array(999)])); // a's recorder stopped long ago; its data is not kept
    s.add(b, new Blob([new Uint8Array(25)])); // b's last chunk lands after c started: kept
    expect(s.list.map((x) => x.n)).toEqual([1, 2]);
    expect(s.list[0]!.chunks).toHaveLength(2);
    expect(c.bytes).toBe(0);
    expect(s.bytes).toBe(75);
  });

  it("a take keeps one: the segment recording now", () => {
    const s = new Segments(1);
    s.start(false, "video/webm");
    const b = s.start(false, "video/webm");
    expect(s.list).toEqual([b]);
  });

  it("records WebM where it can (VP9, else VP8, with Opus for the sound), MP4 where only that records, else nothing", () => {
    const chrome = pickTypes(() => true);
    expect(chrome).toEqual({ ext: "webm", joinable: true, video: "video/webm;codecs=vp9", sound: "video/webm;codecs=vp9,opus" });
    const vp8 = new Set(["video/webm;codecs=vp8", "video/webm;codecs=vp8,opus", "video/webm"]);
    expect(pickTypes((t) => vp8.has(t))).toEqual({ ext: "webm", joinable: true, video: "video/webm;codecs=vp8", sound: "video/webm;codecs=vp8,opus" });
    const safari = new Set(["video/mp4", "video/mp4;codecs=avc1", "video/mp4;codecs=avc1,mp4a.40.2"]);
    expect(pickTypes((t) => safari.has(t))).toEqual({ ext: "mp4", joinable: false, video: "video/mp4;codecs=avc1", sound: "video/mp4;codecs=avc1,mp4a.40.2" });
    expect(pickTypes(() => false)).toBeNull();
  });

  it("is on by default, off with ?clip=0, and on phones only with ?clip=1", () => {
    expect(clipsOn("", false)).toBe(true);
    expect(clipsOn("?clip=0", false)).toBe(false);
    expect(clipsOn("?gl=webgl2", true)).toBe(false);
    expect(clipsOn("?clip=1", true)).toBe(true);
  });

  it("names the file after the world and the run's clock", () => {
    expect(clipName("capture-the-flag", 42 * 60 + 30, "webm")).toBe("ghostrun-capture-the-flag-0-42.webm");
    expect(clipName("museum heist", 75 * 60, "mp4", "replay")).toBe("ghostrun-museum-heist-1-15-replay.mp4");
    expect(clipName("Bludiště s duchy!", 60, "webm")).toBe("ghostrun-bludiste-s-duchy-0-01.webm");
    expect(clipName("???", 0, "webm")).toBe("ghostrun-world-0-00.webm");
  });
});

describe("joining WebM segments", () => {
  it("reads a segment back to its blocks: clusters of unknown size, both tracks, keyframes, times", () => {
    const s = readWebm(segment(7, 6000, { sound: true }))!;
    expect(s.scale).toBe(1_000_000);
    expect(s.video).toBe(1);
    expect(s.sig).toBe(`1:1:V_VP9:|2:2:A_OPUS:${Buffer.from("OpusHead").toString("hex")}`);
    const video = s.blocks.filter((b) => b.track === 1);
    expect(video).toHaveLength(150);
    expect(video.filter((b) => b.key).map((b) => b.t)).toEqual([0, 2000, 4000]);
    expect(s.blocks.filter((b) => b.track === 2)).toHaveLength(300);
    expect(who(video[75]!.payload)).toEqual({ seg: 7, track: 1, i: 75 });
    expect(video[75]!.t).toBe(3000);
  });

  it("lays the last two end to end and keeps the last ten seconds from a keyframe, with its duration set", () => {
    const joined = joinWebm([readWebm(segment(1, 6000, { sound: true, keyMs: 1000 }))!, readWebm(segment(2, 6000, { sound: true, keyMs: 1000 }))!], 10_000)!;
    // segment 2 starts a frame (33 ms) after segment 1's last block (5980 ms), so the run ends at
    // 6013 + 5980 ms; ten seconds back is 1993 ms, and the last keyframe at or before that is 1000 ms
    expect(joined.ms).toBe(6013 + 5980 - 1000 + 33);
    expect(duration(joined.bytes)).toBe(joined.ms); // in the file (1 ms ticks), so players can seek it
    const back = readWebm(joined.bytes)!;
    expect(back.sig).toBe(readWebm(segment(1, 10, { sound: true }))!.sig);
    const v = back.blocks.filter((b) => b.track === 1);
    expect(v[0]!.key).toBe(true);
    expect(v[0]!.t).toBe(0);
    expect(who(v[0]!.payload)).toEqual({ seg: 1, track: 1, i: 25 }); // frame 25 is at 1000 ms
    // every frame from there on, once each and in order, segment 1's before segment 2's
    expect(v.map((b) => who(b.payload))).toEqual([...Array.from({ length: 125 }, (_, i) => ({ seg: 1, track: 1, i: i + 25 })), ...Array.from({ length: 150 }, (_, i) => ({ seg: 2, track: 1, i }))]);
    expect(back.blocks.filter((b) => b.track === 2)).toHaveLength(250 + 300);
    for (const track of [1, 2]) {
      const ts = back.blocks.filter((b) => b.track === track).map((b) => b.t);
      expect(ts.every((t, i) => i === 0 || t > ts[i - 1]!)).toBe(true);
    }
    // the seam: segment 2's first frame is 20 ms of sound and a frame's gap after segment 1's last
    const k = v.findIndex((b) => who(b.payload).seg === 2);
    expect(v[k]!.t - v[k - 1]!.t).toBe(5980 - 5960 + 33);
  });

  it("keeps all of it for a take (Infinity), and the newest segment alone when it is shorter than wanted", () => {
    const all = joinWebm([readWebm(segment(1, 6000))!, readWebm(segment(2, 6000))!], Infinity)!;
    expect(readWebm(all.bytes)!.blocks).toHaveLength(300);
    expect(all.ms).toBe(5960 + 33 + 5960 + 33);
    const one = joinWebm([readWebm(segment(3, 4000))!], 10_000)!;
    expect(one.ms).toBe(3960 + 33);
  });

  it("joins only the newest run of segments whose tracks match (one with sound and one without can't share a file)", () => {
    const joined = joinWebm([readWebm(segment(1, 6000))!, readWebm(segment(2, 6000, { sound: true }))!], 10_000)!;
    const back = readWebm(joined.bytes)!;
    expect(new Set(back.blocks.map((b) => who(b.payload).seg))).toEqual(new Set([2]));
    expect(back.video).toBe(1);
    expect(back.blocks.some((b) => b.track === 2)).toBe(true);
    // nor two of different time scales
    const scaled = joinWebm([readWebm(segment(1, 6000, { scale: 1_000_000 }))!, readWebm(segment(2, 6000, { scale: 500_000 }))!], 10_000)!;
    expect(new Set(readWebm(scaled.bytes)!.blocks.map((b) => who(b.payload).seg))).toEqual(new Set([2]));
  });

  it("starts where a segment does when its recorder keys only its first frame", () => {
    const joined = joinWebm([readWebm(segment(1, 6000, { keyMs: 1e9 }))!, readWebm(segment(2, 6000, { keyMs: 1e9 }))!], 5000)!;
    const v = readWebm(joined.bytes)!.blocks.filter((b) => b.track === 1);
    expect(who(v[0]!.payload)).toEqual({ seg: 2, track: 1, i: 0 }); // the last keyframe at or before five seconds from the end
    expect(v).toHaveLength(150);
    expect(joined.ms).toBe(5960 + 33);
  });

  it("moves a repeated time a tick later (Chrome stamps a new recording's first two frames alike)", () => {
    const joined = joinWebm([readWebm(segment(1, 2000, { sound: true, twin: true }))!], Infinity)!;
    const v = readWebm(joined.bytes)!.blocks.filter((b) => b.track === 1);
    expect(v.slice(0, 3).map((b) => b.t)).toEqual([0, 1, 80]);
    expect(v.slice(0, 3).map((b) => who(b.payload).i)).toEqual([0, 1, 2]);
  });

  it("drops a cut-short tail, and isn't fooled by what isn't WebM", () => {
    const full = segment(1, 3000, { sound: true });
    const cut = readWebm(full.subarray(0, full.length - 7))!;
    expect(cut.blocks.length).toBeGreaterThan(200);
    expect(cut.blocks.length).toBeLessThan(readWebm(full)!.blocks.length);
    expect(readWebm(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBeNull(); // an MP4's ftyp box
    expect(readWebm(new Uint8Array(0))).toBeNull();
    expect(joinWebm([], 10_000)).toBeNull();
  });
});
