import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, firstBeat, idleRepProgress, nextBeat, remaining, repProgress, shownRep, toneFor } from '../public/js/interval.js';

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

test('advancing by several beats lands where single steps would', () => {
  const config = { ready: 5, work: 7, rest: 3 };
  // 5 s ready, then 10 s per rep: 62 s in is the first second of rep 6's rest.
  assert.deepEqual(advance(firstBeat(config), config, 62), { phase: 'rest', beat: 0, rep: 6 });
  assert.deepEqual(advance(firstBeat(config), config, 0), firstBeat(config));
});

test('the rest after the tenth work shows rep 10', () => {
  const config = { ready: 5, work: 7, rest: 3 };
  // 5 s ready + 9 full reps of 10 s + the tenth work of 7 s.
  const state = advance(firstBeat(config), config, 5 + 9 * 10 + 7);
  assert.deepEqual(state, { phase: 'rest', beat: 0, rep: 10 });
  assert.equal(advance(state, config, 2).rep, 10); // to the end of that rest
  assert.equal(advance(state, config, 3).rep, 11); // the next work is rep 11
});

test('reps show 0 while getting ready, and the coming rep with the cue before work', () => {
  const config = { ready: 5, work: 7, rest: 3 };
  const shown = [];
  let state = firstBeat(config);
  for (let i = 0; i < 25; i++, state = nextBeat(state, config)) shown.push(shownRep(state, config));
  assert.deepEqual(shown, [
    0, 0, 0, 0, 1, // get ready, then the cue before work 1
    1, 1, 1, 1, 1, 1, 1, // work 1
    1, 1, 2, // rest, then the cue before work 2
    2, 2, 2, 2, 2, 2, 2, // work 2
    2, 2, 3,
  ]);
});

test('rep progress fills up exactly when the rep count goes up', () => {
  const config = { ready: 5, work: 7, rest: 3 };
  let state = firstBeat(config);
  const seen = [];
  for (let i = 0; i < 26; i++, state = nextBeat(state, config)) {
    const { kind, total, elapsed } = repProgress(state, config);
    seen.push(`${kind === 'ready' ? 'g' : 'r'}${elapsed}/${total}:${shownRep(state, config)}`);
  }
  assert.deepEqual(seen, [
    'g0/4:0', 'g1/4:0', 'g2/4:0', 'g3/4:0', // get ready
    'r0/10:1', // cue before work 1: the count goes up and the bar starts again
    'r1/10:1', 'r2/10:1', 'r3/10:1', 'r4/10:1', 'r5/10:1', 'r6/10:1', 'r7/10:1', // work
    'r8/10:1', 'r9/10:1', // rest
    'r0/10:2', // cue before work 2
    'r1/10:2', 'r2/10:2', 'r3/10:2', 'r4/10:2', 'r5/10:2', 'r6/10:2', 'r7/10:2',
    'r8/10:2', 'r9/10:2',
    'r0/10:3', 'r1/10:3',
  ]);
  assert.deepEqual(repProgress(firstBeat(config), config).parts, [{ kind: 'ready', seconds: 4 }]);
  assert.deepEqual(idleRepProgress(config).parts, [
    { kind: 'cue', seconds: 1 },
    { kind: 'work', seconds: 7 },
    { kind: 'rest', seconds: 2 },
  ]);
});
