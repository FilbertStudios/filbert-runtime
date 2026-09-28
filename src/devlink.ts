/*
 * The dev channel: how a running game talks to the loading panel.
 *
 * WHY THIS EXISTS AT ALL. `performance.getEntriesByType('resource')` is a list
 * per DOCUMENT. The panel lives on the dev host and the game lives on the
 * content host, so the panel cannot see a single file inside the iframe — not
 * "sees them with zeroes", sees nothing. The waterfall is therefore collected
 * by the game and merely drawn by the panel, and that is the whole reason a
 * first-party SDK is needed instead of a devtools trick.
 *
 * SILENT BY DEFAULT. Nothing here starts without `?devsdk=1` in the game's own
 * URL: no observer, no frame sampling, no listeners. The production build ships
 * the same code and says nothing, which is the only arrangement that keeps a
 * debug feature from becoming a production cost.
 *
 * ORIGIN DISCIPLINE. The panel names itself in `?panel=<origin>`. Messages go
 * out with that exact `targetOrigin` and never `'*'`, and inbound messages are
 * dropped unless `event.origin` matches it. Without both halves, any page that
 * embeds one of our games could drive it — including `cmd`, which types into
 * the game.
 */

import { nowMs, timeOriginMs, type Mark } from './marks.js';

/** Wire version of THIS channel, independent of the telemetry envelope's `v`. */
export const DEV_PROTOCOL = 1;

/** Records held while waiting for `hello_ack`. Buffered, never dropped silently. */
const BUFFER_LIMIT = 2000;

/** `performance` keeps 250 resource entries by default; our bundles are larger. */
const RESOURCE_BUFFER = 1000;

export interface DevLink {
  readonly active: boolean;
  /** Forward a lifecycle mark as it happens. */
  phase(mark: Mark): void;
  /** Report an error the SDK saw. */
  error(message: string, stack?: string, source?: 'page' | 'worker'): void;
  stop(): void;
}

export interface DevLinkOptions {
  game: string;
  build: string;
  sdkVersion: string;
  /** Replays everything known so far; used to answer `snapshot`. */
  snapshot: () => { marks: readonly Mark[] };
  /** Name of the global the game polls for commands, if it has one. */
  commandGlobal?: string;
  onError?: (where: string, err: unknown) => void;
}

const inert: DevLink = {
  active: false,
  phase() {}, error() {}, stop() {},
};

/** `http(s)` origin or null. A panel that cannot be addressed is not a panel. */
function panelOrigin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch { return null; }
}

export function createDevLink(opts: DevLinkOptions): DevLink {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('devsdk') !== '1') return inert;

    const panel = panelOrigin(params.get('panel'));
    const parent = globalThis.parent;
    // No panel origin, or nobody above us: there is no one to talk to, and
    // guessing an origin is exactly the mistake this check exists to prevent.
    if (!panel || !parent || parent === globalThis.self) return inert;

    const run = params.get('run') || '';
    const timeOrigin = timeOriginMs();
    const report = (where: string, err: unknown) => { try { opts.onError?.(where, err); } catch { /* ignore */ } };

    let acked = false;
    let stopped = false;
    let buffered: Array<Record<string, unknown>> = [];
    let framesOn = false;
    const caps = ['resources', 'frames', ...(opts.commandGlobal ? ['cmd'] : [])];

    const post = (kind: string, fields: Record<string, unknown> = {}) => {
      if (stopped) return;
      const msg = { v: DEV_PROTOCOL, run, kind, t: nowMs(), ...fields };
      // Before the handshake completes the panel is not listening yet. The
      // start of loading is the most interesting part of the whole run, so it
      // is held rather than thrown away — the panel routinely attaches after
      // the game has already begun.
      if (!acked && kind !== 'hello') {
        if (buffered.length < BUFFER_LIMIT) buffered.push(msg);
        return;
      }
      try { parent.postMessage(msg, panel); } catch (e) { report('devlink.post', e); }
    };

    const drain = () => {
      const held = buffered;
      buffered = [];
      for (const msg of held) {
        try { parent.postMessage(msg, panel); } catch (e) { report('devlink.drain', e); }
      }
    };

    // ---- what the environment is ------------------------------------------
    const envPayload = () => {
      const out: Record<string, unknown> = {
        sdk: opts.sdkVersion, game: opts.game, build: opts.build,
        timeOrigin,
      };
      try {
        const c = (navigator as unknown as { connection?: { effectiveType?: string; downlink?: number; rtt?: number } }).connection;
        if (c) out.net = { effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt };
      } catch { /* absent on Safari; a missing field, not a zero */ }
      try { out.dpr = devicePixelRatio; } catch { /* ignore */ }
      try { out.isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true; } catch { /* ignore */ }
      try {
        const canvas = document.querySelector('canvas');
        if (canvas) out.canvas = { w: canvas.width, h: canvas.height };
      } catch { /* ignore */ }
      return out;
    };

    // ---- resources ---------------------------------------------------------
    let pending: unknown[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushResources = () => {
      flushTimer = null;
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      post('resources', { r: batch });
    };

    const takeResource = (e: PerformanceResourceTiming) => {
      pending.push({
        name: e.name,
        startTime: e.startTime,
        responseEnd: e.responseEnd,
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize,
        nextHopProtocol: e.nextHopProtocol,
        initiatorType: e.initiatorType,
      });
      // Batched, never one message per file: a bundle is dozens of requests and
      // a message each would cost more than the thing being measured.
      if (!flushTimer) flushTimer = setTimeout(flushResources, 500);
    };

    let observer: PerformanceObserver | null = null;
    try {
      // The SDK is not the first line of the page, so without `buffered: true`
      // everything that loaded before this ran is simply gone — and that is the
      // half of the waterfall anyone cares about.
      performance.setResourceTimingBufferSize?.(RESOURCE_BUFFER);
      observer = new PerformanceObserver((list) => {
        try { for (const e of list.getEntries()) takeResource(e as PerformanceResourceTiming); }
        catch (err) { report('devlink.observer', err); }
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch (e) { report('devlink.observe', e); }

    // ---- frames ------------------------------------------------------------
    let rafId = 0;
    let stamps: number[] = [];
    let frameTimer: ReturnType<typeof setInterval> | null = null;

    const pct = (sorted: number[], p: number): number => {
      const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
      return sorted[i] ?? 0;
    };

    const reportFrames = () => {
      const deltas: number[] = [];
      for (let i = 1; i < stamps.length; i += 1) {
        const prev = stamps[i - 1];
        const cur = stamps[i];
        if (prev === undefined || cur === undefined) continue;
        deltas.push(cur - prev);
      }
      const count = stamps.length;
      stamps = [];
      if (deltas.length < 2) return;
      deltas.sort((a, b) => a - b);
      const out: Record<string, unknown> = {
        fps: count,
        median: pct(deltas, 0.5),
        p90: pct(deltas, 0.9),
        // The slowest 1% of frames — the stutter a player actually feels, which
        // an average hides completely.
        low1: pct(deltas, 0.99),
      };
      // Chromium only. Absent on iOS Safari, and absent must stay absent: a
      // panel drawing "0 MB" would be inventing a measurement.
      try {
        const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        if (m && typeof m.usedJSHeapSize === 'number') out.heap = m.usedJSHeapSize;
      } catch { /* ignore */ }
      post('frames', out);
    };

    const tick = () => {
      if (!framesOn || stopped) return;
      stamps.push(nowMs());
      rafId = requestAnimationFrame(tick);
    };

    const setFrames = (on: boolean) => {
      if (on === framesOn) return;
      framesOn = on;
      try {
        if (on) {
          rafId = requestAnimationFrame(tick);
          frameTimer = setInterval(reportFrames, 1000);
        } else {
          cancelAnimationFrame(rafId);
          if (frameTimer) clearInterval(frameTimer);
          frameTimer = null;
          stamps = [];
        }
      } catch (e) { report('devlink.frames', e); }
    };

    // ---- inbound -----------------------------------------------------------
    const onMessage = (event: MessageEvent) => {
      try {
        if (event.origin !== panel) return;          // the whole access control, in one line
        const data = event.data as { kind?: string; run?: string; [k: string]: unknown };
        if (!data || typeof data.kind !== 'string') return;
        if (data.run && run && data.run !== run) return;  // a message meant for a previous iframe

        switch (data.kind) {
          case 'hello_ack':
            if (acked) return;
            acked = true;
            post('env', envPayload());
            drain();
            return;
          case 'snapshot': {
            const snap = opts.snapshot();
            post('env', envPayload());
            for (const m of snap.marks) post('phase', { p: m.name, at: m.t });
            return;
          }
          case 'mark':
            post('phase', { p: String(data.name || 'mark'), at: nowMs(), manual: true });
            return;
          case 'frames':
            setFrames(data.on === true);
            return;
          case 'cmd': {
            // Handing a string to the channel the game already polls. The SDK
            // does not interpret it; a game without such a channel never
            // announced `cmd` in caps and the panel hides the buttons.
            const name = opts.commandGlobal;
            if (!name) return;
            (globalThis as Record<string, unknown>)[name] = String(data.text ?? '');
            return;
          }
          default:
            // An unknown kind is ignored on purpose: a newer panel must not be
            // able to throw inside an older game.
            return;
        }
      } catch (e) { report('devlink.message', e); }
    };

    try { addEventListener('message', onMessage); } catch (e) { report('devlink.listen', e); }

    // ---- errors ------------------------------------------------------------
    const onWindowError = (e: ErrorEvent) => {
      try { post('error', { message: String(e.message || 'error'), stack: e.error?.stack, source: 'page' }); }
      catch (err) { report('devlink.onerror', err); }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      try { post('error', { message: 'unhandled rejection: ' + String(e.reason), source: 'page' }); }
      catch (err) { report('devlink.onrejection', err); }
    };
    try {
      addEventListener('error', onWindowError);
      addEventListener('unhandledrejection', onRejection as EventListener);
    } catch (e) { report('devlink.errlisten', e); }

    post('hello', { game: opts.game, build: opts.build, sdk: opts.sdkVersion, caps, timeOrigin });

    return {
      active: true,
      phase(mark: Mark) { post('phase', { p: mark.name, at: mark.t }); },
      error(message: string, stack?: string, source: 'page' | 'worker' = 'page') {
        post('error', { message, stack, source });
      },
      stop() {
        if (stopped) return;
        stopped = true;
        try { setFrames(false); } catch { /* ignore */ }
        try { observer?.disconnect(); } catch { /* ignore */ }
        try { removeEventListener('message', onMessage); } catch { /* ignore */ }
        try { removeEventListener('error', onWindowError); } catch { /* ignore */ }
        try { removeEventListener('unhandledrejection', onRejection as EventListener); } catch { /* ignore */ }
        if (flushTimer) { try { clearTimeout(flushTimer); } catch { /* ignore */ } }
      },
    };
  } catch (e) {
    try { opts.onError?.('devlink', e); } catch { /* ignore */ }
    return inert;
  }
}
