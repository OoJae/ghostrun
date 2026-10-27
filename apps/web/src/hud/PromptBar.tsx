import { useEffect, useRef, type FormEvent } from "react";
import type { LoadResult } from "../engine";

interface Props {
  prompt: string;
  onPrompt(p: string): void;
  onSubmit(p: string): void;
  collapsed: boolean;
  onExpand(): void;
  onCollapse(): void;
  timing: LoadResult | null;
  busy: boolean;
}

function Stopwatch({ timing, busy }: { timing: LoadResult | null; busy: boolean }) {
  const title = timing ? timing.splits.map((s) => `${s.label} ${Math.round(s.ms)} ms`).join(" · ") : "measuring";
  return (
    <span className="stopwatch" title={title} data-testid="stopwatch">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="9" r="5.5" />
        <path d="M8 9V6M6.5 1.8h3M12.2 4.4l1-1" />
      </svg>
      {busy || !timing ? (
        <span className="stopwatch-val muted">…</span>
      ) : (
        <span className="stopwatch-val">
          {Math.round(timing.ttffMs).toLocaleString("en-US")}
          <small> ms</small>
        </span>
      )}
      <span className="stopwatch-label">to first frame</span>
    </span>
  );
}

export function PromptBar({ prompt, onPrompt, onSubmit, collapsed, onExpand, onCollapse, timing, busy }: Props) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!collapsed) return;
    input.current?.blur();
  }, [collapsed]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    input.current?.blur();
    onSubmit(prompt);
  };

  if (collapsed) {
    return (
      <button className="glass pill" onClick={onExpand} title="Edit prompt" data-testid="prompt-pill">
        <span className="mark" aria-hidden="true" />
        <span className="pill-text">{prompt}</span>
        <Stopwatch timing={timing} busy={busy} />
      </button>
    );
  }

  return (
    <form className="glass promptbar" onSubmit={submit} data-testid="prompt-bar">
      <span className="mark" aria-hidden="true" />
      <span className="brand">GHOSTRUN</span>
      <input
        ref={input}
        value={prompt}
        onChange={(e) => onPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCollapse();
        }}
        spellCheck={false}
        aria-label="Describe a world"
        placeholder="Describe a world…"
      />
      <span className="chip" title="The fill is replayed from the recorded CTF fixture; the live LLM lane plugs in here.">
        fixture LLM
      </span>
      <Stopwatch timing={timing} busy={busy} />
    </form>
  );
}
