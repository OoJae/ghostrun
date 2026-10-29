// Where a shared or gallery world came from, at the top of the edit box: Remix opens it as your own
// copy, and once you've changed it, "Remixed from “…” · 2 changes: …" with a link to the original
// and which receipt is for which version.
import { lineText, receiptsLine, refLink, type Lineage, type RemixSource } from "../remix";
import "./remix.css";

export function LineagePanel({ source, line, mine, copied, spec, onRemix, onShare }: { source: RemixSource; line: Lineage | null; mine: number; copied: boolean; spec: string | undefined; onRemix: () => void; onShare: () => void }) {
  const text = line && lineText(line);
  const what = source.kind === "gallery" ? "Gallery world" : "Shared world";
  return (
    <div className="lineage" data-testid="lineage">
      {line && text ? (
        <>
          <p className="lineage-line" data-testid="lineage-line">
            {mine > 0 && <span className="eyebrow">Your remix</span>}
            {text.from} · {text.changes}
          </p>
          <p className="lineage-links">
            <a href={refLink(line.origin.id)} data-testid="lineage-original" title="Open the original (it is proved on your device when it opens)">
              the original
            </a>
            {line.remixOf !== line.origin.id && (
              <>
                {" · "}
                <a href={refLink(line.remixOf)} data-testid="lineage-parent">
                  the remix it came from
                </a>
              </>
            )}
          </p>
          <p className="lineage-receipts" data-testid="lineage-receipts">
            {receiptsLine(line, spec)}
          </p>
        </>
      ) : (
        <p className="lineage-line" data-testid="lineage-line">
          <span className="eyebrow">{what}</span>
          {copied ? "Your copy: your first change makes it a remix." : source.prompt ? `“${source.prompt.length > 90 ? `${source.prompt.slice(0, 89)}…` : source.prompt}”` : "Remix it to make it yours."}
        </p>
      )}
      <div className="lineage-actions">
        {!copied && (
          <button type="button" onClick={onRemix} data-testid="remix" title="Open this world as your own copy and change it">
            Remix
          </button>
        )}
        {mine > 0 && (
          <button type="button" onClick={onShare} data-testid="share-remix" title="A link to your remix, with where it came from">
            Share your remix
          </button>
        )}
      </div>
    </div>
  );
}
