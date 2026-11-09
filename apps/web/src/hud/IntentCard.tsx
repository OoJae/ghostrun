import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { Intent } from "../pipeline";
import { k as key, t, tn } from "../i18n";
import "./picture.css";
import "./card.css";

/** A count of a role, in the HUD's language (the roles are a closed set). */
const roleCount = (role: string, n: number): string =>
  ({
    guard: () => tn(n, "{n} guard", "{n} guards"), merchant: () => tn(n, "{n} merchant", "{n} merchants"), guide: () => tn(n, "{n} guide", "{n} guides"),
    rival: () => tn(n, "{n} rival", "{n} rivals"), teammate: () => tn(n, "{n} teammate", "{n} teammates"), creature: () => tn(n, "{n} creature", "{n} creatures"),
    citizen: () => tn(n, "{n} citizen", "{n} citizens"),
  } as Record<string, () => string>)[role]?.() ?? `${n} ${role}`;

function castLine(cast: Intent["cast"]): string {
  const counts = new Map<string, number>();
  for (const k of cast) counts.set(k.role, (counts.get(k.role) ?? 0) + 1);
  return [...counts].map(([role, n]) => roleCount(role, n)).join(" · ") || t("none");
}

/** A world built from a picture says so plainly: inspired by it (its place and the things in it), never rebuilt from it. */
export interface Inspired {
  setting: string;
  objects: string[];
}

interface Choice<T> {
  value: T;
  label: string;
}

/**
 * What the card can change, and how (card.ts): the look, the hour and the weather redraw the world
 * in place; jumps, gravity, speed and the map's size come back re-proved with Undo; the pack, the
 * mode and the genre rebuild it. Absent: the card only shows.
 */
export interface CardControls {
  look: Choice<string>;
  looks: readonly Choice<string>[];
  phase: "day" | "dusk" | "night";
  weather: string;
  jumps: number;
  gravity: string;
  speed: string;
  genre: string;
  genres: readonly string[];
  packs: readonly Choice<string>[];
  layout: { bigger: boolean; smaller: boolean; floors: number | null; subs: { id: string; on: boolean }[] } | null;
  chip: { ask: string; label: string } | null;
  /** A rebuild needs the live AI lane; everything else works on any world. */
  live: boolean;
  /** A change is on its way: nothing else until it lands. */
  busy: boolean;
  onLook(v: string): void;
  onPhase(p: "day" | "dusk" | "night"): void;
  onWeather(w: string): void;
  onLaws(c: { jumpsMax?: number; gravity?: string; speed?: string }): void;
  onLayout(c: { scale?: number; floors?: number; sub?: { id: string; on: boolean } }): void;
  onShape(c: { pack?: string; mode?: "play" | "wander"; genre?: string }): void;
  onChip(): void;
}

const REBUILD = key("Rebuilds the world for this, with the live AI");
const OFFLINE = key("Rebuilding needs the live AI lane");

/** A field's value as a button; its choices open under the row, one click each. */
function Pick({ id, value, open, onToggle, disabled, title }: { id: string; value: ReactNode; open: string | null; onToggle: (id: string) => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className="field" aria-expanded={open === id} aria-controls={`pick-${id}`} disabled={disabled} title={title && t(title)} data-testid={`field-${id}`} onClick={() => onToggle(id)}>
      {value}
      <span className="caret" aria-hidden="true">▾</span>
    </button>
  );
}

function Options<T>({ id, label, choices, now, onPick }: { id: string; label: string; choices: readonly Choice<T>[]; now: T; onPick: (v: T) => void }) {
  return (
    <dd className="field-options" id={`pick-${id}`} role="group" aria-label={t(label)}>
      {choices.map((c) => (
        <button type="button" key={String(c.value)} className="opt" aria-pressed={c.value === now} onClick={() => onPick(c.value)}>
          {t(c.label)}
        </button>
      ))}
    </dd>
  );
}

export function IntentCard({ intent, specHash, note, inspired, rebuilt, controls: k }: { intent: Intent; specHash: string | undefined; note?: string | null; inspired?: Inspired | null; rebuilt?: string | null; controls?: CardControls | undefined }) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));
  const pick =
    <T,>(f: (v: T) => void) =>
    (v: T) => (setOpen(null), f(v));
  // On the card's buttons the keys are the card's, not the game's: Space presses the button (no
  // jump), the arrows step through a picker's choices (no camera turn), Escape closes the picker
  // and puts the focus back on its field
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const on = e.target instanceof HTMLButtonElement ? e.target : null;
    if (on && e.key === " ") return void e.stopPropagation();
    if (on && /^Arrow(Left|Right|Up|Down)$/.test(e.key) && on.parentElement?.closest(".field-options")) {
      e.stopPropagation();
      e.preventDefault();
      const all = [...on.closest(".field-options")!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const i = all.indexOf(on) + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1);
      all[(i + all.length) % all.length]?.focus();
      return;
    }
    if (e.key !== "Escape" || !open) return;
    e.stopPropagation();
    (e.currentTarget.querySelector(`[data-testid="field-${open}"]`) as HTMLButtonElement | null)?.focus();
    setOpen(null);
  };
  const edit = k && !k.busy ? k : null;
  const shape = edit && edit.live;
  const jumpsLine = intent.jumpsMax > 1 ? t("double jump (×{n})", { n: intent.jumpsMax }) : tn(intent.jumpsMax, "{n} jump", "{n} jumps");
  return (
    <aside className={`glass intent${k ? " editable" : ""}`} data-testid="intent-card" onKeyDown={onKey}>
      <header>
        <span className="eyebrow">{t("Intent")}</span>
        {edit ? (
          <button type="button" className="mode" disabled={!shape} title={shape ? `${t(REBUILD)}: ${intent.mode === "play" ? t("a place to explore") : t("a game")}` : t(OFFLINE)} data-testid="field-mode" onClick={() => edit.onShape({ mode: intent.mode === "play" ? "wander" : "play" })}>
            {t(intent.mode)} <span aria-hidden="true">⇄</span>
          </button>
        ) : (
          <span className="mode">{t(intent.mode)}</span>
        )}
      </header>
      {inspired && (
        <p className="inspired" data-testid="inspired-note" title={t("Your image suggested the place, the mood, the colours and the things in it; the world was written from those words, so it is inspired by the image, not a copy of it")}>
          {t("Inspired by your image:")} {inspired.setting}
          {inspired.objects.length > 0 && <span className="dim"> · {inspired.objects.join(", ")}</span>}
        </p>
      )}
      {note && (
        <p className="subst" data-testid="subst-note" title={t("The prompt asked for something no world can do yet; this is what you get instead")}>
          {note}
        </p>
      )}
      {rebuilt && (
        <p className="rebuilt" data-testid="rebuilt-note" title={t("You changed what this world is on the card: it was built again with that, and Undo goes back")}>
          {rebuilt}
        </p>
      )}
      {edit?.chip && shape && (
        <p className="intent-chip" data-testid="intent-chip">
          {t(edit.chip.ask)}{" "}
          <button type="button" className="opt" onClick={edit.onChip} title={t(REBUILD)}>
            {t(edit.chip.label)}
          </button>
        </p>
      )}
      {intent.live && (
        <dl className="card10">
          <dt>{t("You are")}</dt>
          <dd>{intent.live.role}</dd>
          <dt>{t("Goal")}</dt>
          <dd>{intent.live.goal}</dd>
          {intent.live.fail && (
            <>
              <dt>{t("Fail")}</dt>
              <dd>{intent.live.fail}</dd>
            </>
          )}
          <dt>{t("Cast")}</dt>
          <dd>{castLine(intent.cast)}</dd>
          {edit && (
            <>
              <dt>{t("Genre")}</dt>
              <dd>
                <Pick id="genre" value={t(edit.genre || "game")} open={open} onToggle={toggle} disabled={!shape} title={shape ? REBUILD : OFFLINE} />
              </dd>
              {open === "genre" && <Options id="genre" label="Genre" choices={[...new Set([edit.genre, ...edit.genres].filter(Boolean))].map((g) => ({ value: g, label: g }))} now={edit.genre} onPick={pick((g: string) => g !== edit.genre && edit.onShape({ genre: g }))} />}
            </>
          )}
        </dl>
      )}
      <dl className={intent.live ? "tech" : ""}>
        <dt>{t("Pack")}</dt>
        <dd>
          {edit ? <Pick id="pack" value={intent.pack} open={open} onToggle={toggle} title={key("Rebuild as another pack, or change this one's size, floors and lanes")} /> : intent.pack}
          {intent.sub.length > 0 && <span className="dim"> + {intent.sub.join(", ")}</span>}
        </dd>
        {edit && open === "pack" && (
          <dd className="field-options" id="pick-pack" role="group" aria-label={t("Pack")}>
            {edit.layout && (
              <span className="opt-row" title={t("Changes the map itself, re-proved by the AI runners, with Undo")}>
                {edit.layout.bigger && (
                  <button type="button" className="opt" data-testid="layout-bigger" onClick={() => (setOpen(null), edit.onLayout({ scale: 1.25 }))}>
                    {t("bigger")}
                  </button>
                )}
                {edit.layout.smaller && (
                  <button type="button" className="opt" data-testid="layout-smaller" onClick={() => (setOpen(null), edit.onLayout({ scale: 0.8 }))}>
                    {t("smaller")}
                  </button>
                )}
                {edit.layout.floors !== null && (
                  <button type="button" className="opt" data-testid="layout-floors" onClick={() => (setOpen(null), edit.onLayout({ floors: edit.layout!.floors === 2 ? 1 : 2 }))}>
                    {edit.layout.floors === 2 ? t("one floor") : t("+ a floor")}
                  </button>
                )}
                {edit.layout.subs.map((s) => (
                  <button type="button" key={s.id} className="opt" aria-pressed={s.on} data-testid={`layout-${s.id}`} onClick={() => (setOpen(null), edit.onLayout({ sub: s }))}>
                    {s.id}
                  </button>
                ))}
              </span>
            )}
            <span className="opt-row" title={t(shape ? REBUILD : OFFLINE)}>
              {edit.packs.map((c) => (
                <button type="button" key={c.value} className="opt" aria-pressed={c.value === intent.pack} disabled={!shape} data-testid={`pack-${c.value}`} onClick={() => (setOpen(null), c.value !== intent.pack && edit.onShape({ pack: c.value }))}>
                  {c.label}
                </button>
              ))}
            </span>
          </dd>
        )}
        <dt>{t("Zones")}</dt>
        <dd>
          {intent.zones.length}
          <span className="dim"> · {intent.zones.map((z) => z.name).join(" · ")}</span>
        </dd>
        <dt>{t("Rules")}</dt>
        <dd>{intent.rules}</dd>
        <dt>{t("Cast")}</dt>
        <dd>{castLine(intent.cast)}</dd>
        <dt>{edit ? t("Moves") : t("Jumps")}</dt>
        <dd className={edit ? "fields" : ""}>
          {edit ? (
            <>
              <Pick id="jumps" value={jumpsLine} open={open} onToggle={toggle} title={key("Re-proved by the AI runners, with Undo")} />
              <Pick id="gravity" value={t("{g} gravity", { g: t(edit.gravity) })} open={open} onToggle={toggle} title="Re-proved by the AI runners, with Undo" />
              <Pick id="speed" value={t("{s} speed", { s: t(edit.speed) })} open={open} onToggle={toggle} title="Re-proved by the AI runners, with Undo" />
            </>
          ) : (
            jumpsLine
          )}
        </dd>
        {edit && open === "jumps" && <Options id="jumps" label="Jumps" choices={[1, 2, 3].map((n) => ({ value: n, label: tn(n, "{n} jump", "{n} jumps") }))} now={edit.jumps} onPick={pick((n: number) => n !== edit.jumps && edit.onLaws({ jumpsMax: n }))} />}
        {edit && open === "gravity" && <Options id="gravity" label="Gravity" choices={["normal", "moon"].map((g) => ({ value: g, label: g }))} now={edit.gravity} onPick={pick((g: string) => g !== edit.gravity && edit.onLaws({ gravity: g }))} />}
        {edit && open === "speed" && <Options id="speed" label="Speed" choices={["slow", "normal", "fast"].map((s) => ({ value: s, label: s }))} now={edit.speed} onPick={pick((s: string) => s !== edit.speed && edit.onLaws({ speed: s }))} />}
        <dt>{t("Look")}</dt>
        <dd className={edit ? "fields" : ""}>
          {edit ? (
            <>
              <Pick id="look" value={t(edit.look.label)} open={open} onToggle={toggle} title={key("Redraws the world in place: the same spec, the same receipt")} />
              <Pick id="phase" value={t(edit.phase)} open={open} onToggle={toggle} title="Redraws the world in place: the same spec, the same receipt" />
              <Pick id="weather" value={t(edit.weather)} open={open} onToggle={toggle} title="Redraws the world in place: the same spec, the same receipt" />
            </>
          ) : (
            <>
              {intent.look} <span className="dim">· {intent.weather}</span>
            </>
          )}
        </dd>
        {edit && open === "look" && <Options id="look" label="Look" choices={edit.looks} now={edit.look.value} onPick={pick(edit.onLook)} />}
        {edit && open === "phase" && <Options id="phase" label={key("Time of day")} choices={(["day", "dusk", "night"] as const).map((p) => ({ value: p, label: p }))} now={edit.phase} onPick={pick(edit.onPhase)} />}
        {edit && open === "weather" && <Options id="weather" label="Weather" choices={["clear", "rain", "snow", "fog", "storm"].map((w) => ({ value: w, label: w }))} now={edit.weather} onPick={pick(edit.onWeather)} />}
      </dl>
      {intent.headline && (
        <div className="headline">
          <span className="eyebrow">{t("Headline expectation")}</span>
          <p>{intent.headline}</p>
        </div>
      )}
      <footer className="dim" title={specHash}>
        spec {specHash ? `${specHash.slice(0, 12)}…` : t("hashing…")}
      </footer>
    </aside>
  );
}
