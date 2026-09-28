import type { PlatformSource } from './types.js';

/**
 * Where is this game actually running?
 *
 * NOT from the ad-provider build flag. That flag says which ad network is
 * compiled in, not where the game is served — our own host runs an AdSense
 * build, so `adsense` there would mean two different platforms at once, and the
 * same zip gets re-published to different hosts on purpose. Detect at runtime
 * and one artifact reports honestly from anywhere.
 *
 * We return the HOST as well as our guess. The server holds the authoritative
 * host -> platform map, so a portal we have never heard of still resolves
 * correctly without rebuilding a single game.
 */
export function detectPlatform(override?: string): {
  plat: string;
  plats: PlatformSource;
  plath: string;
} {
  if (override) return { plat: override, plats: 'override', plath: safeHost(() => location.hostname) };

  // In a portal's iframe the interesting host is the one that embedded us.
  const ancestor = safeHost(() => {
    const origins = (location as unknown as { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    const first = origins && origins.length ? origins[origins.length - 1] : '';
    return first ? new URL(first).hostname : '';
  });
  if (ancestor) return { plat: nameFor(ancestor), plats: 'ancestor', plath: ancestor };

  // Firefox has no ancestorOrigins; the referrer is the next best thing.
  const referrer = safeHost(() => (document.referrer ? new URL(document.referrer).hostname : ''));
  if (referrer && referrer !== safeHost(() => location.hostname)) {
    return { plat: nameFor(referrer), plats: 'referrer', plath: referrer };
  }

  const own = safeHost(() => location.hostname);
  if (own) return { plat: nameFor(own), plats: 'hostname', plath: own };

  // Recorded, never discarded: a pile of `unknown` is itself the finding.
  return { plat: 'unknown', plats: 'unknown', plath: '' };
}

function safeHost(read: () => string): string {
  try { return read() || ''; } catch { return ''; }
}

/**
 * A local guess only, so a build reports something sane even if the server has
 * no mapping yet. The server's answer wins whenever it has one.
 */
function nameFor(host: string): string {
  const h = host.toLowerCase();
  if (h.includes('crazygames')) return 'crazygames';
  if (h.includes('gamedistribution')) return 'gamedistribution';
  if (h.includes('smokoko')) return 'smokoko';
  if (h.includes('filbert')) return 'filbert';
  if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return 'dev';
  return 'unknown';
}
