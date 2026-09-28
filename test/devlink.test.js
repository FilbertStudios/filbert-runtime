/*
 * The dev channel. Two of these tests are security tests and the rest is
 * plumbing: a game embedded by someone else must not be drivable by them, and
 * a production build must not open a listener at all.
 */

import test from 'node:test';
import assert from 'node:assert';

const PANEL = 'https://dev.filbert.games';

function installEnv({ search = '', canvas = null } = {}) {
  const posts = [];
  const listeners = new Map();
  const store = new Map();
  const parent = { postMessage: (msg, origin) => posts.push({ msg, origin }) };

  const stubs = {
    location: { hostname: 'play.filbert.games', origin: 'https://play.filbert.games', search },
    // `self` must be distinct from `parent`, or the SDK correctly decides it is
    // the top document and there is nobody to talk to.
    self: { marker: 'self' },
    parent,
    document: { referrer: '', visibilityState: 'visible', querySelector: () => canvas },
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 3,
    crossOriginIsolated: true,
    navigator: {
      language: 'uk-UA',
      sendBeacon: () => true,
      connection: { effectiveType: '4g', downlink: 10, rtt: 50 },
    },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    addEventListener: (name, fn) => { listeners.set(name, fn); },
    removeEventListener: (name) => { listeners.delete(name); },
    fetch: async () => ({ status: 204 }),
    performance: {
      now: () => 123.456,
      timeOrigin: 1000,
      setResourceTimingBufferSize: () => {},
    },
    PerformanceObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  return {
    posts,
    /** Deliver a message as the browser would, with an origin we control. */
    deliver: (data, origin = PANEL) => listeners.get('message')?.({ origin, data }),
    has: (name) => listeners.has(name),
  };
}

const loadSdk = () => import('../dist/index.js?' + Math.random());
const devOn = `?devsdk=1&panel=${encodeURIComponent(PANEL)}&run=r1`;

test('a production build opens nothing', async () => {
  const env = installEnv({ search: '' });
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });

  assert.equal(env.posts.length, 0, 'no handshake without ?devsdk=1');
  assert.equal(env.has('message'), false, 'no inbound listener in a shipped game');
  assert.equal(c.debug().dev, false);
  c.stop();
});

test('an unusable panel origin is refused', async () => {
  for (const bad of ['', 'javascript:alert(1)', 'not-a-url', 'ftp://x.example']) {
    const env = installEnv({ search: `?devsdk=1&panel=${encodeURIComponent(bad)}&run=r1` });
    const { start } = await loadSdk();
    const c = start({ game: 'demo', build: '1' });
    assert.equal(env.posts.length, 0, `panel="${bad}" must not be addressed`);
    c.stop();
  }
});

test('the handshake names the origin and never uses a wildcard', async () => {
  const env = installEnv({ search: devOn });
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });

  assert.equal(env.posts.length, 1);
  const { msg, origin } = env.posts[0];
  assert.equal(origin, PANEL, 'messages go to the named panel, never "*"');
  assert.equal(msg.kind, 'hello');
  assert.equal(msg.run, 'r1');
  assert.equal(typeof msg.timeOrigin, 'number', 'without timeOrigin the two clocks never line up');
  assert.ok(msg.caps.includes('resources') && msg.caps.includes('frames'));
  assert.ok(!msg.caps.includes('cmd'), 'no command channel configured, so none is offered');
  c.stop();
});

test('what happens before the panel answers is held, not lost', async () => {
  const env = installEnv({ search: devOn });
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });

  c.ready();
  c.loadingFinished();
  assert.equal(env.posts.length, 1, 'still only the hello: the panel is not listening yet');

  env.deliver({ kind: 'hello_ack', run: 'r1' });

  const kinds = env.posts.map((p) => p.msg.kind);
  assert.deepEqual(kinds, ['hello', 'env', 'phase', 'phase'],
    'the start of loading is the interesting part, so it is replayed in order');
  c.stop();
});

test('a message from anywhere but the panel is ignored', async () => {
  const env = installEnv({ search: devOn });
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1', commandGlobal: '__cmd' });

  // A page that embeds our game must not be able to drive it.
  env.deliver({ kind: 'hello_ack', run: 'r1' }, 'https://evil.example');
  env.deliver({ kind: 'cmd', run: 'r1', text: 'level 3' }, 'https://evil.example');

  assert.equal(env.posts.length, 1, 'the handshake was never completed by a stranger');
  assert.equal(globalThis.__cmd, undefined, 'and nothing was typed into the game');
  c.stop();
});

test('a command reaches the channel the game polls', async () => {
  const env = installEnv({ search: devOn });
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1', commandGlobal: '__cmd' });

  assert.ok(env.posts[0].msg.caps.includes('cmd'), 'a configured channel is announced');
  env.deliver({ kind: 'hello_ack', run: 'r1' });
  env.deliver({ kind: 'cmd', run: 'r1', text: 'level 3' });

  assert.equal(globalThis.__cmd, 'level 3');
  c.stop();
});

test('an unknown kind from a newer panel does not throw', async () => {
  const env = installEnv({ search: devOn });
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });
  env.deliver({ kind: 'hello_ack', run: 'r1' });

  const before = env.posts.length;
  env.deliver({ kind: 'something_from_the_future', run: 'r1' });
  assert.equal(env.posts.length, before, 'ignored silently, not answered and not thrown');
  c.stop();
});

test('a message aimed at a previous run is dropped', async () => {
  const env = installEnv({ search: devOn });
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });

  // The panel reloads the iframe; a late message from the old one must not be
  // mistaken for this run's handshake.
  env.deliver({ kind: 'hello_ack', run: 'r0' });
  assert.equal(env.posts.length, 1);
  c.stop();
});

test('snapshot replays the environment and every mark', async () => {
  const env = installEnv({ search: devOn, canvas: { width: 800, height: 600 } });
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '7' });

  env.deliver({ kind: 'hello_ack', run: 'r1' });
  c.ready();
  c.phase('menu');
  const before = env.posts.length;
  env.deliver({ kind: 'snapshot', run: 'r1' });

  const replay = env.posts.slice(before).map((p) => p.msg);
  assert.equal(replay[0].kind, 'env');
  assert.equal(replay[0].build, '7');
  assert.equal(replay[0].isolated, true);
  assert.deepEqual(replay[0].canvas, { w: 800, h: 600 });
  assert.deepEqual(replay.slice(1).map((m) => m.p), ['ready', 'menu']);
  c.stop();
});

test('stopping the client closes the channel', async () => {
  const env = installEnv({ search: devOn });
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });
  env.deliver({ kind: 'hello_ack', run: 'r1' });
  c.stop();

  assert.equal(env.has('message'), false, 'the inbound listener is gone');
});
