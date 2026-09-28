/**
 * Identifiers. Two of them, both deliberately weak.
 *
 * `sid` — one play session, lives in memory only.
 * `iid` — one browser profile, lives in this origin's localStorage.
 *
 * Neither is a cookie and neither crosses sites, which is the whole point:
 * these games ship to European portals with a PEGI 12 rating, and the cheapest
 * way to stay clear of the heavy end of that regulation is to have nothing to
 * regulate. `iid` dies when the player clears site data, and that is fine —
 * install counts drifting slightly low costs us nothing we care about.
 */

const STORAGE_KEY = 'fg.iid';

export function randomId(): string {
  try {
    const a = new Uint8Array(8);
    (globalThis.crypto as Crypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // No crypto (ancient webview, hardened iframe): a weaker id still lets a
    // session be counted, which beats dropping the session entirely.
    return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
  }
}

/**
 * Stable-ish install id. Storage can throw outright — Safari in private mode,
 * a sandboxed iframe with no storage access — so every path falls back to a
 * fresh id rather than letting the exception reach the game.
 */
export function installId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (existing && /^[0-9a-f]{8,64}$/.test(existing)) return existing;
    const fresh = randomId();
    globalThis.localStorage?.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return randomId();
  }
}
