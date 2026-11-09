// Phone controls: a floating stick under the left thumb, Jump and Use under the right (and Dive, in
// a world you fly, swim or float in: held Jump goes up there). They are HTML over the canvas, so
// their touches never reach the camera; a drag anywhere else orbits it.
import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { upDown, type WorldMoves } from "../moves";
import { BTN_DOWN, BTN_JUMP, BTN_USE } from "../sim/types";
import { t } from "../i18n";

const RADIUS = 56;
const capture = (e: RPointerEvent) => {
  try {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  } catch {
    // synthetic or already-released pointers can't be captured; the controls still work
  }
};

export function TouchControls({ onStick, onButton, useLabel, moves = null }: { onStick(x: number, y: number): void; onButton(bit: number, down: boolean): void; useLabel: string | null; moves?: WorldMoves | null }) {
  const keys = moves ? upDown(moves) : null;
  const id = useRef<number | null>(null);
  const [base, setBase] = useState<{ x: number; y: number } | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  const move = (e: RPointerEvent, b: { x: number; y: number }) => {
    let dx = e.clientX - b.x;
    let dy = e.clientY - b.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > RADIUS) ((dx *= RADIUS / len), (dy *= RADIUS / len));
    setKnob({ x: dx, y: dy });
    onStick(dx / RADIUS, -dy / RADIUS);
  };
  const end = () => {
    id.current = null;
    setBase(null);
    setKnob({ x: 0, y: 0 });
    onStick(0, 0);
  };
  const button = (bit: number) => ({
    onPointerDown: (e: RPointerEvent) => {
      e.preventDefault();
      capture(e);
      onButton(bit, true);
    },
    onPointerUp: () => onButton(bit, false),
    onPointerCancel: () => onButton(bit, false),
  });

  return (
    <div className="touch" data-testid="touch">
      <div
        className="stick-zone"
        onPointerDown={(e) => {
          if (id.current !== null) return;
          id.current = e.pointerId;
          capture(e);
          const b = { x: e.clientX, y: e.clientY };
          setBase(b);
          move(e, b);
        }}
        onPointerMove={(e) => id.current === e.pointerId && base && move(e, base)}
        onPointerUp={(e) => id.current === e.pointerId && end()}
        onPointerCancel={(e) => id.current === e.pointerId && end()}
      >
        {base && (
          <div className="stick" style={{ left: base.x - RADIUS, top: base.y - RADIUS, width: RADIUS * 2, height: RADIUS * 2 }}>
            <div className="knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
          </div>
        )}
      </div>
      <button type="button" className="tbtn jump" aria-label={keys ? `${t("jump")} · ${t(keys.up)}` : t("jump")} {...button(BTN_JUMP)}>
        Jump
      </button>
      <button type="button" className={`tbtn use${useLabel ? " ready" : ""}`} aria-label={useLabel ?? t("use")} {...button(BTN_USE)}>
        {useLabel ?? "Use"}
      </button>
      {keys && (
        <button type="button" className="tbtn dive" data-testid="touch-dive" aria-label={t(keys.down)} {...button(BTN_DOWN)}>
          {t(keys.down)}
        </button>
      )}
    </div>
  );
}
