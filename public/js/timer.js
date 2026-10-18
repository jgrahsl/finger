import { advance, firstBeat, remaining, toneFor } from './interval.js';
import { holdScreen } from './wakelock.js';

const READY_S = 5;
// The rhythm of the cue before work: ten quick sounds, each with a flash,
// that fit within the one-second beat. The same in every sound theme.
const LAST = { count: 10, duration: 0.05, gap: 0.04 };

/**
 * Sound themes. Each tone: frequency (Hz), duration (s), and optionally
 * count/gap to repeat it. Per theme:
 *   wave      oscillator type
 *   volume    peak gain
 *   envelope  'flat': held, then cut off; 'pluck': struck, then dies away
 *   partials  extra oscillators as [frequency ratio, relative gain]
 *   sweep     start at this many times the pitch and glide to it within
 *             sweepTime (default 30 ms): from above it is a knock, from
 *             below a chirp
 * The themes keep to different pitch ranges so they are told apart easily.
 */
const THEMES = {
  // A square wave carries overtones, so small tablet speakers reproduce the
  // lower pitches too; a pure sine at these frequencies can be close to inaudible.
  beep: {
    wave: 'square',
    volume: 0.1,
    envelope: 'flat',
    tones: {
      ready: { frequency: 660, duration: 0.12 },
      start: { frequency: 880, duration: 0.45 },
      work: { frequency: 880, duration: 0.12 },
      rest: { frequency: 660, duration: 0.12 },
      end: { frequency: 660, duration: 0.45 },
      prepare: { frequency: 990, duration: 0.12 },
      last: { frequency: 1320, ...LAST },
    },
  },
  // Bell-like and high: a sine with a slightly detuned octave above it, dying away.
  chime: {
    wave: 'sine',
    volume: 0.3,
    envelope: 'pluck',
    partials: [[2.01, 0.35]],
    tones: {
      ready: { frequency: 784, duration: 0.4 },
      start: { frequency: 1568, duration: 0.9 },
      work: { frequency: 1175, duration: 0.4 },
      rest: { frequency: 784, duration: 0.4 },
      end: { frequency: 587, duration: 0.9 },
      prepare: { frequency: 1319, duration: 0.4 },
      last: { frequency: 1568, ...LAST },
    },
  },
  // Short, low knocks, like a metronome's wood block.
  wood: {
    wave: 'triangle',
    volume: 0.45,
    envelope: 'pluck',
    sweep: 1.6,
    tones: {
      ready: { frequency: 440, duration: 0.08 },
      start: { frequency: 330, duration: 0.3 },
      work: { frequency: 620, duration: 0.08 },
      rest: { frequency: 440, duration: 0.08 },
      end: { frequency: 250, duration: 0.3 },
      prepare: { frequency: 830, duration: 0.08 },
      last: { frequency: 1100, ...LAST },
    },
  },
  // Deep and buzzing; the sawtooth's overtones carry it on small speakers.
  buzz: {
    wave: 'sawtooth',
    volume: 0.08,
    envelope: 'flat',
    tones: {
      ready: { frequency: 220, duration: 0.15 },
      start: { frequency: 330, duration: 0.5 },
      work: { frequency: 330, duration: 0.15 },
      rest: { frequency: 220, duration: 0.15 },
      end: { frequency: 165, duration: 0.5 },
      prepare: { frequency: 392, duration: 0.15 },
      last: { frequency: 523, ...LAST },
    },
  },
  // Very high chirps that glide up into their pitch, like a bird or a pager.
  chirp: {
    wave: 'sine',
    volume: 0.2,
    envelope: 'flat',
    sweep: 0.6,
    sweepTime: 0.08,
    tones: {
      ready: { frequency: 1760, duration: 0.12 },
      start: { frequency: 2640, duration: 0.4 },
      work: { frequency: 2349, duration: 0.12 },
      rest: { frequency: 1760, duration: 0.12 },
      end: { frequency: 1320, duration: 0.4 },
      prepare: { frequency: 2794, duration: 0.12 },
      last: { frequency: 3136, ...LAST },
    },
  },
};
const DEFAULT_THEME = 'beep';
const PREVIEW_MS = 1500;
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
  mute: $('timer-mute'),
  colors: $('timer-colors'),
  sound: $('timer-sound'),
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
let theme = DEFAULT_THEME;
// Whether the card background follows the current load during work.
let loadColors = true;
try {
  muted = localStorage.getItem('muted') === 'true';
  loadColors = localStorage.getItem('loadColors') !== 'false';
  theme = THEMES[localStorage.getItem('soundTheme')] ? localStorage.getItem('soundTheme') : DEFAULT_THEME;
} catch {
  // Defaults to sound on and load colours on.
}
let timeout = null;
let state = null;
let config = null;
let startedAt = 0; // Date.now() of beat 0
let beats = 0; // index of the current beat

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

function play(tone, context = audio) {
  const { wave, volume, envelope, partials = [], sweep, sweepTime = 0.03 } = THEMES[theme];
  const { frequency, duration, count = 1, gap = 0 } = tone;
  for (let i = 0; i < count; i++) {
    const at = context.currentTime + 0.01 + i * (duration + gap);
    const end = at + duration;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, at);
    if (envelope === 'pluck') {
      gain.gain.linearRampToValueAtTime(volume, at + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
    } else {
      gain.gain.linearRampToValueAtTime(volume, at + 0.01);
      gain.gain.setValueAtTime(volume, end - 0.02);
      gain.gain.linearRampToValueAtTime(0, end);
    }
    gain.connect(context.destination);
    for (const [ratio, level] of [[1, 1], ...partials]) {
      const oscillator = context.createOscillator();
      oscillator.type = wave;
      const pitch = frequency * ratio;
      if (sweep) {
        oscillator.frequency.setValueAtTime(pitch * sweep, at);
        oscillator.frequency.exponentialRampToValueAtTime(pitch, at + Math.min(sweepTime, duration));
      } else {
        oscillator.frequency.value = pitch;
      }
      let output = oscillator;
      if (level !== 1) {
        output = context.createGain();
        output.gain.value = level;
        oscillator.connect(output);
      }
      output.connect(gain);
      oscillator.start(at);
      oscillator.stop(end);
    }
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

// Announces the current beat; `silent` when it was reached late.
function tick(silent = false) {
  const tone = silent ? null : toneFor(state, config);
  if (tone) {
    beep(THEMES[theme].tones[tone]);
    // Silent alert that work is about to start.
    if (tone === 'last') flash(LAST);
  }
  render();
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
  holdScreen('timer', true);
  timer.dispatchEvent(new Event('start'));
  tick();
}

function stop() {
  clearTimeout(timeout);
  state = null;
  // An open AudioContext keeps the audio hardware powered even when silent.
  audio?.close().catch(() => {});
  audio = null;
  holdScreen('timer', false);
  render();
  timer.dispatchEvent(new Event('stop'));
}

el.toggle.addEventListener('click', () => (state ? stop() : start()));
// Back on screen: timers may not have run in the meantime, and the audio may
// have been suspended.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state) return;
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

// Plays what work start sounds like in the chosen theme, on its own short-lived
// audio context when the timer is not running.
function preview() {
  if (muted) return;
  const tone = THEMES[theme].tones.start;
  if (audio) {
    beep(tone);
    return;
  }
  try {
    const context = new (window.AudioContext ?? window.webkitAudioContext)();
    context
      .resume()
      .then(() => play(tone, context))
      .catch(() => {});
    setTimeout(() => context.close().catch(() => {}), PREVIEW_MS);
  } catch {
    // No audio available.
  }
}

el.sound.value = theme;
el.sound.addEventListener('change', () => {
  theme = THEMES[el.sound.value] ? el.sound.value : DEFAULT_THEME;
  try {
    localStorage.setItem('soundTheme', theme);
  } catch {
    // Still applies for this visit.
  }
  preview();
});
for (const preset of el.presets) {
  preset.addEventListener('click', () => {
    for (const other of el.presets) other.setAttribute('aria-pressed', other === preset);
    render();
  });
}
render();
