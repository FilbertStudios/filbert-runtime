/*
 * The lifecycle layer. The point of it is that a game stops keeping its own
 * stopwatches, so these tests are mostly about the SDK refusing to record a
 * second version of a fact it already has.
 */

import test from 'node:test';
import assert from 'node:assert';

function installEnv({ hostname = 'webgames.filbert.games' } = {}) {
  const sent = [];
  const listeners = new Map();
  const store = new Map();
  const stubs = {
    location: { hostname, origin: `https://${hostname}` },
    document: { referrer: '', visibilityState: 'visible' },
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 2,
    navigator: { language: 'uk-UA', sendBeacon: (url, body) => { sent.push({ via: 'beacon', url, body }); return true; } },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    fetch: async (url, init) => { sent.push({ via: 'fetch', url, body: init.body }); return { status: 204 }; },
  };
  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  return { sent, fire: (name) => listeners.get(name)?.() };
}

const loadSdk = () => import('../dist/index.js?' + Math.random());

/*
 * Every event across every batch that was sent, in order.
 *
 * `fetch` carries a string body but `sendBeacon` carries a Blob, and the end of
 * a session goes out by beacon — so a reader that only handles strings silently
 * sees nothing exactly when the session matters most.
 */
async function eventsIn(sent) {
  const out = [];
  for (const one of sent) {
    const raw = typeof one.body === 'string' ? one.body : await one.body.text();
    let env; try { env = JSON.parse(raw); } catch { continue; }
    for (const e of env.e || []) out.push(e);
  }
  return out;
}

test('marks carry a time the caller never supplied', async () => {
  installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });

  c.ready();
  c.phase('menu');

  const marks = c.marks();
  assert.equal(marks.length, 2);
  assert.deepEqual(marks.map((m) => m.name), ['ready', 'menu']);
  for (const m of marks) {
    assert.equal(typeof m.t, 'number');
    assert.ok(Number.isFinite(m.t) && m.t >= 0, 'a mark time must be a real, non-negative number');
  }
  assert.ok(marks[1].t >= marks[0].t, 'marks must not go backwards');
  c.stop();
});

test('a fact the session already has is not recorded twice', async () => {
  installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });

  c.ready();
  c.ready();
  c.loadingFinished();
  c.loadingFinished();

  assert.deepEqual(c.marks().map((m) => m.name), ['ready', 'loadingFinished'],
    'ready and loadingFinished happen once; a repeat is a bug, not a second fact');
  c.stop();
});

test('gameplay may start and stop more than once', async () => {
  installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });

  c.gameplayStart();
  c.gameplayStop();
  c.gameplayStart();

  const names = c.marks().map((m) => m.name);
  assert.deepEqual(names, ['gameplayStart', 'gameplayStop', 'gameplayStart']);
  c.stop();
});

test('boot timings are derived from the marks, not asked for', async () => {
  const { sent } = installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });

  c.ready();
  c.loadingFinished();
  c.gameplayStart();
  c.flush();
  await new Promise((r) => setTimeout(r, 10));

  const boot = (await eventsIn(sent)).find((e) => e.n === 'boot');
  assert.ok(boot, 'reaching gameplay must produce a boot event without the game sending one');
  assert.equal(boot.src, 'marks', 'the event says where its numbers came from');
  for (const k of ['ttfr', 'tload', 'tplay']) {
    assert.equal(typeof boot[k], 'number', `${k} must be derived`);
  }
  assert.ok(boot.ttfr <= boot.tload && boot.tload <= boot.tplay, 'derived timings must be ordered');
  c.stop();
});

test('a game that measures its own boot still wins', async () => {
  const { sent } = installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });

  // bytes and the chosen engine file are things the SDK cannot see, so a game
  // that took the trouble to measure them must not have them thrown away.
  c.boot({ ttfr: 1, tload: 2, tplay: 3, bytes: 4242, src: 'game' });
  c.ready();
  c.loadingFinished();
  c.gameplayStart();
  c.flush();
  await new Promise((r) => setTimeout(r, 10));

  const boots = (await eventsIn(sent)).filter((e) => e.n === 'boot');
  assert.equal(boots.length, 1, 'exactly one boot per session');
  assert.equal(boots[0].src, 'game');
  assert.equal(boots[0].bytes, 4242);
  c.stop();
});

test('a session that never reaches gameplay still reports how far it got', async () => {
  const { sent, fire } = installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });

  c.ready();
  c.loadingFinished();
  fire('pagehide');            // the player left on the loading screen
  await new Promise((r) => setTimeout(r, 10));

  const boot = (await eventsIn(sent)).find((e) => e.n === 'boot');
  assert.ok(boot, 'the session that gave up is exactly the one worth measuring');
  assert.equal(typeof boot.tload, 'number');
  assert.equal(boot.tplay, undefined, 'gameplay never happened, so it is absent rather than zero');
  c.stop();
});

test('lifecycle calls reach telemetry as phase events', async () => {
  const { sent } = installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });

  c.ready();
  c.phase('level_loaded');
  c.flush();
  await new Promise((r) => setTimeout(r, 10));

  const phases = (await eventsIn(sent)).filter((e) => e.n === 'phase').map((e) => e.p);
  assert.deepEqual(phases, ['ready', 'level_loaded']);
  c.stop();
});

test('an inert client answers the lifecycle too', async () => {
  installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1', enabled: false });

  // The whole point of the inert client: a disabled SDK must never be the
  // reason a call site throws.
  c.ready(); c.loadingFinished(); c.gameplayStart(); c.gameplayStop(); c.phase('x');
  assert.deepEqual(c.marks(), []);
});
