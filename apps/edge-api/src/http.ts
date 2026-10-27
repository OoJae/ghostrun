// Response and body helpers shared by the routes. Bodies are read under a byte cap as they
// stream in, so an oversized upload is cut off without being buffered.
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/** Push to an ntfy topic URL. Never rejects: alerting must not break the request it rides on. */
export function ntfy(url: string, title: string, body: string, priority: "default" | "high" = "default"): Promise<void> {
  return fetch(url, { method: "POST", headers: { Title: title, Priority: priority }, body }).then(
    () => undefined,
    () => undefined,
  );
}

export type Body = { ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string };

export async function readJson(req: Request, maxBytes: number): Promise<Body> {
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) return { ok: false, status: 413, error: "body too large" };
  if (!req.body) return { ok: false, status: 400, error: "bad json" };
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413, error: "body too large" };
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(all)) };
  } catch {
    return { ok: false, status: 400, error: "bad json" };
  }
}
