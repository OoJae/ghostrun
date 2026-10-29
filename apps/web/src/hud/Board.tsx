// A world's best times. The edge holds claims (a stored run and the tick it says it won on); this
// device replays each run from its inputs and ranks only the ones that win on exactly that tick.
// The AI par sits among them for scale, labelled as what it is: the proof's fastest runner.
import { useEffect, useState, type FormEvent } from "react";
import { nickname, type WorldBundle } from "@ghostrun/ir";
import type { Ghost } from "@ghostrun/proof/light";
import { raceClock } from "../race";
import { checkLabel, checkRun, type Check } from "../rivals";
import { loadBoard, type BoardEntry } from "../share";
import "./race.css";

type Urls = { rapier: string; recast: string };

/** A check is of a claim, not a run: the same run claimed at another time is another check. */
const claim = (e: BoardEntry) => `${e.shareId}:${e.ticks}`;

export function BoardPanel({ specHash, bundle, urls, ai, mine, name0, onPost, onRace, onClose }: {
  specHash: string;
  bundle: WorldBundle;
  urls: Urls | null;
  /** The proof's par runner, for scale. */
  ai: { ticks: number; how: string } | null;
  /** This run's win, if it can be posted (and whether it already was). */
  mine: { ticks: number; posted: boolean } | null;
  name0: string;
  onPost: (name: string) => Promise<{ ok: true; entries: BoardEntry[] } | { ok: false; why: string }>;
  onRace: (entry: BoardEntry, ghost: Ghost) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<BoardEntry[] | "loading" | "unreachable">("loading");
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [name, setName] = useState(name0);
  const [post, setPost] = useState<{ status: "idle" | "posting" | "posted" } | { status: "refused"; why: string }>({ status: "idle" });

  useEffect(() => {
    let gone = false;
    void loadBoard(specHash).then((e) => !gone && setEntries(e ?? "unreachable"));
    return () => void (gone = true);
  }, [specHash]);

  // replay every listed run here, one after another (the replay worker takes them in order)
  useEffect(() => {
    if (!Array.isArray(entries) || !urls) return;
    let gone = false;
    void (async () => {
      for (const e of entries) {
        const c = await checkRun(e.shareId, bundle, specHash, e.ticks, urls);
        if (gone) return;
        setChecks((m) => ({ ...m, [claim(e)]: c }));
      }
    })();
    return () => void (gone = true);
  }, [entries, bundle, specHash, urls]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (post.status === "posting") return;
    const n = name.trim() ? nickname(name) : ({ ok: true, name: "" } as const);
    if (!n.ok) return setPost({ status: "refused", why: n.why });
    setPost({ status: "posting" });
    const r = await onPost(n.name);
    if (!r.ok) return setPost({ status: "refused", why: r.why });
    setEntries(r.entries);
    setPost({ status: "posted" });
  };

  const list = Array.isArray(entries) ? entries : [];
  const held = (e: BoardEntry) => checks[claim(e)]?.status;
  // ranked: replayed here to their time (pending ones keep their place); the rest go below, struck
  const live = list.filter((e) => held(e) === undefined || held(e) === "verified");
  const out = list.filter((e) => held(e) !== undefined && held(e) !== "verified");
  type Row = { kind: "entry"; e: BoardEntry } | { kind: "ai"; ticks: number };
  const rows: Row[] = live.map((e) => ({ kind: "entry", e }));
  if (ai) {
    const at = rows.findIndex((r) => r.kind === "entry" && r.e.ticks > ai.ticks);
    rows.splice(at < 0 ? rows.length : at, 0, { kind: "ai", ticks: ai.ticks });
  }
  let rank = 0;

  return (
    <div className="glass board" role="dialog" aria-label="Best times" data-testid="board" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="board-head">
        <strong>Best times</strong>
        <span className="muted">world {specHash.slice(0, 8)}</span>
        <button type="button" onClick={onClose} aria-label="close">
          ×
        </button>
      </div>
      {entries === "loading" && <p className="note">Loading the board…</p>}
      {entries === "unreachable" && <p className="note warn">The board needs the live service, which isn't reachable.</p>}
      {Array.isArray(entries) && (
        <ol>
          {rows.map((r) =>
            r.kind === "ai" ? (
              <li key="ai" className="ai" data-testid="board-ai">
                <span className="rank">AI</span>
                <span className="name">AI par runner</span>
                <span className="time">{raceClock(r.ticks)}</span>
                <span />
                <span className="how">{ai!.how}</span>
              </li>
            ) : (
              <li key={claim(r.e)} className={held(r.e) === "verified" ? "verified" : "pending"} data-testid="board-entry">
                <span className="rank">{held(r.e) === "verified" ? ++rank : "…"}</span>
                <span className="name">{r.e.name || "anonymous"}</span>
                <span className="time">{raceClock(r.e.ticks)}</span>
                {held(r.e) === "verified" ? (
                  <button type="button" onClick={() => onRace(r.e, (checks[claim(r.e)] as Extract<Check, { status: "verified" }>).ghost)} data-testid="board-race">
                    Race
                  </button>
                ) : (
                  <span />
                )}
                <span className="how">{checkLabel(checks[claim(r.e)])}</span>
              </li>
            ),
          )}
          {out.map((e) => (
            <li key={claim(e)} className="unverified" data-testid="board-unverified">
              <span className="rank">–</span>
              <span className="name">{e.name || "anonymous"}</span>
              <span className="time">{raceClock(e.ticks)}</span>
              <span />
              <span className="how">{checkLabel(checks[claim(e)])}</span>
            </li>
          ))}
        </ol>
      )}
      {Array.isArray(entries) && !list.length && <p className="note">No times yet{mine ? ": yours can be the first." : "."}</p>}
      {mine && !mine.posted && Array.isArray(entries) && post.status !== "posted" && (
        <form onSubmit={(e) => void submit(e)}>
          <span>Post your {raceClock(mine.ticks)}:</span>
          <input value={name} maxLength={12} placeholder="nickname (optional)" aria-label="Nickname" data-testid="board-name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button type="submit" disabled={post.status === "posting"} data-testid="board-post">
            {post.status === "posting" ? "Posting…" : "Post"}
          </button>
        </form>
      )}
      {post.status === "refused" && <p className="note warn" data-testid="board-refused">Not posted: {post.why}.</p>}
      {post.status === "posted" && <p className="note">Posted. Your run is stored with it, so anyone can replay it.</p>}
      <p className="note">Times are claims until this device replays them: each run is replayed here from its stored inputs and ranks only if it wins on exactly the tick it claims. The edge checks that the run exists, is of this world and ends on that tick.</p>
    </div>
  );
}
