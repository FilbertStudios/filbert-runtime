/**
 * Defold adapter.
 *
 * Like the Phaser one, this imports nothing from the engine. Defold gives a web
 * build no game object to pass in, so the shape is different: the adapter puts a
 * small bridge on `window` and the Lua side calls it through `html5.run`, which
 * is the only channel Lua has to the page.
 *
 * WHY A BRIDGE AND NOT A LIBRARY. `print` from Lua is invisible in a web build,
 * the on-screen profiler is stripped from the release engine, and the network
 * only answers "how many bytes". On the live 0.21 build the network finished at
 * 13 s while the loading bar still showed 24 % two minutes later — so the
 * expensive part is precisely the part no external tool can see. The game has to
 * say where it is, and this is the wire it says it on.
 *
 * WHAT IS DETECTED AND WHAT IS NOT. Anything the page can observe honestly is
 * picked up here: the engine becoming initialised, loader progress, which of the
 * two wasm builds the browser actually fetched. `loadingFinished` is NOT
 * inferred from progress reaching 100 %: the loader means "assets downloaded",
 * the metric means "a player can see and touch the first screen", and in this
 * very game those are minutes apart. Only the game knows the second one, so
 * only the game reports it.
 *
 * NOTHING HERE MAY BREAK A GAME. Every hook is feature-detected, every call is
 * wrapped, and a missing SDK on the page makes the Lua side a no-op rather than
 * an error.
 */

import type { Client } from './index.js';

/** Default name of the bridge object. Matches `defold/filbert.lua`. */
const DEFAULT_BRIDGE = '__filbert';

/** The slice of Emscripten's Module we touch. All optional, all duck-typed. */
interface ModuleLike {
  onRuntimeInitialized?: () => void;
}

/** Defold's loader progress object, when it exists. */
interface ProgressLike {
  updateProgress?: (percentage: number) => void;
}

export interface DefoldOptions {
  /** Global the Lua bridge calls. Default `__filbert`. */
  bridgeName?: string;
  /**
   * Global the game polls for commands, read-and-cleared by `cmd()`.
   * Default `__cec2d_cmd`, which is what the existing harness already writes.
   */
  commandGlobal?: string;
  /**
   * Also drain `window.__cec2d_perf`, the array the game's own `perf.lua` still
   * pushes into. Lets a build report marks before it has migrated to the
   * bridge. Default true; harmless when the array never appears.
   */
  adoptLegacyMarks?: boolean;
  /** Report loader progress as phases at these percentages. `[]` disables. */
  progressMarks?: number[];
}

const DEFAULT_PROGRESS = [25, 50, 75, 100];

/**
 * @returns a detach function. Safe to call twice; safe to never call.
 */
export function attachDefold(client: Client, options: DefoldOptions = {}): () => void {
  const cleanups: Array<() => void> = [];
  const detach = () => { while (cleanups.length) { try { cleanups.pop()?.(); } catch { /* ignore */ } } };

  try {
    const g = globalThis as Record<string, unknown>;
    const bridgeName = options.bridgeName || DEFAULT_BRIDGE;
    const commandGlobal = options.commandGlobal || '__cec2d_cmd';
    const wanted = options.progressMarks ?? DEFAULT_PROGRESS;

    // ---- the bridge Lua calls ---------------------------------------------
    /*
     * Every method returns a string, because `html5.run` hands its result back
     * to Lua and a non-string there is a type error in the game, not here.
     */
    const bridge = {
      ready: () => { client.ready(); return ''; },
      loadingFinished: () => { client.loadingFinished(); return ''; },
      gameplayStart: () => { client.gameplayStart(); return ''; },
      gameplayStop: () => { client.gameplayStop(); return ''; },
      phase: (name: string) => { client.phase(String(name || 'phase')); return ''; },
      /** Read-and-clear, so one command is obeyed once rather than every poll. */
      cmd: () => {
        const c = g[commandGlobal];
        g[commandGlobal] = null;
        return typeof c === 'string' ? c : '';
      },
    };
    const previous = g[bridgeName];
    g[bridgeName] = bridge;
    cleanups.push(() => { g[bridgeName] = previous; });

    // ---- engine initialised ------------------------------------------------
    const mod = g.Module as ModuleLike | undefined;
    if (mod && typeof mod === 'object') {
      const prior = mod.onRuntimeInitialized;
      mod.onRuntimeInitialized = function chained(this: unknown) {
        // Chained, never replaced: the loader sets this itself and dropping its
        // callback would stop the game from starting — the one failure this
        // package must never cause.
        try { client.ready(); } catch { /* ignore */ }
        try { prior?.call(this); } catch { /* the engine's handler owns its errors */ }
      };
      cleanups.push(() => { mod.onRuntimeInitialized = prior; });
    }

    // ---- loader progress ---------------------------------------------------
    const progress = g.Progress as ProgressLike | undefined;
    if (progress && typeof progress.updateProgress === 'function' && wanted.length) {
      const prior = progress.updateProgress.bind(progress);
      const seen = new Set<number>();
      progress.updateProgress = (percentage: number) => {
        try {
          for (const step of wanted) {
            if (percentage >= step && !seen.has(step)) {
              seen.add(step);
              client.phase(`load_${step}`);
            }
          }
        } catch { /* ignore */ }
        prior(percentage);
      };
      cleanups.push(() => { progress.updateProgress = prior; });
    }

    // ---- which engine actually arrived -------------------------------------
    /*
     * A Defold bundle ships both wasm builds, around 6 MB each, and exactly one
     * is fetched. Which one depends on cross-origin isolation, so this doubles
     * as the check that the dev host's COOP/COEP really took effect — without
     * it the panel measures the single-threaded build while believing it
     * measured the one that ships.
     */
    const reportEngine = (): boolean => {
      try {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        const chosen = entries.find((e) => /\.wasm(\?|$)/i.test(e.name));
        if (!chosen) return false;
        client.custom('engine', {
          file: chosen.name.split('/').pop() || chosen.name,
          bytes: chosen.transferSize,
          pthread: /_pthread/i.test(chosen.name),
          isolated: (g as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
        });
        return true;
      } catch { return false; }
    };
    if (!reportEngine()) {
      // Not fetched yet: look again once, later, rather than polling forever.
      const later = setTimeout(reportEngine, 5000);
      cleanups.push(() => clearTimeout(later));
    }

    // ---- marks from a build that has not migrated yet ----------------------
    if (options.adoptLegacyMarks !== false) {
      let taken = 0;
      const drain = () => {
        try {
          const list = g.__cec2d_perf as Array<{ mark?: string }> | undefined;
          if (!Array.isArray(list)) return;
          while (taken < list.length) {
            const entry = list[taken];
            taken += 1;
            if (entry && typeof entry.mark === 'string') client.phase(entry.mark);
          }
        } catch { /* ignore */ }
      };
      const every = setInterval(drain, 1000);
      cleanups.push(() => clearInterval(every));
    }
  } catch { /* an adapter that cannot attach simply does not */ }

  return detach;
}
