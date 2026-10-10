import { Chart } from './chart.js';
import { PullDetector, RFD_BUILD } from './rfd.js';

export { RFD_BUILD };

// Shown in the header; bump together with the others on every change, so a
// stale cached file shows up as a mismatch.
export const RFDVIEW_BUILD = 7;

const MAX_ATTEMPTS = 20;
const MIN_CHART_S = 1;

const $ = (id) => document.getElementById(id);
const el = {
  view: $('rfd-view'),
  hint: $('rfd-hint'),
  peakRfd: $('rfd-peak'),
  rfd2080: $('rfd-2080'),
  force: $('rfd-force'),
  timeToPeak: $('rfd-ttp'),
  attempts: $('rfd-attempts'),
  clear: $('rfd-clear'),
};

const chart = new Chart($('rfd-chart'));
const detector = new PullDetector();
let attempts = []; // { number, pull }
let count = 0;
let selected = null;
let connected = false;

const ms = (seconds) => `${Math.round(seconds * 1000)} ms`;

// The points the figures are derived from: onset, 20 % and 80 % of the rise
// above the resting level, and the peak.
function marks(pull) {
  const rise = pull.peak - pull.zero;
  const kg20 = pull.zero + 0.2 * rise;
  const kg80 = pull.zero + 0.8 * rise;
  return {
    times: [
      { at: 0, label: 'onset' },
      { at: pull.t20, label: `20 % · ${ms(pull.t20)}` },
      { at: pull.t80, label: `80 % · ${ms(pull.t80)}` },
      { at: pull.timeToPeak, label: `peak · ${ms(pull.timeToPeak)}` },
    ],
    values: [
      { at: kg20, label: `20 % · ${kg20.toFixed(1)} kg` },
      { at: kg80, label: `80 % · ${kg80.toFixed(1)} kg` },
      { at: pull.peak, label: `peak · ${pull.peak.toFixed(1)} kg` },
    ],
  };
}

function draw() {
  const pull = selected?.pull;
  const times = pull?.times ?? [];
  chart.draw(times, pull?.values ?? [], {
    tMin: times[0] ?? 0,
    // Zoom in on the rise; a long hold after it is of no interest here.
    tMax: pull ? Math.min(times.at(-1), Math.max(MIN_CHART_S, pull.timeToPeak * 1.5 + 0.3)) : MIN_CHART_S,
    scale: 1,
    minYMax: 5,
    marks: pull && marks(pull),
  });
}

function renderHint() {
  const text = !connected
    ? 'Connect a Progressor to measure.'
    : detector.pulling
      ? 'Pulling… let go to finish.'
      : detector.ready
        ? 'Ready. Pull as hard and as fast as you can; each pull is recorded.'
        : 'Hold still…';
  if (el.hint.textContent !== text) el.hint.textContent = text;
}

function render() {
  const pull = selected?.pull;
  el.peakRfd.textContent = pull ? Math.round(pull.peakRfd) : '–';
  el.rfd2080.textContent = pull ? Math.round(pull.rfd2080) : '–';
  el.force.textContent = pull ? pull.peak.toFixed(1) : '–';
  el.timeToPeak.textContent = pull ? Math.round(pull.timeToPeak * 1000) : '–';
  el.clear.disabled = attempts.length === 0;
  renderHint();

  const best = attempts.reduce((a, b) => (b.pull.peakRfd > (a?.pull.peakRfd ?? 0) ? b : a), null);
  el.attempts.replaceChildren(
    ...attempts.map((attempt) => {
      const chip = document.createElement('button');
      chip.className = 'ghost';
      chip.textContent = `${attempt === best ? '★ ' : ''}#${attempt.number} · ${Math.round(attempt.pull.peakRfd)} kg/s`;
      chip.setAttribute('aria-pressed', attempt === selected);
      chip.addEventListener('click', () => {
        selected = attempt;
        render();
      });
      return chip;
    }),
  );
  draw();
}

export const rfdView = {
  setConnected(value) {
    connected = value;
    if (!connected) detector.reset();
    render();
  },

  /** Every incoming sample; time in seconds on the device clock, value in kg. */
  push(time, value) {
    // Pulls only count while this tab is showing. The detector starts afresh
    // after the break in its input, so a pull under way on return is skipped.
    if (el.view.hidden) return;
    const pull = detector.push(time, value);
    if (!pull) {
      renderHint();
      return;
    }
    selected = { number: ++count, pull };
    attempts = [selected, ...attempts].slice(0, MAX_ATTEMPTS);
    render();
  },

  refreshColors() {
    chart.refreshColors();
    draw();
  },
};

el.clear.addEventListener('click', () => {
  attempts = [];
  count = 0;
  selected = null;
  render();
});
chart.onresize = draw;
render();
