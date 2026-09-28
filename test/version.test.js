import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SDK_VERSION, SDK_MARKER, PROTOCOL } from '../dist/version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/*
 * Drift here is silent and expensive: the platform's upload scan would report a
 * version the shipped build does not carry, and "your build is current" is a
 * worse answer than no answer. So the three places a version is written are
 * pinned to each other.
 */

test('SDK_VERSION matches package.json', () => {
  assert.equal(SDK_VERSION, pkg.version);
});

test('the marker embeds exactly that version', () => {
  assert.equal(SDK_MARKER, `filbert-runtime@${SDK_VERSION}`);
});

test('the marker is a literal the platform regex can find', () => {
  const found = /filbert-runtime@(\d+\.\d+\.\d+)/.exec(SDK_MARKER);
  assert.ok(found, 'marker must match the scan pattern');
  assert.equal(found[1], SDK_VERSION);
});

test('the marker survives into the built output as an unbroken literal', () => {
  // The whole mechanism rests on this: if a build step ever breaks the literal
  // apart, the scan goes blind and nothing else in the suite would notice.
  const built = readFileSync(new URL('../dist/version.js', import.meta.url), 'utf8');
  assert.ok(built.includes(`'filbert-runtime@${SDK_VERSION}'`)
    || built.includes(`"filbert-runtime@${SDK_VERSION}"`),
  'dist/version.js must contain the marker as one string literal');
});

test('PROTOCOL is a positive integer', () => {
  assert.ok(Number.isInteger(PROTOCOL) && PROTOCOL > 0);
});
