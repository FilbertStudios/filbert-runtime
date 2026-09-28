# @filbert/runtime

The Filbert game client: sessions, ad outcomes and progress from a web game to
our own receiver.

**Not Phaser-only.** The core (`src/index.ts`) knows nothing about any engine —
sessions, identity, batching and transport, and that is all. Engines are thin
adapters on top:

| Engine | Status |
|---|---|
| **Any / none** | `start()` from the core; call the methods yourself |
| **Phaser** | `attachPhaser()` — ships here, and does not import Phaser |
| **Unity WebGL** | Core works unchanged; needs a `.jslib` bridge so C# can reach it (К7) |
| Unity native, other runtimes | Out of scope — a separate client speaking the same wire format |

The contract is the product, not this JavaScript: the envelope and
`POST /api/s/<game>` carry no assumption about an engine, so anything that can
send JSON can be a client.

Step-by-step integration — build wiring, the Phaser adapter, the kill switch,
the release checklist — is in **[`INTEGRATION.md`](./INTEGRATION.md)**, written
against the real `monsters-wheels` code. This file is the API reference.

## Quick start

```ts
import { start } from '@filbert/runtime';

const fg = start({
  game: 'monsters-wheels-2',   // the CANONICAL registry slug, not a folder name
  build: __BUILD_VERSION__,    // required — wire it from your bundler
  endpoint: 'https://webgames.filbert.games', // omit to use the page's origin
});

fg.boot({ ttfr: 120, tload: 900, tplay: 1400, bytes: 1_234_567 });
fg.level(3, 'start');
fg.buy('engine-upgrade', 250, 'coins');
fg.custom('tutorial-skipped');
```

## Config

| Key | Required | Meaning |
|---|---|---|
| `game` | yes | Canonical slug from the registry |
| `build` | yes | Build id. Missing → reported as `unknown`, never guessed |
| `endpoint` | no | Receiver origin. Default: the page's own origin |
| `platform` | no | Force the platform name, skipping detection |
| `provider` | no | Ad network name, attached to ad events |
| `globalName` | no | Debug global. Default `__fgS` |
| `enabled` | no | `false` makes every method a no-op |
| `flushMs` / `heartbeatMs` | no | Batch and heartbeat intervals |
| `onError` | no | Called on internal problems. Silent by default |

### `build` is required, and not guessed

A wrong build label is worse than an honest `unknown`: it attributes one
build's numbers to another and nothing on the dashboard can tell. `build_zip.sh`
already knows the version — pass it through a bundler `define`. Until you do,
every session reports `unknown` and shows up in integration health.

## API

- `boot({ ttfr, tload, tplay, bytes })` — once per session. Time to first frame,
  to loading stop, to first gameplay start, and bytes before that point. Those
  are the numbers portals judge a game on.
- `ad(entry)` — see below.
- `level(id, 'start' | 'win' | 'fail' | 'revive' | 'x2', extra?)`
- `buy(what, cost?, currency?)`
- `custom(key, data?)` — anything the core does not model yet.
- `flush()` / `stop()` / `debug()`

### `ad()` takes the ad-log entries you already have

Both shapes in the codebase are accepted unchanged — the network adapters'
`{name, type, outcome, ms, detail}` and the placement layer's
`{t, name, type, outcome, ms, status}`. `detail` and `status` are the same idea,
so they collapse into one field, and a missing timestamp is filled in for you:

```ts
adLog.push(entry);
fg.ad(entry);        // ← the whole integration, per buffer
```

That is deliberate. Unifying the three ad-log buffers first would make adopting
this a refactor of the monetization code, and it is not one.

## What it will not do

- **It cannot break your game.** Every method swallows its own errors, nothing
  is awaited on the start path, and a failed or empty server response is a
  normal outcome. If construction fails you get a client whose every method
  does nothing, not an exception.
- **No cookies, no cross-site identifiers.** A session id in memory and an
  install id in this origin's `localStorage`, nothing else. Only the referrer's
  *host* is recorded, never the full URL.
- **No per-frame events.** The queue is capped at 100 events / 64 KB; the oldest
  are dropped and the loss is reported in the next batch rather than hidden.

## Phaser adapter

```ts
import { attachPhaser } from '@filbert/runtime/phaser';

const game = new Phaser.Game(config);
attachPhaser(fg, game);   // returns a detach function
```

It does **not** import Phaser — every member it touches is structurally typed,
so there is no version lock, no peer dependency, and not one byte of the engine
pulled in here. It measures time to first frame (`postrender`, not `ready` —
`ready` fires before anything is on screen and would flatter the number), time
to loading stop, time to the first gameplay scene, and the bytes spent getting
there, then sends them as a single `boot`.

Scene keys are matched by substring: `boot`/`preload`/`loading`/`load` count as
loading, `game`/`play`/`race`/`level` as gameplay. Override with
`loadingScenes` / `gameplayScenes`. If nothing matches, `boot` is sent anyway
after 20 seconds — an imprecise number beats no number.

Options: `trackScenes` (an event per transition, default true), `fpsSampleMs`
(frame-rate sampling, default 30000, `0` disables).

## Platform detection

Runtime, never from the ad-provider build flag — that flag says which ad network
is compiled in, not where the game is served. Order: explicit `platform` config,
then `ancestorOrigins` (a portal's iframe), then `document.referrer`, then
`location.hostname`, then `unknown`, which is recorded rather than discarded.

Each batch carries the raw host alongside the guess, and the **server** owns the
authoritative host → platform map. Adding a portal is one registry line, not a
rebuild of every game.
