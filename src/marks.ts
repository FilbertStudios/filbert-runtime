/*
 * Lifecycle marks — the one place a time is taken.
 *
 * Until now a game handed over finished numbers (`boot({ ttfr, tload, tplay })`),
 * which means every game re-implements the same three stopwatches and each one
 * can be wrong in its own way. That already happened: `perf.mark` is silent in
 * the release web build of Car Eats Car 2 Deluxe, and nothing noticed until
 * someone read an empty buffer and a screenshot disagreed with the number.
 *
 * Here the SDK takes the time itself, from one clock, at the moment the game
 * says something happened. Telemetry timings are then DERIVED rather than
 * reported, so there is nothing left for a game to get wrong.
 *
 * The clock is `performance.now()` inside the GAME's document: fractional
 * milliseconds from that document's `timeOrigin`. The dev panel runs in another
 * document with another `timeOrigin`, so these numbers only land on its axis
 * once both sides have exchanged theirs — which is why `timeOrigin` belongs in
 * the handshake and not in a later message.
 */

/** Fallback base, captured at load so a missing `performance` still yields a monotonic-ish ms. */
const START = Date.now();

/**
 * Marks a session can only reach once. A second call is ignored rather than
 * recorded: two "the game became interactive" times are not two facts, they are
 * one fact and one bug, and the gates read the first.
 */
const ONCE: ReadonlySet<string> = new Set(['ready', 'loadingFinished']);

export interface Mark {
  readonly name: string;
  /** ms from the game document's `timeOrigin`, fractional. */
  readonly t: number;
}

export interface MarkRecorder {
  /** @returns the mark, or null when it was ignored (repeat of a once-only mark, or over the cap). */
  add(name: string): Mark | null;
  has(name: string): boolean;
  /** Time of the FIRST occurrence — what a portal gate means by "gameplay started". */
  at(name: string): number | undefined;
  all(): readonly Mark[];
  readonly timeOrigin: number;
}

export function nowMs(): number {
  try {
    const p = globalThis.performance;
    if (p && typeof p.now === 'function') return p.now();
  } catch { /* no performance: fall through */ }
  return Date.now() - START;
}

export function timeOriginMs(): number {
  try {
    const p = globalThis.performance;
    if (p && typeof p.timeOrigin === 'number' && Number.isFinite(p.timeOrigin)) return p.timeOrigin;
  } catch { /* fall through */ }
  return START;
}

export function createMarks(limit = 500): MarkRecorder {
  const marks: Mark[] = [];
  const first = new Map<string, number>();
  const timeOrigin = timeOriginMs();

  return {
    timeOrigin,
    add(name: string): Mark | null {
      if (typeof name !== 'string' || !name) return null;
      if (ONCE.has(name) && first.has(name)) return null;
      // A game looping over phase() must not become a leak in here. Dropping the
      // newest keeps the start of loading, which is the part anyone looks at.
      if (marks.length >= limit) return null;
      const mark: Mark = { name, t: nowMs() };
      marks.push(mark);
      if (!first.has(name)) first.set(name, mark.t);
      return mark;
    },
    has(name: string): boolean { return first.has(name); },
    at(name: string): number | undefined { return first.get(name); },
    all(): readonly Mark[] { return marks; },
  };
}
