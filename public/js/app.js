import { Progressor } from './progressor.js';
import { SimulatedProgressor } from './simulator.js';
import { Chart, CHART_BUILD } from './chart.js';
import { holdScreen } from './wakelock.js';
import { timer } from './timer.js';
import { rfdView, RFDVIEW_BUILD, RFD_BUILD } from './rfdview.js';
import { BANDS, BELOW_BANDS_COLOR, bandColor } from './bands.js';

// Shown in the header; bump together with the others on every change, so a
// stale cached file shows up as a mismatch.
const APP_BUILD = 22;

const MIN_Y_MAX_KG = 5;
const LIVE_WINDOW_S = 30;
const TARE_WINDOW_S = 0.5;
const MIN_FRAME_MS = 50;
const GAUGE_MAX_KG = 50;
// A work phase shows a plain signal colour until the pull exceeds this.
const ENGAGE_KG = 8;
const STOP_TIMEOUT_MS = 1000;
// The sampling rate shown is the number of samples received per this long.
const RATE_WINDOW_MS = 1000;
// No samples for this long while connected counts as a stalled stream: it
// shows as 0 Hz and the stream is restarted, every RETRY_MS until data flows.
const STALL_MS = 1500;
const RETRY_MS = 3000;
// To save battery the Progressor is disconnected when nothing has happened
// for IDLE_MS (no touch, no load above ACTIVE_KG, no timer running), or when
// the page has been hidden (screen off, other app) for HIDDEN_MS with no
// timer running.
const IDLE_MS = 5 * 60 * 1000;
const HIDDEN_MS = 30 * 1000;
const ACTIVE_KG = 2;

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'),
  device: $('device'),
  rate: $('rate'),
  connect: $('connect'),
  demo: $('demo'),
  reset: $('reset'),
  tare: $('tare'),
  exportCsv: $('export'),
  current: $('current'),
  peak: $('peak'),
  duration: $('duration'),
  unsupported: $('unsupported'),
  theme: $('theme'),
  timerForceRow: $('timer-force-row'),
  timerForce: $('timer-force'),
  timerForceChip: $('timer-force-chip'),
  bands: $('bands'),
  timerView: $('timer-view'),
  gauge: $('timer-gauge'),
  gaugeFill: $('timer-gauge-fill'),
};

const chart = new Chart($('chart'));
const state = {
  device: null,
  busy: false, // connecting or disconnecting
  measuring: false,
  times: [], // s since the recording was last reset
  timeOrigin: null, // device time (s) that corresponds to 0 in the recording
  recordingStartedAt: null, // Date.now() of the first sample of the recording
  values: [], // kg, tare applied
  raw: [], // kg, as reported by the device
  tareOffset: 0,
  peak: 0,
  timerPhase: null, // 'ready' | 'work' | 'rest' while the timer runs
  timerRep: 0,
  rate: null, // samples/s as received, while connected
  engaged: false, // the pull has exceeded ENGAGE_KG in this work phase
};

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.dataset.kind = kind;
}

function render() {
  const connected = Boolean(state.device);
  el.connect.textContent = connected ? 'Disconnect' : 'Connect';
  el.connect.disabled = state.busy || (!connected && !Progressor.supported);
  el.demo.hidden = connected;
  el.demo.disabled = state.busy;
  el.reset.disabled = !connected;
  el.tare.disabled = !state.measuring;
  el.timerForceRow.hidden = !connected;
  el.gauge.hidden = !connected;
  rfdView.setConnected(connected);
  invalidate();
}

// Redraws happen only when something changed, and at most every
// MIN_FRAME_MS: redrawing the chart on every display refresh while samples
// stream in keeps the CPU and GPU busy for no visible benefit.
let frameQueued = false;
let lastFrameAt = 0;

function invalidate() {
  if (frameQueued) return;
  frameQueued = true;
  const wait = MIN_FRAME_MS - (performance.now() - lastFrameAt);
  setTimeout(frame, Math.max(0, wait));
}

function frame() {
  frameQueued = false;
  if (document.hidden) return; // redrawn on visibilitychange
  lastFrameAt = performance.now();
  const n = state.times.length;
  const last = n ? state.times[n - 1] : 0;
  const format = (kg) => kg.toFixed(1).replace(/^-(0\.0)$/, '$1');

  const currentKg = n ? state.values[n - 1] : 0;
  el.current.textContent = format(currentKg);
  el.current.style.color = bandColor(currentKg) ?? '';
  el.timerForceChip.style.background = bandColor(currentKg) ?? '';
  if (state.device) el.timerView.style.setProperty('--load-color', bandColor(currentKg) ?? BELOW_BANDS_COLOR);
  else el.timerView.style.removeProperty('--load-color');
  el.timerView.toggleAttribute('data-awaiting-pull', Boolean(state.device) && state.timerPhase === 'work' && !state.engaged);
  // The bar shows the colour of the current load, except in a rest: grey.
  const gaugeColor = state.timerPhase === 'rest' ? null : bandColor(currentKg);
  el.gaugeFill.style.background = gaugeColor ?? BELOW_BANDS_COLOR;
  el.gaugeFill.style.transform = `scaleY(${Math.min(1, Math.max(0, currentKg / GAUGE_MAX_KG))})`;
  el.peak.textContent = format(state.peak);
  el.duration.textContent = last.toFixed(1);
  el.timerForce.textContent = el.current.textContent;
  el.rate.textContent = state.device && state.rate !== null ? `· ${Math.round(state.rate)} Hz` : '';
  el.exportCsv.disabled = n === 0;

  const live = state.measuring || n === 0;
  const tMax = live ? Math.max(last, LIVE_WINDOW_S) : last;
  const tMin = live ? tMax - LIVE_WINDOW_S : 0;
  chart.draw(state.times, state.values, { tMin, tMax, scale: 1, minYMax: MIN_Y_MAX_KG });
}

// Counts samples as they arrive, so drop-outs in the Bluetooth link show.
const rateCount = { since: 0, samples: 0 };
let watchdog = null;
let stalled = false;

function armWatchdog(ms = STALL_MS) {
  clearTimeout(watchdog);
  watchdog = setTimeout(onStall, ms);
}

function onStall() {
  state.rate = 0;
  rateCount.since = 0;
  rateCount.samples = 0;
  invalidate();
  const device = state.device;
  if (!device || !state.measuring) return;
  stalled = true;
  setStatus('No data, restarting the stream…', 'error');
  // The device clock starts again; the recording carries on after a gap.
  state.timeOrigin = null;
  device.restartStream().catch(() => {});
  armWatchdog(RETRY_MS);
}

function countSamples(samples) {
  const now = Date.now();
  if (rateCount.since === 0) rateCount.since = now;
  rateCount.samples += samples;
  if (now - rateCount.since >= RATE_WINDOW_MS) {
    state.rate = (rateCount.samples * 1000) / (now - rateCount.since);
    rateCount.since = now;
    rateCount.samples = 0;
  }
  armWatchdog();
  if (stalled) {
    stalled = false;
    setStatus('Measuring', 'ok');
  }
}

function onSamples(event) {
  if (!state.measuring) return;
  countSamples(event.detail.length);
  if (event.detail.some(({ weight }) => Math.abs(weight - state.tareOffset) > ACTIVE_KG)) noteActivity();
  for (const { weight, time } of event.detail) {
    if (!Number.isFinite(weight)) continue;
    const value = weight - state.tareOffset;
    if (state.timeOrigin === null) {
      // A stream that starts while a recording is kept (a reconnect during a
      // timer session) continues it after a gap as long as the outage.
      state.recordingStartedAt ??= Date.now();
      const resumeAt = Math.max(state.times.at(-1) ?? 0, (Date.now() - state.recordingStartedAt) / 1000);
      state.timeOrigin = time / 1e6 - resumeAt;
    }
    state.times.push(time / 1e6 - state.timeOrigin);
    state.raw.push(weight);
    state.values.push(value);
    if (value > state.peak) state.peak = value;
    if (state.timerPhase === 'work' && value > ENGAGE_KG) state.engaged = true;
    rfdView.push(time / 1e6, value);
  }
  invalidate();
}

let lastActivity = Date.now();
let idleTimer = null;
let hiddenTimer = null;
let autoDisconnectReason = null;

function noteActivity() {
  lastActivity = Date.now();
}

function armIdle() {
  clearTimeout(idleTimer);
  if (state.device) idleTimer = setTimeout(checkIdle, lastActivity + IDLE_MS - Date.now());
}

function checkIdle() {
  if (!state.device) return;
  if (state.timerPhase !== null) noteActivity();
  if (Date.now() - lastActivity >= IDLE_MS) autoDisconnect('after 5 minutes without use');
  else armIdle();
}

function autoDisconnect(reason) {
  if (!state.device || state.busy) return;
  autoDisconnectReason = reason;
  disconnect();
}

document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenTimer);
  if (!document.hidden || !state.device || state.timerPhase !== null) return;
  hiddenTimer = setTimeout(() => {
    // Checked again: after a suspension this can run late, on return.
    if (document.hidden && state.timerPhase === null) autoDisconnect('while the screen was off');
  }, HIDDEN_MS);
});
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, noteActivity, { passive: true });

function onDisconnected() {
  clearTimeout(idleTimer);
  clearTimeout(hiddenTimer);
  state.device = null;
  state.measuring = false;
  state.rate = null;
  clearTimeout(watchdog);
  stalled = false;
  rateCount.since = 0;
  rateCount.samples = 0;
  holdScreen('measure', false);
  el.device.textContent = '';
  setStatus(autoDisconnectReason ? `Disconnected ${autoDisconnectReason}, to save battery` : 'Disconnected');
  autoDisconnectReason = null;
  render();
}

async function connect(device) {
  if (state.device || state.busy) return;
  state.busy = true;
  render();
  setStatus('Connecting…');
  try {
    await device.connect();
  } catch (error) {
    // NotFoundError: the user dismissed the device chooser.
    setStatus(error.name === 'NotFoundError' ? 'Disconnected' : `Connection failed: ${error.message}`, error.name === 'NotFoundError' ? '' : 'error');
    return;
  } finally {
    state.busy = false;
    render();
  }
  device.addEventListener('samples', onSamples);
  device.addEventListener('disconnected', onDisconnected);
  device.addEventListener('lowbattery', () => setStatus('Low battery', 'error'));
  state.device = device;
  noteActivity();
  armIdle();
  setStatus('Connected', 'ok');
  render();
  await refreshDeviceInfo();
  await start();
}

async function refreshDeviceInfo() {
  const device = state.device;
  if (!device) return;
  try {
    const firmware = await device.getFirmwareVersion();
    const millivolts = await device.getBatteryVoltage();
    el.device.textContent = `${device.name ?? 'Progressor'} · fw ${firmware} · ${(millivolts / 1000).toFixed(2)} V`;
  } catch {
    el.device.textContent = device.name ?? 'Progressor';
  }
}

// Clears the recording; the stream itself keeps running.
function reset() {
  state.times = [];
  state.values = [];
  state.raw = [];
  state.timeOrigin = null;
  state.recordingStartedAt = null;
  state.peak = 0;
  invalidate();
}

// Streaming starts as soon as a device is connected and runs until it is
// disconnected.
async function start() {
  const device = state.device;
  if (!device || state.measuring) return;
  // While the timer runs the recording belongs to its session: a device that
  // drops out and comes back continues it instead of wiping it.
  if (state.timerPhase === null) reset();
  else state.timeOrigin = null; // the device clock starts again
  state.measuring = true;
  render();
  holdScreen('measure', true);
  try {
    await device.startMeasurement();
    if (state.device !== device) return;
    setStatus('Measuring', 'ok');
    armWatchdog(); // also catches a stream that never starts
  } catch (error) {
    if (state.device !== device) return; // gone meanwhile; already reported
    state.measuring = false;
    holdScreen('measure', false);
    setStatus(`Could not start: ${error.message}`, 'error');
    render();
  }
}

async function disconnect() {
  const device = state.device;
  if (!device || state.busy) return;
  state.busy = true;
  render();
  // Do not let a device that no longer answers hold up the disconnect.
  const withTimeout = (command) =>
    Promise.race([command, new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))]).catch(() => {});
  // Disconnecting ends the stream anyway, so a failed stop does not matter.
  if (state.measuring) await withTimeout(device.stopMeasurement());
  // Switches the Progressor off to save its battery; its button wakes it.
  // It may drop the link itself before answering.
  await withTimeout(device.sleep());
  state.busy = false;
  device.disconnect();
  render();
}

// Zero on the mean of the most recent raw readings. Done in software so it
// applies immediately and does not depend on firmware behaviour mid-stream.
function tare() {
  const n = state.times.length;
  if (n === 0) return;
  const since = state.times[n - 1] - TARE_WINDOW_S;
  let sum = 0;
  let count = 0;
  for (let i = n - 1; i >= 0 && state.times[i] >= since; i--) {
    sum += state.raw[i];
    count++;
  }
  state.tareOffset = sum / count;
  state.peak = 0;
  invalidate();
}

function exportCsv() {
  const rows = ['time_s,force_kg'];
  for (let i = 0; i < state.times.length; i++) {
    rows.push(`${state.times[i].toFixed(4)},${state.values[i].toFixed(3)}`);
  }
  const url = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `progressor-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

el.connect.addEventListener('click', () => {
  if (state.device) disconnect();
  else connect(new Progressor());
});
el.demo.addEventListener('click', () => connect(new SimulatedProgressor()));
// Reset also retries the stream if starting it failed.
el.reset.addEventListener('click', () => (state.measuring ? reset() : start()));
el.tare.addEventListener('click', tare);
el.exportCsv.addEventListener('click', exportCsv);
for (const tab of document.querySelectorAll('nav button')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('nav button')) {
      const active = other === tab;
      other.setAttribute('aria-selected', active);
      $(other.dataset.view).hidden = !active;
    }
    chart.resize();
    frame();
  });
}
// Starting the timer starts a fresh recording, so the chart covers the session.
timer.addEventListener('start', reset);
timer.addEventListener('beat', (event) => {
  // Each work phase starts out waiting for the pull again.
  noteActivity();
  const { phase, rep } = event.detail;
  if (phase !== state.timerPhase || rep !== state.timerRep) state.engaged = false;
  state.timerPhase = phase;
  state.timerRep = rep;
  invalidate();
});
timer.addEventListener('stop', () => {
  state.timerPhase = null;
  invalidate();
});
// Resizing clears the canvas, so redraw at once rather than leave it blank.
chart.onresize = frame;
document.addEventListener('visibilitychange', invalidate);
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const other = theme === 'dark' ? 'light' : 'dark';
  el.theme.textContent = other === 'dark' ? '☾' : '☀';
  el.theme.setAttribute('aria-label', `Switch to ${other} theme`);
  chart.refreshColors();
  rfdView.refreshColors();
  invalidate();
}

function savedTheme() {
  try {
    return localStorage.getItem('theme');
  } catch {
    return null;
  }
}

el.theme.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Still applies for this visit.
  }
  setTheme(theme);
});
// Follow the system setting until the user has picked a theme themselves.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
  if (!savedTheme()) setTheme(event.matches ? 'dark' : 'light');
});
setTheme(document.documentElement.dataset.theme);

if (!Progressor.supported) {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  el.unsupported.textContent = ios
    ? 'Safari and Chrome on iPad/iPhone cannot use Bluetooth. Open this page in the Bluefy browser instead. Demo mode still works.'
    : !window.isSecureContext
      ? 'Bluetooth is only available over HTTPS (or on localhost). Demo mode still works.'
      : 'This browser does not support Web Bluetooth. Use Chrome, Edge or Opera. Demo mode still works.';
  el.unsupported.hidden = false;
}
for (const band of BANDS) {
  const item = document.createElement('span');
  item.textContent = `${band.from} kg`;
  item.style.background = band.color;
  el.bands.append(item);

  const tick = document.createElement('span');
  tick.dataset.kg = band.from;
  tick.style.bottom = `${(band.from / GAUGE_MAX_KG) * 100}%`;
  tick.style.borderColor = band.color;
  el.gauge.append(tick);
}

{
  const builds = { page: Number($('build').dataset.page), app: APP_BUILD, chart: CHART_BUILD, rfd: RFD_BUILD, rfdview: RFDVIEW_BUILD };
  const stale = new Set(Object.values(builds)).size > 1;
  $('build').textContent = stale
    ? `stale files: ${Object.entries(builds).map(([name, build]) => `${name} ${build}`).join(' · ')}`
    : `v${APP_BUILD}`;
}

setStatus('Disconnected');
render();
invalidate();
