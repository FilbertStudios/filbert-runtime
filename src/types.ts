/**
 * The wire format. This file is the contract with the receiver — if something
 * here changes, `v` changes with it and the server has to learn the new shape.
 */

export type PlatformSource = 'override' | 'ancestor' | 'referrer' | 'hostname' | 'unknown';

/** One event. `t` is an offset in ms from the session's `t0`, never a clock. */
export interface Event {
  t: number;
  n: string;
  [field: string]: unknown;
}

export interface Envelope {
  v: 1;
  sid: string;
  iid: string;
  game: string;
  build: string;
  plat: string;
  plats: PlatformSource;
  /**
   * The host the platform guess came from.
   *
   * The SERVER owns the host -> platform map, so that adding a portal is one
   * registry line and not a rebuild of every game. Sending the raw host lets it
   * correct our guess; sending only `plat` would freeze the mapping into every
   * build ever shipped.
   */
  plath: string;
  seq: number;
  t0: number;
  drop: number;
  e: Event[];
}

export interface Config {
  /** Canonical game slug from the registry. Not a title, not a folder name. */
  game: string;
  /**
   * Build identifier. REQUIRED, and deliberately not guessed: a wrong build
   * label is worse than an honest "unknown", because it silently attributes
   * one build's numbers to another. Wire it from your bundler.
   */
  build: string;
  /** Where the receiver lives. Defaults to the page's own origin. */
  endpoint?: string;
  /** Force the platform name, skipping detection. */
  platform?: string;
  /** Ad network name, attached to ad events. */
  provider?: string;
  /** Name of the debug global. Default `__fgS`. */
  globalName?: string;
  /** Set false to make every call a no-op. Default true. */
  enabled?: boolean;
  /** Batch interval in ms. Default 12000. */
  flushMs?: number;
  /** Heartbeat interval in ms. Default 15000. */
  heartbeatMs?: number;
  /**
   * Name of the global the game polls for commands, e.g. `__cec2d_cmd`.
   * Set it and the dev panel may drive the game; leave it out and the SDK
   * never announces `cmd`, so the panel hides those buttons instead of
   * offering a control that does nothing.
   */
  commandGlobal?: string;
  /** Report internal problems. Default: silent. */
  onError?: (where: string, err: unknown) => void;
}

/** Both ad-log shapes in the wild are accepted; see `ad()` in index.ts. */
export interface AdEntry {
  name: string;
  type?: string;
  outcome?: string;
  ms?: number;
  detail?: string;
  status?: string;
  provider?: string;
  /** Absolute epoch ms, if the caller already recorded one. */
  t?: number;
}

export type LevelAction = 'start' | 'win' | 'fail' | 'revive' | 'x2';
