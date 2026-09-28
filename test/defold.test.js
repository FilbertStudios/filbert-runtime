/*
 * The Defold adapter. Two of these matter more than the rest: the adapter must
 * not be able to stop a game from starting, and it must not claim the game is
 * loaded when only the downloads are.
 */

import test from 'node:test';
import assert from 'node:assert';

/** A client that records what it was told, standing in for the real one. */
function fakeClient() {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    names: () => calls.map((c) => c[0]),
    phases: () => calls.filter((c) => c[0] === 'phase').map((c) => c[1]),
    ready: record('ready'),
    loadingFinished: record('loadingFinished'),
    gameplayStart: record('gameplayStart'),
    gameplayStop: record('gameplayStop'),
    phase: record('phase'),
    custom: record('custom'),
    marks: () => [],
    boot: () => {}, onBeforeEnd: () => {}, ad: () => {}, level: () => {},
    buy: () => {}, flush: () => {}, stop: () => {}, debug: () => ({}),
  };
}

function installEnv({ resources = [], isolated = false } = {}) {
  const stubs = {
    performance: {
      now: () => 1,
      timeOrigin: 0,
      getEntriesByType: () => resources,
      setResourceTimingBufferSize: () => {},
    },
    crossOriginIsolated: isolated,
  };
  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  for (const key of ['Module', 'Progress', '__cec2d_perf', '__cec2d_cmd', '__filbert']) {
    Object.defineProperty(globalThis, key, { value: undefined, writable: true, configurable: true });
  }
}

const loadAdapter = () => import('../dist/defold.js?' + Math.random());

test('the bridge answers every call with a string', async () => {
  installEnv();
  const { attachDefold } = await loadAdapter();
  const client = fakeClient();
  const detach = attachDefold(client);

  const bridge = globalThis.__filbert;
  // html5.run hands its result back to Lua, where a non-string is a type error
  // in the game rather than here.
  for (const method of ['ready', 'loadingFinished', 'gameplayStart', 'gameplayStop', 'cmd']) {
    assert.equal(typeof bridge[method](), 'string', `${method}() must return a string`);
  }
  assert.equal(typeof bridge.phase('menu'), 'string');
  assert.deepEqual(client.names().slice(0, 4),
    ['ready', 'loadingFinished', 'gameplayStart', 'gameplayStop']);
  detach();
});

test('the engine callback is chained, never replaced', async () => {
  installEnv();
  let engineStarted = false;
  globalThis.Module = { onRuntimeInitialized: () => { engineStarted = true; } };

  const { attachDefold } = await loadAdapter();
  const client = fakeClient();
  const detach = attachDefold(client);

  globalThis.Module.onRuntimeInitialized();

  // Dropping the loader's own callback would stop the game from starting, which
  // is the single failure this package must never cause.
  assert.equal(engineStarted, true, "the loader's callback still runs");
  assert.ok(client.names().includes('ready'));
  detach();
});

test('a throwing SDK still lets the engine start', async () => {
  installEnv();
  let engineStarted = false;
  globalThis.Module = { onRuntimeInitialized: () => { engineStarted = true; } };

  const { attachDefold } = await loadAdapter();
  const client = fakeClient();
  client.ready = () => { throw new Error('telemetry exploded'); };
  const detach = attachDefold(client);

  globalThis.Module.onRuntimeInitialized();
  assert.equal(engineStarted, true, 'our failure must not become the game\'s failure');
  detach();
});

test('detaching puts the loader back exactly as it was', async () => {
  installEnv();
  const original = () => {};
  globalThis.Module = { onRuntimeInitialized: original };
  const priorBridge = 'someone-elses';
  globalThis.__filbert = priorBridge;

  const { attachDefold } = await loadAdapter();
  const detach = attachDefold(fakeClient());
  detach();

  assert.equal(globalThis.Module.onRuntimeInitialized, original);
  assert.equal(globalThis.__filbert, priorBridge);
  detach(); // twice is safe
});

test('loader progress is reported, but never as loadingFinished', async () => {
  installEnv();
  const calls = [];
  globalThis.Progress = { updateProgress: (p) => calls.push(p) };

  const { attachDefold } = await loadAdapter();
  const client = fakeClient();
  const detach = attachDefold(client);

  for (const p of [10, 30, 60, 80, 100]) globalThis.Progress.updateProgress(p);

  assert.deepEqual(calls, [10, 30, 60, 80, 100], "the loader's own progress still runs");
  assert.deepEqual(client.phases(), ['load_25', 'load_50', 'load_75', 'load_100']);
  // "Assets downloaded" is not "a player can touch the first screen" — in this
  // game those are minutes apart, so only the game may say the second one.
  assert.ok(!client.names().includes('loadingFinished'),
    'progress reaching 100% must not be mistaken for the game being ready');
  detach();
});

test('progress steps are reported once each', async () => {
  installEnv();
  globalThis.Progress = { updateProgress: () => {} };
  const { attachDefold } = await loadAdapter();
  const client = fakeClient();
  const detach = attachDefold(client);

  for (const p of [100, 100, 100]) globalThis.Progress.updateProgress(p);
  assert.deepEqual(client.phases(), ['load_25', 'load_50', 'load_75', 'load_100']);
  detach();
});

test('the engine variant that actually arrived is reported', async () => {
  installEnv({
    isolated: true,
    resources: [
      { name: 'https://play.filbert.games/g/0.20/dmloader.js', transferSize: 1000 },
      { name: 'https://play.filbert.games/g/0.20/careatscar_pthread.wasm', transferSize: 6178000 },
    ],
  });
  const { attachDefold } = await loadAdapter();
  const client = fakeClient();
  const detach = attachDefold(client);

  const engine = client.calls.find((c) => c[0] === 'custom' && c[1] === 'engine');
  assert.ok(engine, 'a bundle ships both wasm builds and only one is fetched');
  assert.equal(engine[2].file, 'careatscar_pthread.wasm');
  assert.equal(engine[2].pthread, true);
  assert.equal(engine[2].bytes, 6178000);
  // The same line doubles as proof the dev host's COOP/COEP took effect.
  assert.equal(engine[2].isolated, true);
  detach();
});

test('a command is handed over once, then cleared', async () => {
  installEnv();
  const { attachDefold } = await loadAdapter();
  const detach = attachDefold(fakeClient());

  globalThis.__cec2d_cmd = 'level 3';
  assert.equal(globalThis.__filbert.cmd(), 'level 3');
  assert.equal(globalThis.__filbert.cmd(), '', 'a command obeyed twice is a bug, not a feature');
  detach();
});

test('marks from a build that has not migrated are adopted', async () => {
  installEnv();
  globalThis.__cec2d_perf = [{ mark: 'menu', t: 10 }, { mark: 'lobby', t: 20 }];

  const { attachDefold } = await loadAdapter();
  const client = fakeClient();
  const detach = attachDefold(client, { adoptLegacyMarks: true });

  await new Promise((r) => setTimeout(r, 1100));
  assert.deepEqual(client.phases(), ['menu', 'lobby']);

  // A second pass must not replay what it already took.
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepEqual(client.phases(), ['menu', 'lobby']);
  detach();
});

test('a page with no Defold on it attaches and does nothing', async () => {
  installEnv();
  const { attachDefold } = await loadAdapter();
  const client = fakeClient();
  const detach = attachDefold(client, { adoptLegacyMarks: false });

  assert.deepEqual(client.names(), [], 'no Module, no Progress, no wasm: nothing to say');
  detach();
});
