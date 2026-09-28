import type { Event } from './types.js';

export const MAX_EVENTS = 100;
export const MAX_BYTES = 64 * 1024;

/**
 * A bounded queue that would rather lose events than memory.
 *
 * A racing game runs at 60 Hz. If instrumentation ever ends up inside a frame
 * loop — and sooner or later someone will put it there — an unbounded queue
 * turns a small mistake into a memory leak that takes the game down. Dropping
 * the OLDEST keeps the most recent, most diagnostic events, and the count of
 * what was dropped rides along in the next envelope so the loss is visible
 * rather than silent.
 */
export class Queue {
  private items: Event[] = [];
  private bytes = 0;
  private dropped = 0;

  push(event: Event): void {
    const size = roughSize(event);
    this.items.push(event);
    this.bytes += size;
    while (this.items.length > MAX_EVENTS || this.bytes > MAX_BYTES) {
      const gone = this.items.shift();
      if (!gone) break;
      this.bytes -= roughSize(gone);
      this.dropped += 1;
    }
  }

  /** Take everything currently queued, along with how much was lost. */
  drain(): { events: Event[]; dropped: number } {
    const events = this.items;
    const dropped = this.dropped;
    this.items = [];
    this.bytes = 0;
    this.dropped = 0;
    return { events, dropped };
  }

  /** Put a failed batch back at the front, so a retry keeps event order. */
  unshift(events: Event[], dropped: number): void {
    this.items = events.concat(this.items);
    this.dropped += dropped;
    this.bytes = this.items.reduce((n, e) => n + roughSize(e), 0);
    while (this.items.length > MAX_EVENTS || this.bytes > MAX_BYTES) {
      const gone = this.items.shift();
      if (!gone) break;
      this.bytes -= roughSize(gone);
      this.dropped += 1;
    }
  }

  get length(): number { return this.items.length; }
  get lost(): number { return this.dropped; }
}

/** Cheap and approximate on purpose — this guards memory, it is not accounting. */
function roughSize(event: Event): number {
  try { return JSON.stringify(event).length; } catch { return 256; }
}
