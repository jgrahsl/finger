import test from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, bandColor } from '../public/js/bands.js';

test('no colour below the first threshold', () => {
  assert.equal(bandColor(9.99), null);
  assert.equal(bandColor(-2), null);
});

test('each threshold switches to its own distinct colour', () => {
  const colors = [10, 15, 20, 25, 32, 45].map(bandColor);
  assert.deepEqual(colors, BANDS.map((band) => band.color));
  assert.equal(new Set(colors).size, 6);
});

test('a value between thresholds keeps the lower band', () => {
  assert.equal(bandColor(31.9), bandColor(25));
  assert.equal(bandColor(80), bandColor(45));
});
