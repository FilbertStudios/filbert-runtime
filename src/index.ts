/**
 * Filbert game client — core.
 *
 * Engine-agnostic by design: this file knows about sessions, identity, batching
 * and transport, and nothing about Phaser. The engine adapter is a thin layer
 * on top, so a Unity or Godot title later is a new adapter and not a new client.
 *
 * THE ONE RULE THAT OUTRANKS EVERYTHING: this must not be able to break a game.
 * Every public method swallows its own errors, nothing is awaited on the start
 * path, and an empty or failed server response is a normal outcome. We have
 * already lost weeks to a game that would not boot inside someone else's
 * sandbox; this layer will not be the cause of the next one.
 */

import type { AdEntry, Config, Envelope, Event, LevelAction } from './types.js';
import { installId, randomId } from './ids.js';
import { detectPlatform } from './platform.js';
import { Queue } from './queue.js';
import { beacon, send, urlFor } from './transport.js';
import { SDK_VERSION, SDK_MARKER, PROTOCOL } from './version.js';
import { createMarks, type Mark } from './marks.js';
import { createDevLink } from './devlink.js';

const DEFAULT_GLOBAL = '__fgS';
const DEFAULT_FLUSH_MS = 12_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

export interface Client {
  /*
   * The lifecycle. `ready`, `loadingFinished` and `gameplayStart` are the three
   * a portal's gates are defined against, so they are not optional in practice
   * even though nothing here enforces them. The SDK takes the time; the caller
   * only says that the thing happened.
   */
  /** The engine is up and our code runs. Once per session. */
  ready(): void;
  /** The game is interactive — the first screen. Once per session. */
  loadingFinished(): void;
  /** Gameplay began. This is the one portals measure traffic against. */
  gameplayStart(): void;
  gameplayStop(): void;
  /** Any other milestone: menu, lobby, level_loaded. Free-form, repeatable. */
  phase(name: string): void;
  /** Marks taken so far, in order. Read by the dev channel. */
  marks(): readonly Mark[];

  boot(timings: { ttfr?: number; tload?: number; tplay?: number; bytes?: number; src?: string }): void;
  /** Run just before the session's `end` event is queued. Used by adapters. */
  onBeforeEnd(fn: () => void): void;
  ad(entry: AdEntry): void;
  level(id: string | number, action: LevelAction, extra?: Record<string, unknown>): void;
  buy(what: string, cost?: number, currency?: string): void;
  custom(key: string, data?: Record<string, unknown>): void;
  flush(): void;
  stop(): void;
  debug(): unknown;
}

/** A client whose every method does nothing, for `enabled: false` and for failure. */
function inertClient(): Client {
  const noop = () => {};
  return {
    ready: noop, loadingFinished: noop, gameplayStart: noop, gameplayStop: noop,
    phase: noop, marks: () => [],
    boot: noop, onBeforeEnd: noop, ad: noop, level: noop, buy: noop, custom: noop,
    flush: noop, stop: noop, debug: () => ({ enabled: false }),
  };
}

export function start(config: Config): Client {
  try {
    return build(config);
  } catch (err) {
    // A client that cannot be constructed becomes a client that does nothing.
    try { config.onError?.('start', err); } catch { /* even the reporter is optional */ }
    return inertClient();
  }
}

function build(config: Config): Client {
  if (config.enabled === false) return inertClient();
  if (!config.game) throw new Error('game is required');

  const report = (where: string, err: unknown) => { try { config.onError?.(where, err); } catch { /* ignore */ } };
  const guard = <A extends unknown[]>(where: string, fn: (...args: A) => void) => (...args: A) => {
    try { fn(...args); } catch (err) { report(where, err); }
  };

  const t0 = Date.now();
  const sid = randomId();
  const iid = installId();
  const { plat, plats, plath } = detectPlatform(config.platform);
  // An absent build is recorded as "unknown" rather than blank or invented: the
  // dashboard's integration-health panel exists to count exactly these, and a
  // plausible-looking wrong value would hide the mistake instead of showing it.
  const buildId = config.build || 'unknown';
  const url = urlFor(config.endpoint, config.game);

  const queue = new Queue();
  let seq = 0;
  let inFlight: { events: Event[]; dropped: number; seq: number } | null = null;
  let stopped = false;
  let sentBoot = false;
  let endSent = false;
  /** Last chance for an adapter to add an event before the session is sealed. */
  const beforeEnd: Array<() => void> = [];

  const at = () => Date.now() - t0;

  const marks = createMarks();
  const round = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 1000) / 1000);

  /*
   * The dev channel. Silent unless the game's own URL carries `?devsdk=1`, so
   * the production build ships this code and never opens a listener.
   */
  const dev = createDevLink({
    game: config.game,
    build: buildId,
    sdkVersion: SDK_VERSION,
    snapshot: () => ({ marks: marks.all() }),
    ...(config.commandGlobal ? { commandGlobal: config.commandGlobal } : {}),
    ...(config.onError ? { onError: config.onError } : {}),
  });

  /** Record a mark, mirror it to telemetry, and stream it to the panel. */
  const mark = (name: string) => {
    const m = marks.add(name);
    if (!m) return;
    put('phase', { p: name, ms: round(m.t) });
    dev.phase(m);
  };

  /*
   * `boot` used to be told its timings; now it reads them off the marks.
   *
   * An explicit boot() still wins. A game that measured something the SDK
   * cannot see — bytes on the wire, which engine file the browser chose —
   * should not have that overwritten by a partial guess assembled here.
   */
  const autoBoot = () => {
    if (sentBoot) return;
    const ttfr = marks.at('ready');
    const tload = marks.at('loadingFinished');
    const tplay = marks.at('gameplayStart');
    if (ttfr === undefined && tload === undefined && tplay === undefined) return;
    sentBoot = true;
    put('boot', { ttfr: round(ttfr), tload: round(tload), tplay: round(tplay), src: 'marks' });
  };
  const put = (n: string, fields: Record<string, unknown> = {}) => {
    if (stopped) return;
    queue.push({ t: at(), n, ...fields } as Event);
  };

  function envelopeFor(events: Event[], dropped: number, batchSeq: number): Envelope {
    return { v: 1, sid, iid, game: config.game, build: buildId, plat, plats, plath, seq: batchSeq, t0, drop: dropped, e: events };
  }

  /*
   * Flushes are SERIALISED, and that is not a nicety.
   *
   * Two flushes in one tick — which scene transitions cause constantly — used
   * to have the second one find the first still in flight and re-send that same
   * batch instead of the queue. Everything queued in between stayed queued
   * forever, so a game could report scene changes and never report `boot`.
   * Chaining makes the second flush wait and then take what is actually there.
   */
  let chain: Promise<void> = Promise.resolve();
  function flush(): Promise<void> {
    chain = chain.then(flushOnce, flushOnce);
    return chain;
  }

  async function flushOnce(): Promise<void> {
    if (stopped && !inFlight && queue.length === 0) return;
    // A retry MUST reuse its sequence number — (sid, seq) is the receiver's
    // idempotency key, so a new number would turn one retried batch into two
    // recorded ones and quietly inflate every rate derived from it.
    const batch = inFlight || (() => {
      const { events, dropped } = queue.drain();
      if (!events.length) return null;
      const next = { events, dropped, seq };
      seq += 1;
      return next;
    })();
    if (!batch) return;
    inFlight = batch;
    const ok = await send(url, envelopeFor(batch.events, batch.dropped, batch.seq));
    if (ok) {
      inFlight = null;
    } else if (queue.length > MAX_HELD) {
      // Server unreachable and the queue is filling: let this batch go rather
      // than hold memory for a session that may never get through.
      inFlight = null;
    }
  }

  const timer = setInterval(() => { void flush().catch((e) => report('flush', e)); }, config.flushMs ?? DEFAULT_FLUSH_MS);
  const heartbeat = setInterval(() => {
    try { if (document.visibilityState === 'visible') put('hb', { active: true }); } catch { /* no document */ }
  }, config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  const onHide = () => {
    try {
      if (document.visibilityState === 'hidden') finish('hidden');
    } catch (e) { report('visibilitychange', e); }
  };
  const onPageHide = () => { try { finish('pagehide'); } catch (e) { report('pagehide', e); } };

  /**
   * Flush what we have through the only channel that survives teardown.
   *
   * `end` is emitted at most ONCE. Browsers fire both `pagehide` and
   * `visibilitychange`->hidden when a tab goes away — a real session on the
   * live platform produced two `end` events one millisecond apart — and every
   * session-count or duration figure derived from them would have been double.
   * Flushing still happens on both signals; only the event is deduplicated.
   */
  function finish(reason: string): void {
    for (const fn of beforeEnd) { try { fn(); } catch (e) { report('beforeEnd', e); } }
    if (!endSent) {
      endSent = true;
      put('end', { dur: at(), reason });
    }
    const pending = inFlight;
    const { events, dropped } = queue.drain();
    const merged = pending ? pending.events.concat(events) : events;
    if (!merged.length) return;
    const batchSeq = pending ? pending.seq : seq;
    if (!pending) seq += 1;
    if (!beacon(url, envelopeFor(merged, dropped + (pending?.dropped ?? 0), batchSeq))) {
      queue.unshift(merged, dropped);
    } else {
      inFlight = null;
    }
  }

  try {
    addEventListener('visibilitychange', onHide);
    addEventListener('pagehide', onPageHide);
  } catch (e) { report('listeners', e); }

  // One environment snapshot per session. Only the referrer's HOST is taken,
  // never the full URL — the path can carry a user's identifiers and we have no
  // business storing them.
  try {
    put('env', {
      w: screen?.width, h: screen?.height, dpr: devicePixelRatio,
      lang: navigator?.language, touch: 'ontouchstart' in globalThis,
      refh: document.referrer ? new URL(document.referrer).hostname : '',
    });
  } catch { put('env', {}); }

  // A session that ends before gameplay still knows how far it got, and that is
  // exactly the session worth looking at. Registered before the game's own
  // handlers so the numbers exist by the time `end` is assembled.
  beforeEnd.push(() => { try { autoBoot(); } catch (e) { report('autoBoot', e); } });

  const client: Client = {
    ready: guard('ready', () => mark('ready')),
    loadingFinished: guard('loadingFinished', () => mark('loadingFinished')),
    // Gameplay is where every gate is measured, so this is the moment the
    // derived boot numbers are complete and worth sending.
    gameplayStart: guard('gameplayStart', () => { mark('gameplayStart'); autoBoot(); }),
    gameplayStop: guard('gameplayStop', () => mark('gameplayStop')),
    phase: guard('phase', (name: string) => mark(name)),
    marks: () => marks.all(),

    boot: guard('boot', (timings) => {
      if (sentBoot) return; // once per session; a second would be a different number meaning the same thing
      sentBoot = true;
      put('boot', timings);
    }),

    onBeforeEnd: guard('onBeforeEnd', (fn) => { beforeEnd.push(fn); }),

    /*
     * Accepts BOTH ad-log shapes found in the game today without the caller
     * changing a line: {name,type,outcome,ms,detail} from the network adapters,
     * and {t,name,type,outcome,ms,status} from the placement layer. `detail`
     * and `status` mean the same thing, so they collapse into `why`, and a
     * missing timestamp is filled in here. Asking the game to unify three
     * buffers first would turn integration into a refactor of the ad code.
     */
    ad: guard('ad', (entry) => {
      const when = typeof entry.t === 'number' ? Math.max(0, entry.t - t0) : at();
      queue.push({
        t: when,
        n: 'ad',
        pl: entry.name,
        prov: entry.provider ?? config.provider,
        type: entry.type,
        ph: entry.outcome,
        ms: entry.ms,
        why: entry.detail ?? entry.status,
      } as Event);
    }),

    level: guard('level', (id, action, extra) => put('lvl', { id, act: action, ...(extra || {}) })),
    buy: guard('buy', (what, cost, currency) => put('buy', { what, cost, cur: currency })),

    /*
     * The escape hatch that keeps the schema honest. A new project needing one
     * more metric must not have to wait for a release of this package — and
     * without this, the core event list would grow one field per game until it
     * described nothing in particular.
     */
    custom: guard('custom', (key, data) => put('custom', { k: key, d: data || {} })),

    flush: guard('flush', () => { void flush().catch((e) => report('flush', e)); }),

    /**
     * Tear down timers and listeners. Does NOT seal the session: `end` and the
     * final flush belong to the teardown path (`pagehide`), which is what
     * actually happens in a browser. Anything still queued when you call this
     * is discarded, so call it only when you mean to abandon the session.
     */
    stop: guard('stop', () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      try { dev.stop(); } catch (e) { report('devStop', e); }
      try {
        removeEventListener('visibilitychange', onHide);
        removeEventListener('pagehide', onPageHide);
      } catch { /* ignore */ }
    }),

    // SDK_MARKER is read here so a bundler cannot tree-shake the literal the
    // platform's upload scan looks for; `sideEffects: false` makes that real.
    debug: () => ({ sdk: SDK_VERSION, marker: SDK_MARKER, protocol: PROTOCOL, dev: dev.active, sid, iid, game: config.game, build: buildId, plat, plats, plath, url, seq, queued: queue.length, lost: queue.lost }),
  };

  // Named like the ad debug hook the project already has, so there is one place
  // to look in a console. Configurable because this package is shared across
  // projects and none of them should inherit another's name.
  try {
    (globalThis as Record<string, unknown>)[config.globalName || DEFAULT_GLOBAL] = () => client.debug();
  } catch { /* frozen global, nothing lost */ }

  return client;
}

/** Above this many queued events we stop holding a failed batch for retry. */
const MAX_HELD = 60;

export { SDK_VERSION, SDK_MARKER, PROTOCOL } from './version.js';
export type { Mark, MarkRecorder } from './marks.js';
export type { AdEntry, Config, Envelope, Event, LevelAction } from './types.js';
