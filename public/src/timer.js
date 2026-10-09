import { firstBeat, nextBeat, remaining, toneFor } from './interval.js';
import { holdScreen } from './wakelock.js';

const READY_S = 5;
const TONES = {
  ready: { frequency: 660, duration: 0.12 },
  start: { frequency: 880, duration: 0.45 },
  work: { frequency: 880, duration: 0.12 },
  rest: { frequency: 660, duration: 0.12 },
  end: { frequency: 660, duration: 0.45 },
  prepare: { frequency: 990, duration: 0.12 },
  last: { frequency: 1320, duration: 0.08, count: 2, gap: 0.07 },
};
// A square wave carries overtones, so small tablet speakers reproduce the
// lower pitches too; a pure sine at these frequencies can be close to inaudible.
const WAVEFORM = 'square';
const VOLUME = 0.1;
const FLASH_OPACITY = 0.6;
const MIN_FLASH_MS = 180;

const LABELS = { ready: 'Get ready', work: 'Work', rest: 'Rest' };

const $ = (id) => document.getElementById(id);
const el = {
  view: $('timer-view'),
  phase: $('timer-phase'),
  count: $('timer-count'),
  reps: $('timer-reps'),
  presets: document.querySelectorAll('#timer-presets button'),
  toggle: $('timer-toggle'),
  mute: $('timer-mute'),
  flash: $('timer-flash'),
};

/**
 * Lets the rest of the app follow the timer. Events:
 *   start
 *   beat   detail: { phase, beat, rep }
 *   stop
 */
export const timer = new EventTarget();

let audio = null;
let muted = false;
try {
  muted = localStorage.getItem('muted') === 'true';
} catch {
  // Defaults to sound on.
}
let timeout = null;
let state = null;
let config = null;
let startedAt = 0;
let beats = 0;

function beep({ frequency, duration, count = 1, gap = 0 }) {
  if (muted || !audio) return;
  if (audio.state !== 'running') audio.resume();
  for (let i = 0; i < count; i++) {
    const at = audio.currentTime + 0.01 + i * (duration + gap);
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = WAVEFORM;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(VOLUME, at + 0.01);
    gain.gain.setValueAtTime(VOLUME, at + duration - 0.02);
    gain.gain.linearRampToValueAtTime(0, at + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + duration);
  }
}

// Lights the timer card in the rhythm of the tone (also when muted).
function flash({ duration, count = 1, gap = 0 }) {
  const total = count * duration + (count - 1) * gap;
  const keyframes = [];
  for (let i = 0; i < count; i++) {
    const from = (i * (duration + gap)) / total;
    keyframes.push({ opacity: FLASH_OPACITY, offset: from, easing: 'ease-out' });
    keyframes.push({ opacity: 0, offset: from + duration / total, easing: 'step-end' });
  }
  el.flash.animate(keyframes, { duration: Math.max(total * 1000, MIN_FLASH_MS) });
}

function renderMute() {
  el.mute.textContent = muted ? '🔇' : '🔊';
  el.mute.setAttribute('aria-label', muted ? 'Unmute beeps' : 'Mute beeps');
  el.mute.setAttribute('aria-pressed', muted);
}

function render() {
  const running = state !== null;
  el.view.dataset.phase = running ? state.phase : 'idle';
  el.phase.textContent = running ? LABELS[state.phase] : 'Ready';
  el.count.textContent = running ? remaining(state, config) : readConfig().work;
  if (running) el.reps.textContent = state.rep;
  el.toggle.textContent = running ? 'Stop' : 'Start';
  el.toggle.classList.toggle('danger', running);
  for (const preset of el.presets) preset.disabled = running;
}

function readConfig() {
  const selected = [...el.presets].find((preset) => preset.getAttribute('aria-pressed') === 'true');
  return { ready: READY_S, work: Number(selected.dataset.work), rest: Number(selected.dataset.rest) };
}

function tick() {
  const tone = toneFor(state, config);
  if (tone) {
    beep(TONES[tone]);
    // Silent alert that work is about to start.
    if (tone === 'last') flash(TONES[tone]);
  }
  render();
  timer.dispatchEvent(new CustomEvent('beat', { detail: state }));
  const current = state;
  // Schedule against the start time so delays in one beat do not accumulate.
  beats++;
  timeout = setTimeout(() => {
    state = nextBeat(current, config);
    tick();
  }, startedAt + beats * 1000 - performance.now());
}

function start() {
  // Created on the tap: browsers only allow audio to start from a user gesture.
  audio = new (window.AudioContext ?? window.webkitAudioContext)();
  audio.resume();
  config = readConfig();
  state = firstBeat(config);
  startedAt = performance.now();
  beats = 0;
  holdScreen('timer', true);
  timer.dispatchEvent(new Event('start'));
  tick();
}

function stop() {
  clearTimeout(timeout);
  state = null;
  // An open AudioContext keeps the audio hardware powered even when silent.
  audio?.close();
  audio = null;
  holdScreen('timer', false);
  render();
  timer.dispatchEvent(new Event('stop'));
}

el.toggle.addEventListener('click', () => (state ? stop() : start()));
el.mute.addEventListener('click', () => {
  muted = !muted;
  try {
    localStorage.setItem('muted', muted);
  } catch {
    // Still applies for this visit.
  }
  renderMute();
});
renderMute();
for (const preset of el.presets) {
  preset.addEventListener('click', () => {
    for (const other of el.presets) other.setAttribute('aria-pressed', other === preset);
    render();
  });
}
render();
