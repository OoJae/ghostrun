// The gallery: worlds the live AI built from prompts in tonight's benches, recorded as they came
// out (unedited fills) and re-proved on this device when opened. Breadth at a glance, and a full
// demo even when the live lane is slow or down.
import { useEffect } from "react";
import index from "../gallery/index.json";

export interface GalleryEntry {
  slug: string;
  prompt: string;
  pack: string;
  mode: string;
  honest?: boolean;
}

export const GALLERY = index as GalleryEntry[];

export function Gallery({ onOpen, onClose }: { onOpen: (e: GalleryEntry) => void; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="glass gallery" role="dialog" aria-label="Gallery" data-testid="gallery">
      <div className="gallery-head">
        <strong>Gallery</strong>
        <span className="muted">{GALLERY.length} worlds the live AI built from prompts, recorded unedited; each is re-proved on your device when you open it</span>
        <button type="button" onClick={onClose} aria-label="close">
          ×
        </button>
      </div>
      <ul className="gallery-grid">
        {GALLERY.map((e) => (
          <li key={e.slug}>
            <button type="button" onClick={() => onOpen(e)} data-testid={`gallery-${e.slug}`}>
              <span className="gallery-prompt">{e.prompt.charAt(0).toUpperCase() + e.prompt.slice(1)}</span>
              <span className="gallery-meta">
                {e.pack.replace("_", " ")} · {e.mode === "wander" ? "place to explore" : "game"}
                {e.honest && <span className="gallery-honest" title="AI runners win, but the world's own headline claim fails, and the receipt says so"> · honest receipt</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
