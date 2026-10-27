// Calls to the edge API through its gate. A judge token arrives once as ?t= in the link: it moves
// to sessionStorage and a header (and out of the address bar, so it never lands in logs or in a
// shared URL). Everyone else gets a session cookie from an interaction-only Turnstile check, run
// the first time the edge answers 401 {need: "turnstile"}.

const TOKEN_KEY = "gr_judge_token";

function judgeToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Take ?t= out of the URL once, at boot. */
export function adoptJudgeToken() {
  const url = new URL(window.location.href);
  const t = url.searchParams.get("t");
  if (!t) return;
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    // storage blocked: the token still works for this page load through the closure below
    memoryToken = t;
  }
  url.searchParams.delete("t");
  history.replaceState(null, "", url);
}
let memoryToken: string | null = null;

declare global {
  interface Window {
    turnstile?: { render(el: HTMLElement, o: Record<string, unknown>): string; remove(id: string): void };
  }
}

let session: Promise<boolean> | null = null;

async function turnstileToken(sitekey: string): Promise<string> {
  if (!window.turnstile) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("turnstile failed to load"));
      document.head.appendChild(s);
    });
  }
  const host = document.createElement("div");
  host.className = "turnstile-host";
  document.body.appendChild(host);
  try {
    return await new Promise<string>((resolve, reject) => {
      window.turnstile!.render(host, { sitekey, appearance: "interaction-only", callback: resolve, "error-callback": () => reject(new Error("turnstile error")) });
    });
  } finally {
    setTimeout(() => host.remove(), 0);
  }
}

/** One session per page: Turnstile, then POST /v1/session sets the cookie. */
function ensureSession(): Promise<boolean> {
  session ??= (async () => {
    try {
      const health = (await (await fetch("/v1/health", { cache: "no-store" })).json()) as { sitekey?: string | null; gate?: string };
      if (health.gate === "dev") return true;
      if (!health.sitekey) return false;
      const token = await turnstileToken(health.sitekey);
      const r = await fetch("/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      return r.ok;
    } catch {
      return false;
    } finally {
      setTimeout(() => (session = null), 25 * 60 * 1000); // the cookie lasts 30 minutes
    }
  })();
  return session;
}

/** fetch for /v1/* routes behind the gate: judge header, and one Turnstile retry on 401. */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const go = () => {
    const headers = new Headers(init.headers);
    const t = judgeToken() ?? memoryToken;
    if (t) headers.set("x-judge-token", t);
    return fetch(path, { ...init, headers, credentials: "same-origin" });
  };
  const res = await go();
  if (res.status !== 401) return res;
  const body = (await res.clone().json().catch(() => ({}))) as { need?: string };
  if (body.need !== "turnstile" || !(await ensureSession())) return res;
  return go();
}
