import test from 'node:test';
import assert from 'node:assert/strict';
import { PullDetector, analyzePull } from '../public/js/rfd.js';

const RATE_HZ = 80;

// Force for a pull that ramps at `slope` kg/s to `peak`, holds, then lets go.
function ramp(slope, peak, holdS) {
  return (t) => {
    if (t < 1) return 0;
    const rise = (t - 1) * slope;
    if (rise < peak) return rise;
    return t - 1 < peak / slope + holdS ? peak : 0;
  };
}

function detect(force, seconds) {
  const detector = new PullDetector();
  const pulls = [];
  for (let i = 0; i < seconds * RATE_HZ; i++) {
    const pull = detector.push(i / RATE_HZ, force(i / RATE_HZ));
    if (pull) pulls.push(pull);
  }
  return pulls;
}

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('a linear 100 kg/s ramp to 30 kg is measured as such', () => {
  const [pull, ...rest] = detect(ramp(100, 30, 1), 4);
  assert.equal(rest.length, 0);
  near(pull.peak, 30, 0.01);
  near(pull.peakRfd, 100, 1);
  near(pull.rfd2080, 100, 2);
  // From the 2 kg onset to 30 kg at 100 kg/s, give or take a sample.
  near(pull.timeToPeak, 0.28, 2 / RATE_HZ);
});

test('times are relative to the onset and include a short lead-in', () => {
  const [pull] = detect(ramp(100, 30, 1), 4);
  assert.ok(pull.times[0] < 0 && pull.times[0] >= -0.3);
  assert.ok(pull.times.includes(0));
});

test('peak RFD is the steepest part of the rise, not the average', () => {
  // 40 kg/s to 8 kg, then 200 kg/s to 28 kg.
  const force = (t) => {
    if (t < 1) return 0;
    if (t < 1.2) return (t - 1) * 40;
    if (t < 1.3) return 8 + (t - 1.2) * 200;
    return t < 2 ? 28 : 0;
  };
  const [pull] = detect(force, 3);
  near(pull.peakRfd, 200, 5);
  assert.ok(pull.rfd2080 < pull.peakRfd);
});

test('bumps below the minimum peak are ignored, and each pull is reported once', () => {
  const force = (t) => (t > 0.5 && t < 0.8 ? 3 : ramp(100, 20, 0.5)(t - 1) + ramp(150, 25, 0.5)(t - 3));
  const pulls = detect(force, 6);
  assert.equal(pulls.length, 2);
  near(pulls[0].peak, 20, 0.01);
  near(pulls[1].peak, 25, 0.01);
});

test('a pull already under way when the stream starts is not an attempt', () => {
  const detector = new PullDetector();
  const pulls = [];
  // Joins mid-hold at 28 kg, lets go, then makes one real pull.
  const force = (t) => (t < 2 ? 28 : ramp(100, 30, 1)(t - 2));
  for (let i = 0; i < 7 * RATE_HZ; i++) {
    const pull = detector.push(i / RATE_HZ, force(i / RATE_HZ));
    if (pull) pulls.push(pull);
  }
  assert.equal(pulls.length, 1);
  near(pulls[0].peakRfd, 100, 1);
});

test('a break in the stream discards the pull in progress', () => {
  const detector = new PullDetector();
  const pulls = [];
  const feed = (from, to, force) => {
    for (let i = from * RATE_HZ; i < to * RATE_HZ; i++) {
      const pull = detector.push(i / RATE_HZ, force(i / RATE_HZ));
      if (pull) pulls.push(pull);
    }
  };
  feed(0, 1.2, ramp(100, 30, 5)); // onset, then the stream stops mid-rise
  feed(20, 22, () => 28); // resumes during a different hold
  feed(22, 23, () => 0);
  assert.equal(pulls.length, 0);
});

test('a pull is recognised even if the force never returns to zero', () => {
  // Releases to 4 kg, which stays above the onset level.
  const force = (t) => (t > 2.5 ? 4 : ramp(100, 30, 1)(t));
  const pulls = detect(force, 4);
  assert.equal(pulls.length, 1);
  near(pulls[0].peak, 30, 0.01);
  near(pulls[0].peakRfd, 100, 1);
});

test('an untared resting level is the reference for the pull', () => {
  const [pull, ...rest] = detect((t) => 3 + ramp(100, 30, 1)(t), 4);
  assert.equal(rest.length, 0);
  near(pull.peak, 33, 0.01); // as measured
  near(pull.peakRfd, 100, 1);
  near(pull.rfd2080, 100, 2);
});

test('a slow rise is not an attempt', () => {
  assert.equal(detect(ramp(5, 20, 1), 8).length, 0);
});

test('a pull that is held is reported after five seconds', () => {
  const detector = new PullDetector();
  let reportedAt = null;
  for (let i = 0; i < 20 * RATE_HZ && reportedAt === null; i++) {
    if (detector.push(i / RATE_HZ, ramp(100, 30, 60)(i / RATE_HZ))) reportedAt = i / RATE_HZ;
  }
  near(reportedAt, 6, 0.1); // onset just after t = 1 s
});

test('a rise shorter than the RFD window still yields a slope', () => {
  const times = [0, 0.0125, 0.025];
  const { peakRfd } = analyzePull(times, [0, 3, 6], 1);
  near(peakRfd, 240, 1);
});
