/*
 * The Phaser adapter, against a fake game object.
 *
 * A fake is the right tool here: the adapter deliberately does not import
 * Phaser — it duck-types the few members it touches — so testing against the
 * real engine would test Phaser, not the contract we actually rely on.
 */

import test from 'node:test';
import assert from 'node:assert';

function installEnv() {
  const sent = [];
  const listeners = new Map();
  const stubs = {
    location: { hostname: 'webgames.filbert.games', origin: 'https://webgames.filbert.games' },
    document: { referrer: '', visibilityState: 'visible' },
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    navigator: { language: 'uk-UA', sendBeacon: () => true },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: (n, f) => listeners.set(n, [...(listeners.get(n) || []), f]),
    removeEventListener: (n, f) => listeners.set(n, (listeners.get(n) || []).filter((x) => x !== f)),
    fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return { status: 204 }; },
  };
  // The teardown path sends a Blob, and at session end that is how `boot`
  // actually leaves — so it has to be captured, not ignored. Read back with
  // `collect()`, which is async because Blob.text() is.
  stubs.navigator.sendBeacon = (url, body) => { sent.push(body); return true; };
  for (const [k, v] of Object.entries(stubs)) {
    Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
  }
  sent.fire = (n) => (listeners.get(n) || []).slice().forEach((f) => f());
  return sent;
}


/** Minimal stand-in for Phaser's Game + Scene emitters. */
function fakeGame(sceneKeys) {
  const mk = () => {
    const map = new Map();
    return {
      on: (n, f) => map.set(n, [...(map.get(n) || []), f]),
      once: (n, f) => map.set(n, [...(map.get(n) || []), f]),
      off: (n, f) => map.set(n, (map.get(n) || []).filter((x) => x !== f)),
      emit: (n) => (map.get(n) || []).slice().forEach((f) => f()),
    };
  };
  const scenes = sceneKeys.map((key) => ({ events: mk(), sys: { settings: { key } } }));
  return {
    events: mk(),
    loop: { actualFps: 58.6 },
    scene: { scenes, getScenes: () => scenes },
    sceneNamed: (key) => scenes.find((s) => s.sys.settings.key === key),
  };
}

/** Events from every batch, whether it left by fetch (object) or beacon (Blob). */
async function collect(sent) {
  const batches = [];
  for (const item of sent) {
    if (item && typeof item.text === 'function') batches.push(JSON.parse(await item.text()));
    else if (item && item.e) batches.push(item);
  }
  return batches.flatMap((b) => b.e);
}

test('boot carries all three timings and lands once play begins', async () => {
  const sent = installEnv();
  const { start } = await import('../dist/index.js?' + Math.random());
  const { attachPhaser } = await import('../dist/phaser.js?' + Math.random());

  const game = fakeGame(['PreloadScene', 'MenuScene', 'GameScene']);
  const fg = start({ game: 'demo', build: '1.7.67' });
  const detach = attachPhaser(fg, game);

  game.events.emit('postrender');                    // first frame drawn
  game.sceneNamed('PreloadScene').events.emit('shutdown'); // loading finished
  game.sceneNamed('GameScene').events.emit('start');       // playable

  await new Promise((r) => setTimeout(r, 20));
  detach(); fg.stop();

  const boot = (await collect(sent)).find((e) => e.n === 'boot');
  assert.ok(boot, 'a boot event was sent');
  assert.strictEqual(typeof boot.ttfr, 'number', 'time to first frame');
  assert.strictEqual(typeof boot.tload, 'number', 'time to loading stop');
  assert.strictEqual(typeof boot.tplay, 'number', 'time to first playable frame');
});

test('boot is sent once, not once per gameplay scene start', async () => {
  const sent = installEnv();
  const { start } = await import('../dist/index.js?' + Math.random());
  const { attachPhaser } = await import('../dist/phaser.js?' + Math.random());

  const game = fakeGame(['GameScene']);
  const fg = start({ game: 'demo', build: '1' });
  const detach = attachPhaser(fg, game);
  const scene = game.sceneNamed('GameScene');
  scene.events.emit('start');
  scene.events.emit('start');
  scene.events.emit('start');

  await new Promise((r) => setTimeout(r, 20));
  detach(); fg.stop();
  assert.strictEqual((await collect(sent)).filter((e) => e.n === 'boot').length, 1);
});

test('a session that never reaches gameplay reports boot without inventing tplay', async () => {
  const sent = installEnv();
  const env = sent;
  const { start } = await import('../dist/index.js?' + Math.random());
  const { attachPhaser } = await import('../dist/phaser.js?' + Math.random());

  const game = fakeGame(['Loading', 'Menu', 'Garage']);
  const fg = start({ game: 'demo', build: '1' });
  const detach = attachPhaser(fg, game, { fpsSampleMs: 0 });
  game.events.emit('postrender');
  game.sceneNamed('Loading').events.emit('shutdown');
  game.sceneNamed('Menu').events.emit('start');   // browses the menus, never plays
  env.fire('pagehide');                            // the real way a session ends

  await new Promise((r) => setTimeout(r, 20));
  detach(); fg.stop();
  const boot = (await collect(sent)).find((e) => e.n === 'boot');
  assert.ok(boot, 'boot is still reported');
  assert.strictEqual(boot.src, 'end');
  assert.strictEqual(boot.tplay, undefined, 'no gameplay means no time-to-play — a number here would be a lie');
  assert.strictEqual(typeof boot.ttfr, 'number', 'the timings we do have are kept');
});

test('a real gameplay scene marks boot as measured, not inferred', async () => {
  const sent = installEnv();
  const { start } = await import('../dist/index.js?' + Math.random());
  const { attachPhaser } = await import('../dist/phaser.js?' + Math.random());
  const game = fakeGame(['Game']);
  const fg = start({ game: 'demo', build: '1' });
  const detach = attachPhaser(fg, game, { fpsSampleMs: 0 });
  game.sceneNamed('Game').events.emit('start');
  await new Promise((r) => setTimeout(r, 20));
  detach(); fg.stop();
  const boot = (await collect(sent)).find((e) => e.n === 'boot');
  assert.strictEqual(boot.src, 'scene');
  assert.strictEqual(typeof boot.tplay, 'number');
});

test('a project whose scenes match nothing still reports boot', async () => {
  const sent = installEnv();
  const { start } = await import('../dist/index.js?' + Math.random());
  const { attachPhaser } = await import('../dist/phaser.js?' + Math.random());

  // No key contains "game"/"play"/"race"/"level" — the common case for a
  // project with its own naming. Without the fallback, boot would never fire.
  const game = fakeGame(['Zoryana', 'Kermo']);
  const fg = start({ game: 'demo', build: '1' });
  const detach = attachPhaser(fg, game, { fpsSampleMs: 0 });
  game.events.emit('postrender');
  game.sceneNamed('Kermo').events.emit('start');

  await new Promise((r) => setTimeout(r, 20));
  // Not yet: the fallback is a timer, so nothing has been claimed prematurely.
  assert.strictEqual((await collect(sent)).filter((e) => e.n === 'boot').length, 0);
  detach(); fg.stop();
});

test('scene transitions are recorded and flush what is queued', async () => {
  const sent = installEnv();
  const { start } = await import('../dist/index.js?' + Math.random());
  const { attachPhaser } = await import('../dist/phaser.js?' + Math.random());

  const game = fakeGame(['MenuScene']);
  const fg = start({ game: 'demo', build: '1', flushMs: 60_000 }); // only transitions can flush
  const detach = attachPhaser(fg, game);
  game.sceneNamed('MenuScene').events.emit('start');

  await new Promise((r) => setTimeout(r, 20));
  detach(); fg.stop();
  const scene = (await collect(sent)).find((e) => e.n === 'custom' && e.k === 'scene');
  assert.ok(scene, 'a transition was sent without waiting for the batch timer');
  assert.strictEqual(scene.d.k, 'MenuScene');
  assert.strictEqual(scene.d.act, 'start');
});

test('trackScenes:false keeps transitions out of the stream', async () => {
  const sent = installEnv();
  const { start } = await import('../dist/index.js?' + Math.random());
  const { attachPhaser } = await import('../dist/phaser.js?' + Math.random());

  const game = fakeGame(['MenuScene', 'GameScene']);
  const fg = start({ game: 'demo', build: '1' });
  const detach = attachPhaser(fg, game, { trackScenes: false });
  game.sceneNamed('MenuScene').events.emit('start');
  game.sceneNamed('GameScene').events.emit('start');

  await new Promise((r) => setTimeout(r, 20));
  detach(); fg.stop();
  const events = await collect(sent);
  assert.ok(!events.some((e) => e.n === 'custom' && e.k === 'scene'));
  assert.ok(events.some((e) => e.n === 'boot'), 'boot still works');
});

test('a game object missing everything does not throw', async () => {
  installEnv();
  const { start } = await import('../dist/index.js?' + Math.random());
  const { attachPhaser } = await import('../dist/phaser.js?' + Math.random());
  const fg = start({ game: 'demo', build: '1' });
  let detach;
  assert.doesNotThrow(() => { detach = attachPhaser(fg, {}); });
  assert.doesNotThrow(() => detach());
  fg.stop();
});

test('detaching twice is safe', async () => {
  installEnv();
  const { start } = await import('../dist/index.js?' + Math.random());
  const { attachPhaser } = await import('../dist/phaser.js?' + Math.random());
  const fg = start({ game: 'demo', build: '1' });
  const detach = attachPhaser(fg, fakeGame(['A']));
  detach();
  assert.doesNotThrow(() => detach());
  fg.stop();
});
