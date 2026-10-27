export function ProofBadge() {
  return (
    <div className="glass proof" data-testid="proof-badge" title="AI runners have not proven this world yet">
      <span className="dot" aria-hidden="true" />
      proof: pending
    </div>
  );
}

export function KeyHint({ visible }: { visible: boolean }) {
  return (
    <div className={`glass keyhint${visible ? "" : " gone"}`} aria-hidden={!visible} data-testid="key-hint">
      <kbd>WASD</kbd>
      <span className="sep">·</span>
      <kbd>Space</kbd>
      <span className="sep">·</span>
      <span>drag to orbit</span>
    </div>
  );
}
