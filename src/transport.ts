import type { Envelope } from './types.js';

/**
 * Sending. Two rules, both non-negotiable.
 *
 * 1. `text/plain` makes this a CORS "simple request", so the browser skips the
 *    OPTIONS preflight. When the game sits in a portal's cross-origin iframe,
 *    that preflight is the single most reliably blocked part of the exchange —
 *    dodging it is the difference between data and no data.
 * 2. Nothing here rejects. The caller must never have a failure to handle, and
 *    a game must never be able to break because telemetry did.
 */

const CONTENT_TYPE = 'text/plain;charset=UTF-8';

export function urlFor(endpoint: string | undefined, game: string): string {
  const base = (endpoint || '').replace(/\/+$/, '');
  // No word from the blocker lists appears in this path, and that is why it can
  // never be renamed casually: the path is compiled into every shipped build.
  return `${base}/api/s/${encodeURIComponent(game)}`;
}

/** @returns true when the batch was handed off; false means "try again later". */
export async function send(url: string, envelope: Envelope): Promise<boolean> {
  let body: string;
  try { body = JSON.stringify(envelope); } catch { return true; } // unserialisable: drop it, do not spin
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': CONTENT_TYPE },
      body,
      keepalive: body.length < 60 * 1024,
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
    });
    // The receiver answers 204 to everything it accepts, including junk. Only a
    // transport-level failure is worth retrying; a 4xx means it will never like
    // this batch and resending is just noise.
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Last-gasp send on pagehide. `fetch` is cancelled when the document goes away;
 * `sendBeacon` survives it, which is the only way the final session event ever
 * arrives. Same content type, so it takes the same preflight-free path.
 */
export function beacon(url: string, envelope: Envelope): boolean {
  try {
    const body = new Blob([JSON.stringify(envelope)], { type: CONTENT_TYPE });
    return navigator.sendBeacon(url, body);
  } catch {
    return false;
  }
}
