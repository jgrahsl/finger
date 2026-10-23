import { advance, firstBeat, idleRepProgress, remaining, repProgress, shownRep, toneFor } from './interval.js';
import { holdScreen } from './wakelock.js';

const READY_S = 5;
const TONES = {
  ready: { frequency: 660, duration: 0.12 },
  start: { frequency: 880, duration: 0.45 },
  work: { frequency: 880, duration: 0.12 },
  rest: { frequency: 660, duration: 0.12 },
  end: { frequency: 660, duration: 0.45 },
  prepare: { frequency: 990, duration: 0.12 },
  // Ten quick beeps, each with a flash, that fit within the one-second beat.
  last: { frequency: 1320, duration: 0.05, count: 10, gap: 0.04 },
};
// A square wave carries overtones, so small tablet speakers reproduce the
// lower pitches too; a pure sine at these frequencies can be close to inaudible.
const WAVEFORM = 'square';
const VOLUME = 0.1;
const FLASH_OPACITY = 0.6;
const MIN_FLASH_MS = 180;
// A beep that could not be played this soon after its beat is dropped.
const MAX_BEEP_DELAY_MS = 300;

const LABELS = { ready: 'Get ready', work: 'Work', rest: 'Rest' };

const $ = (id) => document.getElementById(id);
const el = {
  view: $('timer-view'),
  phase: $('timer-phase'),
  count: $('timer-count'),
  reps: $('timer-reps'),
  presets: document.querySelectorAll('#timer-presets button'),
  toggle: $('timer-toggle'),
  pause: $('timer-pause'),
  repControls: $('timer-rep-controls'),
  progressParts: $('timer-progress-parts'),
  progressVeil: $('timer-progress-veil'),
  repDown: $('timer-rep-down'),
  repZero: $('timer-rep-zero'),
  repUp: $('timer-rep-up'),
  mute: $('timer-mute'),
  colors: $('timer-colors'),
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
// Whether the card background follows the current load during work.
let loadColors = true;
try {
  muted = localStorage.getItem('muted') === 'true';
  loadColors = localStorage.getItem('loadColors') !== 'false';
} catch {
  // Defaults to sound on and load colours on.
}
let timeout = null;
let state = null;
let config = null;
let startedAt = 0; // Date.now() of beat 0
let beats = 0; // index of the current beat
let pausedAt = null; // Date.now() when paused
// Manual correction of the rep count shown, from the −, 0 and + buttons.
let repOffset = 0;

function beep(tone) {
  if (muted || !audio) return;
  if (audio.state === 'running') {
    play(tone);
    return;
  }
  // Suspended, e.g. just created or after a call or a locked screen. Tones
  // scheduled on a suspended context would all sound at once when it resumes,
  // so play this one only if resuming is quick.
  const context = audio;
  const askedAt = Date.now();
  context
    .resume()
    .then(() => {
      if (context === audio && Date.now() - askedAt <= MAX_BEEP_DELAY_MS) play(tone);
    })
    .catch(() => {});
}

function play({ frequency, duration, count = 1, gap = 0 }) {
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
  el.phase.textContent = !running ? 'Ready' : pausedAt !== null ? 'Paused' : LABELS[state.phase];
  el.count.textContent = running ? remaining(state, config) : readConfig().work;
  if (running) el.reps.textContent = Math.max(0, shownRep(state, config) + repOffset);
  el.toggle.textContent = running ? 'Stop' : 'Start';
  el.toggle.classList.toggle('danger', running);
  el.view.toggleAttribute('data-paused', pausedAt !== null);
  el.pause.disabled = !running;
  el.pause.textContent = pausedAt !== null ? 'Resume' : 'Pause';
  el.repControls.hidden = !running;
  for (const preset of el.presets) preset.disabled = running;
}

// The progress bar is animated by the browser: each beat sets where it should
// be at the end of that beat and lets a linear transition get it there.
let shownParts = '';
let progressAt = null; // { kind, total, elapsed } the bar is heading for

function setVeil(fraction, ms = 0) {
  el.progressVeil.style.transition = ms > 0 ? `transform ${ms}ms linear` : 'none';
  el.progressVeil.style.transform = `scaleX(${1 - fraction})`;
}

function renderProgress() {
  const progress = state ? repProgress(state, config) : idleRepProgress(readConfig());
  const parts = JSON.stringify(progress.parts);
  if (parts !== shownParts) {
    shownParts = parts;
    el.progressParts.replaceChildren(
      ...progress.parts.map(({ kind, seconds }) => {
        const part = document.createElement('span');
        part.dataset.kind = kind;
        part.style.flex = `${seconds} 1 0`;
        return part;
      }),
    );
  }
  const { kind, total, elapsed } = progress;
  if (!state) {
    progressAt = null;
    setVeil(0);
    return;
  }
  const beatStart = startedAt + beats * 1000;
  const now = pausedAt ?? Date.now();
  const into = Math.min(1, Math.max(0, (now - beatStart) / 1000));
  const from = (elapsed + into) / total;
  if (pausedAt !== null) {
    progressAt = null;
    setVeil(from);
    return;
  }
  // Carry on smoothly from the last beat, or jump when the bar starts over
  // (or after a pause or a skip).
  const continues = progressAt && progressAt.kind === kind && progressAt.total === total && progressAt.elapsed + 1 === elapsed;
  if (!continues) {
    setVeil(from);
    el.progressVeil.getBoundingClientRect(); // apply it before animating on
  }
  progressAt = { kind, total, elapsed };
  setVeil((elapsed + 1) / total, Math.max(0, beatStart + 1000 - Date.now()));
}

function readConfig() {
  const selected = [...el.presets].find((preset) => preset.getAttribute('aria-pressed') === 'true');
  return { ready: READY_S, work: Number(selected.dataset.work), rest: Number(selected.dataset.rest) };
}

// Announces the current beat; `silent` when it was reached late.
function tick(silent = false) {
  const tone = silent ? null : toneFor(state, config);
  if (tone) {
    beep(TONES[tone]);
    // Silent alert that work is about to start.
    if (tone === 'last') flash(TONES[tone]);
  }
  render();
  renderProgress();
  timer.dispatchEvent(new CustomEvent('beat', { detail: state }));
  // Schedule against the start time so delays in one beat do not accumulate.
  timeout = setTimeout(catchUp, startedAt + (beats + 1) * 1000 - Date.now());
}

// The timer follows the clock: when the page was suspended (screen off, app
// in the background) it carries on where it would be by now, rather than
// where it stopped, and without replaying the beeps that were missed.
function catchUp() {
  clearTimeout(timeout);
  const due = Math.floor((Date.now() - startedAt) / 1000);
  const skipped = Math.max(1, due - beats);
  state = advance(state, config, skipped);
  beats += skipped;
  tick(skipped > 1);
}

function start() {
  // Created on the tap: browsers only allow audio to start from a user gesture.
  try {
    audio = new (window.AudioContext ?? window.webkitAudioContext)();
  } catch {
    audio = null; // The timer still runs, silently.
  }
  config = readConfig();
  state = firstBeat(config);
  startedAt = Date.now();
  beats = 0;
  pausedAt = null;
  repOffset = 0;
  holdScreen('timer', true);
  timer.dispatchEvent(new Event('start'));
  tick();
}

function stop() {
  clearTimeout(timeout);
  state = null;
  pausedAt = null;
  // An open AudioContext keeps the audio hardware powered even when silent.
  audio?.close().catch(() => {});
  audio = null;
  holdScreen('timer', false);
  render();
  renderProgress();
  timer.dispatchEvent(new Event('stop'));
}

// Holds the current beat; resuming keeps what was left of its second.
function pause() {
  clearTimeout(timeout);
  pausedAt = Date.now();
  audio?.suspend().catch(() => {});
  render();
  renderProgress();
}

function resume() {
  startedAt += Date.now() - pausedAt;
  pausedAt = null;
  audio?.resume().catch(() => {});
  render();
  renderProgress();
  timeout = setTimeout(catchUp, startedAt + (beats + 1) * 1000 - Date.now());
}

function adjustReps(change) {
  const shown = Math.max(0, shownRep(state, config) + repOffset);
  repOffset += change === 0 ? -shown : Math.max(change, -shown);
  render();
}

el.toggle.addEventListener('click', () => (state ? stop() : start()));
el.pause.addEventListener('click', () => {
  if (!state) return;
  if (pausedAt === null) pause();
  else resume();
});
el.repDown.addEventListener('click', () => state && adjustReps(-1));
el.repZero.addEventListener('click', () => state && adjustReps(0));
el.repUp.addEventListener('click', () => state && adjustReps(1));
// Back on screen: timers may not have run in the meantime, and the audio may
// have been suspended.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state || pausedAt !== null) return;
  if (audio && audio.state !== 'running') audio.resume().catch(() => {});
  if (Date.now() - startedAt >= (beats + 1) * 1000) catchUp();
});
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

function renderColors() {
  el.view.dataset.loadBg = loadColors ? 'on' : 'off';
  el.colors.setAttribute('aria-pressed', loadColors);
  el.colors.setAttribute('aria-label', loadColors ? 'Stop colouring the background by load' : 'Colour the background by load');
}
el.colors.addEventListener('click', () => {
  loadColors = !loadColors;
  try {
    localStorage.setItem('loadColors', loadColors);
  } catch {
    // Still applies for this visit.
  }
  renderColors();
});
renderColors();

for (const preset of el.presets) {
  preset.addEventListener('click', () => {
    for (const other of el.presets) other.setAttribute('aria-pressed', other === preset);
    render();
    renderProgress();
  });
}
render();
renderProgress();
