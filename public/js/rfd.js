// Rate of force development (RFD), computed from the force stream.
//
// Pulls are picked out of the stream without any prompting. The resting level
// is whatever the force settles at while it is steady; a pull begins when the
// force rises ONSET_KG above that, and ends once it has dropped to half its
// peak (or back below the onset), or after MAX_PULL_S. Only a clear pull
// counts: high enough and fast enough. Times handed out are in seconds
// relative to the onset.

// Shown in the header; bump together with the others on every change, so a
// stale cached file shows up as a mismatch.
export const RFD_BUILD = 15;

export const ONSET_KG = 2;
/** Pulls that never rise this far above the resting level are dropped. */
export const MIN_PEAK_KG = 5;
/** So are slow ones, such as picking the device up or easing into a hang. */
export const MIN_PEAK_RFD = 20;
/** Peak RFD is the steepest rise over a window of this length. */
export const RFD_WINDOW_S = 0.1;
const PRE_ROLL_S = 0.25;
const MAX_PULL_S = 5;
/** A break in the stream this long discards whatever was in progress. */
const MAX_GAP_S = 0.5;
/** The force is at rest when it stays within this range for this long. */
const QUIET_S = 0.2;
const QUIET_RANGE_KG = 0.5;

// Time at which the curve first reaches `level`, interpolated between samples.
function crossing(times, values, level, from, to) {
  for (let i = from; i <= to; i++) {
    if (values[i] < level) continue;
    if (i === 0 || values[i] === values[i - 1]) return times[i];
    const fraction = (level - values[i - 1]) / (values[i] - values[i - 1]);
    return times[i - 1] + Math.min(1, Math.max(0, fraction)) * (times[i] - times[i - 1]);
  }
  return times[to];
}

/**
 * @param times       seconds, ascending
 * @param values      kg
 * @param onsetIndex  index of the first sample at or above ONSET_KG
 * @returns peak (kg), timeToPeak (s), peakRfd and rfd2080 (kg/s), and the
 *          times t20 and t80 (s) at which 20 % and 80 % of the peak were reached
 */
export function analyzePull(times, values, onsetIndex) {
  let peakIndex = onsetIndex;
  for (let i = onsetIndex; i < values.length; i++) {
    if (values[i] > values[peakIndex]) peakIndex = i;
  }
  const peak = values[peakIndex];
  const first = Math.max(0, onsetIndex - 1);
  const timeToPeak = times[peakIndex] - times[onsetIndex];

  let peakRfd = 0;
  for (let i = first, j = first; i < peakIndex; i++) {
    while (j < peakIndex && times[j] - times[i] < RFD_WINDOW_S) j++;
    if (times[j] - times[i] < RFD_WINDOW_S) break;
    peakRfd = Math.max(peakRfd, (values[j] - values[i]) / (times[j] - times[i]));
  }
  // Rise shorter than the window: use the whole rise.
  if (peakRfd === 0 && times[peakIndex] > times[first]) {
    peakRfd = (peak - values[first]) / (times[peakIndex] - times[first]);
  }

  const t20 = crossing(times, values, 0.2 * peak, first, peakIndex);
  const t80 = crossing(times, values, 0.8 * peak, first, peakIndex);
  const rfd2080 = t80 > t20 ? (0.6 * peak) / (t80 - t20) : 0;

  return { peak, timeToPeak, peakRfd, rfd2080, t20, t80 };
}

/** Feed it every sample; push() returns a finished pull or null. */
export class PullDetector {
  #times = [];
  #values = [];
  #onsetIndex = -1;
  #peak = 0;
  // Resting level in kg; unknown until the force has been steady for a moment.
  #zero = null;

  /** The resting level is known, so the next pull will be picked up. */
  get ready() {
    return this.#zero !== null;
  }

  get pulling() {
    return this.#onsetIndex >= 0;
  }

  push(time, value) {
    if (this.#times.length && time - this.#times.at(-1) > MAX_GAP_S) this.#clear();
    this.#times.push(time);
    this.#values.push(value);

    if (!this.pulling) {
      if (this.ready && value - this.#zero >= ONSET_KG) {
        this.#onsetIndex = this.#times.length - 1;
        this.#peak = value - this.#zero;
        return null;
      }
      while (time - this.#times[0] > PRE_ROLL_S) {
        this.#times.shift();
        this.#values.shift();
      }
      if (time - this.#times[0] >= QUIET_S) {
        const range = Math.max(...this.#values) - Math.min(...this.#values);
        if (range <= QUIET_RANGE_KG) {
          this.#zero = this.#values.reduce((a, b) => a + b) / this.#values.length;
        }
      }
      return null;
    }

    const zero = this.#zero;
    const onsetTime = this.#times[this.#onsetIndex];
    this.#peak = Math.max(this.#peak, value - zero);
    const released = value - zero < Math.max(ONSET_KG, this.#peak / 2);
    if (!released && time - onsetTime < MAX_PULL_S) return null;

    const times = this.#times.map((t) => t - onsetTime);
    const values = this.#values;
    const result = analyzePull(
      times,
      values.map((v) => v - zero),
      this.#onsetIndex,
    );
    // The next pull needs a fresh resting level first.
    this.#clear();
    if (result.peak < MIN_PEAK_KG || result.peakRfd < MIN_PEAK_RFD) return null;
    // Forces are reported as measured, not relative to the resting level.
    return { times, values, ...result, peak: result.peak + zero, zero };
  }

  /** Forget everything, e.g. when the device is disconnected. */
  reset() {
    this.#clear();
  }

  #clear() {
    this.#times = [];
    this.#values = [];
    this.#onsetIndex = -1;
    this.#peak = 0;
    this.#zero = null;
  }
}
