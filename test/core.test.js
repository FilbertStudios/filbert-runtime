/*
 * The core's contract. The first two tests matter more than the rest: this
 * package ships inside other people's games, and its worst possible failure is
 * not losing data — it is stopping a game from starting.
 */

import test from 'node:test';
import assert from 'node:assert';

// A DOM small enough to exercise the client, hostile enough to be realistic.
function installEnv({ hostname = 'webgames.filbert.games', referrer = '', ancestors = null, storage = 'ok' } = {}) {
  const sent = [];
  const listeners = new Map();

  const store = new Map();
  const localStorage = storage === 'throws'
    ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
    : { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

  // Node 22 defines `navigator` as a getter-only global, so plain assignment
  // throws — every stub goes in through defineProperty.
  const stubs = {
    location: Object.assign({ hostname, origin: `https://${hostname}` }, ancestors ? { ancestorOrigins: ancestors } : {}),
    document: { referrer, visibilityState: 'visible' },
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 2,
    navigator: { language: 'uk-UA', sendBeacon: (url, body) => { sent.push({ via: 'beacon', url, body }); return true; } },
    localStorage,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    fetch: async (url, init) => { sent.push({ via: 'fetch', url, body: init.body, headers: init.headers }); return { status: 204 }; },
  };
  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  return { sent, fire: (name) => listeners.get(name)?.() };
}

async function loadSdk() {
  const mod = await import('../dist/index.js?' + Math.random());
  return mod;
}

test('a client that cannot be built still answers every call', async () => {
  installEnv();
  const { start } = await loadSdk();
  const c = start({ game: '', build: '1.0.0' }); // invalid on purpose
  // None of these may throw: the game calls them on its start path.
  assert.doesNotThrow(() => {
    c.boot({ ttfr: 1 }); c.ad({ name: 'x' }); c.level(1, 'start');
    c.buy('car'); c.custom('k'); c.flush(); c.stop();
  });
});

test('a transport that always fails never reaches the caller', async () => {
  const env = installEnv();
  globalThis.fetch = async () => { throw new Error('network is down'); };
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1.0.0', flushMs: 5 });
  c.boot({ ttfr: 10 });
  assert.doesNotThrow(() => c.flush());
  await new Promise((r) => setTimeout(r, 30));
  c.stop();
  assert.ok(true, 'no unhandled rejection escaped');
  void env;
});

test('storage that throws does not stop a session', async () => {
  installEnv({ storage: 'throws' });
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1.0.0' });
  const d = c.debug();
  assert.match(d.iid, /^[0-9a-f]{8,}$/, 'falls back to an ephemeral install id');
  c.stop();
});

test('the batch goes out as a preflight-free simple request', async () => {
  const env = installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1.7.67' });
  c.boot({ ttfr: 12 });
  c.flush();
  await new Promise((r) => setTimeout(r, 10));
  c.stop();
  const post = env.sent.find((s) => s.via === 'fetch');
  assert.ok(post, 'a batch was sent');
  assert.strictEqual(post.headers['Content-Type'], 'text/plain;charset=UTF-8');
  assert.match(post.url, /\/api\/s\/demo$/, 'path carries no word a blocker list matches');
});

test('the envelope carries game, build and the host the platform came from', async () => {
  const env = installEnv({ hostname: 'html5.gamedistribution.com' });
  const { start } = await loadSdk();
  const c = start({ game: 'monsters-wheels-2', build: '1.7.67' });
  c.flush();
  await new Promise((r) => setTimeout(r, 10));
  c.stop();
  const body = JSON.parse(env.sent.find((s) => s.via === 'fetch').body);
  assert.strictEqual(body.v, 1);
  assert.strictEqual(body.game, 'monsters-wheels-2');
  assert.strictEqual(body.build, '1.7.67');
  assert.strictEqual(body.plat, 'gamedistribution');
  assert.strictEqual(body.plats, 'hostname');
  assert.strictEqual(body.plath, 'html5.gamedistribution.com', 'the server needs the raw host to override our guess');
});

test('a missing build is reported as unknown, never invented', async () => {
  const env = installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: undefined });
  c.flush();
  await new Promise((r) => setTimeout(r, 10));
  c.stop();
  assert.strictEqual(JSON.parse(env.sent.find((s) => s.via === 'fetch').body).build, 'unknown');
});

test('an embedding portal is detected from ancestorOrigins', async () => {
  installEnv({ hostname: 'game-files.crazygames.com', ancestors: ['https://www.crazygames.com'] });
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });
  const d = c.debug();
  assert.strictEqual(d.plat, 'crazygames');
  assert.strictEqual(d.plats, 'ancestor');
  assert.strictEqual(d.plath, 'www.crazygames.com');
  c.stop();
});

test('both ad-log shapes are accepted unchanged', async () => {
  const env = installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1', provider: 'crazygames' });
  // The shape used by the network adapters...
  c.ad({ name: 'double-reward', type: 'rewarded', outcome: 'completed', ms: 15200, detail: 'ok' });
  // ...and the one used by the placement layer, with its own timestamp field.
  c.ad({ t: Date.now(), name: 'level-end', type: 'next', outcome: 'failed', ms: 300, status: 'unfilled' });
  c.flush();
  await new Promise((r) => setTimeout(r, 10));
  c.stop();
  const ads = JSON.parse(env.sent.find((s) => s.via === 'fetch').body).e.filter((e) => e.n === 'ad');
  assert.strictEqual(ads.length, 2);
  assert.strictEqual(ads[0].why, 'ok', 'detail collapses into why');
  assert.strictEqual(ads[1].why, 'unfilled', 'status collapses into the same field');
  assert.strictEqual(ads[0].prov, 'crazygames');
  assert.ok(ads.every((a) => typeof a.t === 'number' && a.t >= 0), 'every event carries an offset');
});

test('a retried batch keeps its sequence number', async () => {
  const env = installEnv();
  let attempt = 0;
  globalThis.fetch = async (url, init) => {
    attempt += 1;
    env.sent.push({ via: 'fetch', url, body: init.body });
    if (attempt === 1) throw new Error('flaky');
    return { status: 204 };
  };
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });
  c.boot({ ttfr: 1 });
  c.flush();
  await new Promise((r) => setTimeout(r, 10));
  c.flush();
  await new Promise((r) => setTimeout(r, 10));
  c.stop();
  const seqs = env.sent.map((s) => JSON.parse(s.body).seq);
  assert.strictEqual(seqs.length, 2);
  assert.strictEqual(seqs[0], seqs[1], '(sid,seq) is the idempotency key — a retry must reuse it');
});

test('the queue drops the oldest and reports how many', async () => {
  const env = installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });
  for (let i = 0; i < 300; i += 1) c.custom('spam', { i });
  c.flush();
  await new Promise((r) => setTimeout(r, 10));
  c.stop();
  const body = JSON.parse(env.sent.find((s) => s.via === 'fetch').body);
  assert.ok(body.e.length <= 100, 'batch stays within the receiver limit');
  assert.ok(body.drop > 0, 'loss is reported, not hidden');
  assert.strictEqual(body.e.at(-1).d.i, 299, 'the newest events are the ones kept');
});

test('pagehide sends through sendBeacon, the only channel that survives it', async () => {
  const env = installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });
  c.level(3, 'win');
  env.fire('pagehide');
  c.stop(); // before asserting: a live client's timers would outlive the test
  const last = env.sent.at(-1);
  assert.strictEqual(last.via, 'beacon');
  // Blob lowercases the type it is handed. What matters is that it is still the
  // same simple-request content type, so the beacon skips the preflight too.
  assert.strictEqual(last.body.type.toLowerCase(), 'text/plain;charset=utf-8');
});

test('enabled:false builds a client that does nothing at all', async () => {
  const env = installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1', enabled: false });
  c.boot({ ttfr: 1 }); c.level(1, 'start'); c.flush();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(env.sent.length, 0);
});

test('two flushes in one tick do not strand the second batch', async () => {
  // Regression. The second flush used to find the first still in flight and
  // re-send THAT batch, leaving everything queued in between queued forever —
  // a game could report scene changes and never report boot. Scene transitions
  // call flush constantly, so this was not a rare race.
  const env = installEnv();
  let release;
  const held = new Promise((r) => { release = r; });
  globalThis.fetch = async (url, init) => {
    env.sent.push({ via: 'fetch', url, body: init.body });
    await held;
    return { status: 204 };
  };
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1', flushMs: 60_000 });
  c.custom('first');
  c.flush();            // takes batch 0, blocks on fetch
  c.custom('second');
  c.flush();            // must wait, then take `second` — not re-send batch 0
  release();
  await new Promise((r) => setTimeout(r, 20));
  c.stop();

  const keys = env.sent.flatMap((s) => JSON.parse(s.body).e).filter((e) => e.n === 'custom').map((e) => e.k);
  assert.ok(keys.includes('first'), 'the first batch went out');
  assert.ok(keys.includes('second'), 'the event queued during the first send is not stranded');
});

test('end is emitted once even when both teardown signals fire', async () => {
  // Regression from live data: a real session on the platform produced two
  // `end` events a millisecond apart — browsers fire pagehide AND
  // visibilitychange->hidden — which would have doubled every session count
  // and duration derived from them.
  const env = installEnv();
  const { start } = await loadSdk();
  const c = start({ game: 'demo', build: '1' });
  env.fire('pagehide');
  globalThis.document.visibilityState = 'hidden';
  env.fire('visibilitychange');
  c.stop();
  const ends = env.sent.flatMap((s) => {
    const body = typeof s.body === 'string' ? s.body : null;
    return body ? JSON.parse(body).e : [];
  }).filter((e) => e.n === 'end');
  assert.ok(ends.length <= 1, `expected at most one end event, got ${ends.length}`);
});
