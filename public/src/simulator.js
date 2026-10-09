// Stand-in for a Progressor so the UI can be used without hardware.
// Emits 80 Hz samples of a repeating 7 s pull / 3 s rest.

const SAMPLE_RATE_HZ = 80;
const BATCH_MS = 100;

export class SimulatedProgressor extends EventTarget {
  #timer = null;
  #sampleIndex = 0;
  connected = false;
  name = 'Progressor (demo)';

  async connect() {
    this.connected = true;
  }

  disconnect() {
    this.#stop();
    this.connected = false;
    this.dispatchEvent(new Event('disconnected'));
  }

  async startMeasurement() {
    this.#stop();
    this.#sampleIndex = 0;
    this.#timer = setInterval(() => this.#emit(), BATCH_MS);
  }

  async stopMeasurement() {
    this.#stop();
  }

  async tare() {}

  async getBatteryVoltage() {
    return 3850;
  }

  async getFirmwareVersion() {
    return 'demo';
  }

  #stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }

  #emit() {
    const samples = [];
    for (let i = 0; i < (SAMPLE_RATE_HZ * BATCH_MS) / 1000; i++) {
      const t = this.#sampleIndex++ / SAMPLE_RATE_HZ;
      samples.push({ weight: force(t), time: Math.round(t * 1e6) });
    }
    this.dispatchEvent(new CustomEvent('samples', { detail: samples }));
  }
}

function force(t) {
  const phase = t % 10;
  const noise = (Math.random() - 0.5) * 0.15;
  if (phase >= 7) return 0.4 * Math.exp(-(phase - 7) * 8) + noise;
  const ramp = 1 - Math.exp(-phase * 5);
  const fatigue = 1 - 0.03 * phase;
  return 32 * ramp * fatigue + Math.sin(t * 9) * 0.4 + noise;
}
