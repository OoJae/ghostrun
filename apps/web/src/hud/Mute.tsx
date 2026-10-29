// The sound toggle (M does the same). It never takes focus, so Space after a click still jumps.
export function MuteButton({ muted, onToggle }: { muted: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      className={`glass mutebtn${muted ? " off" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.currentTarget.blur();
        onToggle();
      }}
      aria-pressed={muted}
      aria-label={muted ? "Sound off: turn it on" : "Sound on: mute it"}
      title={muted ? "Sound off (M)" : "Sound on (M)"}
      data-testid="mute"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" />
        {muted ? <path d="M10.5 6l4 4M14.5 6l-4 4" /> : <path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.4 3.9a5.8 5.8 0 0 1 0 8.2" />}
      </svg>
    </button>
  );
}
