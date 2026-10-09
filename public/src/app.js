import { Progressor } from './progressor.js';
import { SimulatedProgressor } from './simulator.js';
import { Chart } from './chart.js';
import { holdScreen } from './wakelock.js';
import { timer } from './timer.js';
import { BANDS, BELOW_BANDS_COLOR, bandColor } from './bands.js';

const MIN_Y_MAX_KG = 5;
const LIVE_WINDOW_S = 30;
const TARE_WINDOW_S = 0.5;
const MIN_FRAME_MS = 50;
const GAUGE_MAX_KG = 50;

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'),
  device: $('device'),
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
  measuring: false,
  times: [], // s since the recording was last reset
  timeOrigin: null, // device time (s) of the first sample of the recording
  values: [], // kg, tare applied
  raw: [], // kg, as reported by the device
  tareOffset: 0,
  peak: 0,
  timerPhase: null, // 'ready' | 'work' | 'rest' while the timer runs
};

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.dataset.kind = kind;
}

function render() {
  const connected = Boolean(state.device);
  el.connect.textContent = connected ? 'Disconnect' : 'Connect';
  el.connect.disabled = !connected && !Progressor.supported;
  el.demo.hidden = connected;
  el.reset.disabled = !connected;
  el.tare.disabled = !state.measuring;
  el.timerForceRow.hidden = !connected;
  el.gauge.hidden = !connected;
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
  // The bar shows the colour of the current load, except in a rest: grey.
  const gaugeColor = state.timerPhase === 'rest' ? null : bandColor(currentKg);
  el.gaugeFill.style.background = gaugeColor ?? BELOW_BANDS_COLOR;
  el.gaugeFill.style.transform = `scaleY(${Math.min(1, Math.max(0, currentKg / GAUGE_MAX_KG))})`;
  el.peak.textContent = format(state.peak);
  el.duration.textContent = last.toFixed(1);
  el.timerForce.textContent = el.current.textContent;
  el.exportCsv.disabled = n === 0;

  const live = state.measuring || n === 0;
  const tMax = live ? Math.max(last, LIVE_WINDOW_S) : last;
  const tMin = live ? tMax - LIVE_WINDOW_S : 0;
  chart.draw(state.times, state.values, { tMin, tMax, scale: 1, minYMax: MIN_Y_MAX_KG });
}

function onSamples(event) {
  if (!state.measuring) return;
  for (const { weight, time } of event.detail) {
    const value = weight - state.tareOffset;
    state.timeOrigin ??= time / 1e6;
    state.times.push(time / 1e6 - state.timeOrigin);
    state.raw.push(weight);
    state.values.push(value);
    if (value > state.peak) state.peak = value;
  }
  invalidate();
}

function onDisconnected() {
  state.device = null;
  state.measuring = false;
  holdScreen('measure', false);
  el.device.textContent = '';
  setStatus('Disconnected');
  render();
}

async function connect(device) {
  setStatus('Connecting…');
  try {
    await device.connect();
  } catch (error) {
    // NotFoundError: the user dismissed the device chooser.
    setStatus(error.name === 'NotFoundError' ? 'Disconnected' : `Connection failed: ${error.message}`, error.name === 'NotFoundError' ? '' : 'error');
    return;
  }
  device.addEventListener('samples', onSamples);
  device.addEventListener('disconnected', onDisconnected);
  device.addEventListener('lowbattery', () => setStatus('Low battery', 'error'));
  state.device = device;
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
  state.peak = 0;
  invalidate();
}

// Streaming starts as soon as a device is connected and runs until it is
// disconnected.
async function start() {
  if (!state.device || state.measuring) return;
  reset();
  state.measuring = true;
  render();
  holdScreen('measure', true);
  try {
    await state.device.startMeasurement();
    setStatus('Measuring', 'ok');
  } catch (error) {
    state.measuring = false;
    holdScreen('measure', false);
    setStatus(`Could not start: ${error.message}`, 'error');
    render();
  }
}

async function disconnect() {
  const device = state.device;
  try {
    if (state.measuring) await device.stopMeasurement();
  } catch {
    // Disconnecting ends the stream anyway.
  }
  device.disconnect();
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
  state.timerPhase = event.detail.phase;
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

setStatus('Disconnected');
render();
invalidate();
