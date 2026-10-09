import test from 'node:test';
import assert from 'node:assert/strict';
import { firstBeat, nextBeat, remaining, toneFor } from '../public/src/interval.js';

function run(config, count) {
  const beats = [];
  let state = firstBeat(config);
  for (let i = 0; i < count; i++) {
    beats.push(`${toneFor(state, config)}:${remaining(state, config)}:${state.rep}`);
    state = nextBeat(state, config);
  }
  return beats;
}

test('starts with a 5 s get-ready phase, then 7 s work / 3 s rest', () => {
  assert.deepEqual(run({ ready: 5, work: 7, rest: 3 }, 17), [
    'ready:5:1', 'ready:4:1', 'ready:3:1', 'prepare:2:1', 'last:1:1',
    'start:7:1', 'work:6:1', 'work:5:1', 'work:4:1', 'work:3:1', 'work:2:1', 'work:1:1',
    'end:3:1', 'prepare:2:1', 'last:1:1',
    'start:7:2', 'work:6:2',
  ]);
});

test('get ready happens only once', () => {
  const beats = run({ ready: 3, work: 1, rest: 1 }, 9);
  assert.equal(beats.filter((beat) => beat.startsWith('ready')).length, 1);
  assert.equal(beats.at(-1), 'last:1:3');
});

test('a rest of 0 goes straight to the next rep', () => {
  assert.deepEqual(run({ ready: 0, work: 2, rest: 0 }, 4), ['start:2:1', 'work:1:1', 'start:2:2', 'work:1:2']);
});

test('a long rest signals the end of work, then is silent until its last three seconds', () => {
  const beats = run({ ready: 0, work: 1, rest: 10 }, 12);
  assert.deepEqual(beats.slice(1, 11).map((beat) => beat.split(':')[0]), [
    'end', 'null', 'null', 'null', 'null', 'null', 'null', 'rest', 'prepare', 'last',
  ]);
  assert.equal(beats[11], 'start:1:2');
});
