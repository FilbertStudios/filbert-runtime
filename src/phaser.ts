/**
 * Phaser adapter.
 *
 * Deliberately does NOT import Phaser. Everything here is structurally typed
 * against the handful of members it actually touches, which means: no version
 * lock, no peer dependency to resolve, and not one byte of Phaser pulled into
 * this package. A game passes its `game` object in and the adapter duck-types
 * its way around it.
 *
 * What it buys you: the three timings portals judge a game on — time to first
 * frame, to loading stop, to first playable frame — plus the bytes spent
 * getting there, without the game having to hand-instrument any of it.
 */

import type { Client } from './index.js';

/** The slice of Phaser's Game we rely on. Everything is optional on purpose. */
interface PhaserGameLike {
  events?: Emitter;
  scene?: { scenes?: SceneLike[]; getScenes?: (activeOnly?: boolean) => SceneLike[] };
  loop?: { actualFps?: number };
  scale?: { width?: number; height?: number };
}

interface SceneLike {
  events?: Emitter;
  scene?: { key?: string };
  sys?: { settings?: { key?: string } };
}

interface Emitter {
  on?: (event: string, fn: (...args: unknown[]) => void, ctx?: unknown) => unknown;
  once?: (event: string, fn: (...args: unknown[]) => void, ctx?: unknown) => unknown;
  off?: (event: string, fn?: (...args: unknown[]) => void, ctx?: unknown) => unknown;
}

export interface PhaserOptions {
  /** Scene keys that count as loading. Matched case-insensitively by substring. */
  loadingScenes?: string[];
  /** Scene keys that count as gameplay — the first one starting ends the boot measurement. */
  gameplayScenes?: string[];
  /** Emit a `custom("scene")` event per transition. Default true. */
  trackScenes?: boolean;
  /** Frame-rate sample interval in ms. 0 disables. Default 30000. */
  fpsSampleMs?: number;
}

const DEFAULT_LOADING = ['boot', 'preload', 'loading', 'load'];
const DEFAULT_GAMEPLAY = ['game', 'play', 'race', 'level'];

/**
 * @returns a detach function. Safe to call twice; safe to never call.
 */
export function attachPhaser(client: Client, game: PhaserGameLike, options: PhaserOptions = {}): () => void {
  const cleanups: Array<() => void> = [];
  const detach = () => { while (cleanups.length) { try { cleanups.pop()?.(); } catch { /* ignore */ } } };

  try {
    const started = now();
    const loading = lower(options.loadingScenes ?? DEFAULT_LOADING);
    const gameplay = lower(options.gameplayScenes ?? DEFAULT_GAMEPLAY);
    const trackScenes = options.trackScenes !== false;
    const fpsMs = options.fpsSampleMs ?? 30_000;

    let ttfr: number | undefined;
    let tload: number | undefined;
    let sentBoot = false;

    // First rendered frame. `postrender` is the honest one — `ready` fires
    // before anything is on screen, so it would flatter the number.
    onceAny(game.events, ['postrender', 'ready'], () => {
      if (ttfr === undefined) ttfr = Math.round(now() - started);
    }, cleanups);

    /*
     * The timings land in one `boot`, and `src` says how we got there.
     *
     * Only a real gameplay scene yields `tplay`. A session that ends in the
     * menus has no time-to-play — reporting one anyway is a lie, and a costly
     * one: the first live session on the platform browsed menus for over 20
     * seconds and the old fallback duly recorded `tplay: 20001`, a number that
     * looked like a measurement and was really just the timer firing.
     */
    const finishBoot = (src: 'scene' | 'end' | 'timeout') => {
      if (sentBoot) return;
      sentBoot = true;
      client.boot({
        ttfr,
        tload,
        bytes: bytesSoFar(),
        src,
        ...(src === 'scene' ? { tplay: Math.round(now() - started) } : {}),
      });
      client.flush();
    };

    const matches = (key: string, list: string[]) => {
      const k = key.toLowerCase();
      return list.some((needle) => k.includes(needle));
    };

    const onSceneStart = (key: string) => {
      if (trackScenes) client.custom('scene', { k: key, act: 'start' });
      if (matches(key, gameplay)) finishBoot('scene');
      // A scene change is a natural seam: send what we have rather than sit on
      // it until the timer, since the player may be about to leave.
      else client.flush();
    };

    const onSceneStop = (key: string) => {
      if (trackScenes) client.custom('scene', { k: key, act: 'stop' });
      if (tload === undefined && matches(key, loading)) tload = Math.round(now() - started);
      client.flush();
    };

    // Scenes register their own emitters. Bind the ones present now, and
    // re-scan periodically so scenes added later are not missed.
    const bound = new WeakSet<object>();
    const bindScenes = () => {
      for (const scene of listScenes(game)) {
        const emitter = scene?.events;
        if (!emitter || bound.has(emitter as object)) continue;
        bound.add(emitter as object);
        const key = sceneKey(scene);
        const startFn = () => { try { onSceneStart(key); } catch { /* ignore */ } };
        const stopFn = () => { try { onSceneStop(key); } catch { /* ignore */ } };
        emitter.on?.('start', startFn);
        emitter.on?.('shutdown', stopFn);
        cleanups.push(() => { emitter.off?.('start', startFn); emitter.off?.('shutdown', stopFn); });
      }
    };
    bindScenes();
    const rescan = setInterval(bindScenes, 2000);
    cleanups.push(() => clearInterval(rescan));

    /*
     * Two safety nets, neither of which invents a `tplay`.
     *
     * The session end is the honest deadline: if the player never reached
     * gameplay, we still want `ttfr`, `tload` and `bytes`, and we want them
     * marked as such. The timer is the backstop for a session that never ends
     * cleanly — a killed tab, a crashed browser — and is deliberately long,
     * because browsing menus for a minute is ordinary behaviour, not a fault.
     */
    client.onBeforeEnd(() => finishBoot('end'));
    const bootFallback = setTimeout(() => finishBoot('timeout'), 120_000);
    cleanups.push(() => clearTimeout(bootFallback));

    if (fpsMs > 0) {
      let worst = Infinity;
      const poll = setInterval(() => {
        try {
          const fps = game.loop?.actualFps;
          if (typeof fps === 'number' && isFinite(fps)) worst = Math.min(worst, Math.round(fps));
        } catch { /* ignore */ }
      }, 1000);
      const emit = setInterval(() => {
        try {
          const fps = game.loop?.actualFps;
          if (typeof fps !== 'number' || !isFinite(fps)) return;
          client.custom('perf', { fps: Math.round(fps), min: isFinite(worst) ? worst : undefined });
          worst = Infinity;
        } catch { /* ignore */ }
      }, fpsMs);
      cleanups.push(() => { clearInterval(poll); clearInterval(emit); });
    }
  } catch {
    // An adapter that cannot attach must leave the game exactly as it found it.
    detach();
  }

  return detach;
}

function now(): number {
  try { return performance.now(); } catch { return Date.now(); }
}

function lower(list: string[]): string[] { return list.map((s) => s.toLowerCase()); }

function listScenes(game: PhaserGameLike): SceneLike[] {
  try {
    const all = game.scene?.getScenes?.(false) ?? game.scene?.scenes ?? [];
    return Array.isArray(all) ? all : [];
  } catch { return []; }
}

function sceneKey(scene: SceneLike): string {
  return String(scene?.sys?.settings?.key ?? scene?.scene?.key ?? 'unknown');
}

function onceAny(emitter: Emitter | undefined, events: string[], fn: () => void, cleanups: Array<() => void>): void {
  if (!emitter) return;
  let done = false;
  for (const name of events) {
    const wrapped = () => { if (done) return; done = true; try { fn(); } catch { /* ignore */ } };
    emitter.once?.(name, wrapped);
    cleanups.push(() => emitter.off?.(name, wrapped));
  }
}

/**
 * Bytes downloaded so far, from the Resource Timing buffer.
 *
 * This is the number CrazyGames measures a game on, and the one we used to
 * count by hand. `transferSize` is 0 for cross-origin responses without
 * Timing-Allow-Origin, so treat the result as a floor, not a total.
 */
function bytesSoFar(): number | undefined {
  try {
    const entries = performance.getEntriesByType('resource') as Array<{ transferSize?: number }>;
    const total = entries.reduce((sum, e) => sum + (e.transferSize || 0), 0);
    return total > 0 ? total : undefined;
  } catch { return undefined; }
}
