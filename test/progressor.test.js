import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotification, ResponseTag } from '../public/src/progressor.js';

function packet(tag, payload) {
  const bytes = new Uint8Array(2 + payload.byteLength);
  bytes[0] = tag;
  bytes[1] = payload.byteLength;
  bytes.set(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength), 2);
  return new DataView(bytes.buffer);
}

function weights(...samples) {
  const view = new DataView(new ArrayBuffer(samples.length * 8));
  samples.forEach(([weight, time], i) => {
    view.setFloat32(i * 8, weight, true);
    view.setUint32(i * 8 + 4, time, true);
  });
  return view;
}

test('parses multiple weight samples from one packet', () => {
  const { tag, samples } = parseNotification(packet(ResponseTag.WEIGHT_MEASURE, weights([12.5, 0], [13.25, 12500])));
  assert.equal(tag, ResponseTag.WEIGHT_MEASURE);
  assert.deepEqual(samples, [
    { weight: 12.5, time: 0 },
    { weight: 13.25, time: 12500 },
  ]);
});

test('respects the byteOffset of the incoming view', () => {
  const inner = packet(ResponseTag.WEIGHT_MEASURE, weights([-1.5, 42]));
  const padded = new Uint8Array(inner.byteLength + 3);
  padded.set(new Uint8Array(inner.buffer), 3);
  const { samples } = parseNotification(new DataView(padded.buffer, 3));
  assert.deepEqual(samples, [{ weight: -1.5, time: 42 }]);
});

test('ignores a truncated trailing sample', () => {
  const full = packet(ResponseTag.WEIGHT_MEASURE, weights([1, 1], [2, 2]));
  const { samples } = parseNotification(new DataView(full.buffer, 0, full.byteLength - 3));
  assert.deepEqual(samples, [{ weight: 1, time: 1 }]);
});

test('exposes the payload of a command response', () => {
  const payload = new DataView(new ArrayBuffer(4));
  payload.setUint32(0, 3850, true);
  const result = parseNotification(packet(ResponseTag.CMD_RESPONSE, payload));
  assert.equal(result.tag, ResponseTag.CMD_RESPONSE);
  assert.equal(result.samples, undefined);
  assert.equal(result.payload.getUint32(0, true), 3850);
});
