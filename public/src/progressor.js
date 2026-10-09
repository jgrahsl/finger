// Tindeq Progressor BLE protocol.
// Reference: https://tindeq.com/progressor_api/

export const SERVICE_UUID = '7e4e1701-1ea6-40c9-9dcc-13d34ffead57';
export const DATA_UUID = '7e4e1702-1ea6-40c9-9dcc-13d34ffead57';
export const CONTROL_UUID = '7e4e1703-1ea6-40c9-9dcc-13d34ffead57';

export const Command = {
  TARE_SCALE: 0x64,
  START_WEIGHT_MEAS: 0x65,
  STOP_WEIGHT_MEAS: 0x66,
  START_PEAK_RFD_MEAS: 0x67,
  START_PEAK_RFD_MEAS_SERIES: 0x68,
  ADD_CALIBRATION_POINT: 0x69,
  SAVE_CALIBRATION: 0x6a,
  GET_APP_VERSION: 0x6b,
  GET_ERROR_INFORMATION: 0x6c,
  CLR_ERROR_INFORMATION: 0x6d,
  ENTER_SLEEP: 0x6e,
  GET_BATTERY_VOLTAGE: 0x6f,
};

export const ResponseTag = {
  CMD_RESPONSE: 0,
  WEIGHT_MEASURE: 1,
  RFD_PEAK: 2,
  RFD_PEAK_SERIES: 3,
  LOW_PWR_WARNING: 4,
};

const RESPONSE_TIMEOUT_MS = 2000;

/**
 * Parse one notification from the data characteristic.
 * Packets are TLV: [tag: u8][length: u8][value: length bytes].
 * Weight packets carry repeated [weight: f32 LE, kg][timestamp: u32 LE, µs].
 */
export function parseNotification(view) {
  if (view.byteLength < 2) return { tag: -1, payload: new DataView(new ArrayBuffer(0)) };
  const tag = view.getUint8(0);
  const length = Math.min(view.getUint8(1), view.byteLength - 2);
  const payload = new DataView(view.buffer, view.byteOffset + 2, length);

  if (tag !== ResponseTag.WEIGHT_MEASURE) return { tag, payload };

  const samples = [];
  for (let i = 0; i + 8 <= length; i += 8) {
    samples.push({
      weight: payload.getFloat32(i, true),
      time: payload.getUint32(i + 4, true),
    });
  }
  return { tag, payload, samples };
}

/**
 * Events:
 *   samples      detail: [{ weight (kg), time (µs since measurement start) }]
 *   lowbattery
 *   disconnected
 */
export class Progressor extends EventTarget {
  #device = null;
  #data = null;
  #control = null;
  #queue = Promise.resolve();
  #pending = null;

  static get supported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  get connected() {
    return Boolean(this.#device?.gatt?.connected);
  }

  get name() {
    return this.#device?.name ?? null;
  }

  async connect() {
    this.#device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Progressor' }],
      optionalServices: [SERVICE_UUID],
    });
    this.#device.addEventListener('gattserverdisconnected', this.#onDisconnect);

    const server = await this.#device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.#data = await service.getCharacteristic(DATA_UUID);
    this.#control = await service.getCharacteristic(CONTROL_UUID);
    this.#data.addEventListener('characteristicvaluechanged', this.#onData);
    await this.#data.startNotifications();
  }

  disconnect() {
    this.#device?.gatt?.disconnect();
  }

  startMeasurement() {
    return this.#send(Command.START_WEIGHT_MEAS);
  }

  stopMeasurement() {
    return this.#send(Command.STOP_WEIGHT_MEAS);
  }

  tare() {
    return this.#send(Command.TARE_SCALE);
  }

  sleep() {
    return this.#send(Command.ENTER_SLEEP);
  }

  /** Battery voltage in millivolts. */
  async getBatteryVoltage() {
    const payload = await this.#send(Command.GET_BATTERY_VOLTAGE, true);
    return payload.getUint32(0, true);
  }

  async getFirmwareVersion() {
    const payload = await this.#send(Command.GET_APP_VERSION, true);
    return new TextDecoder().decode(payload).replace(/\0+$/, '');
  }

  // GATT allows one operation at a time, so commands are serialized.
  #send(opcode, expectResponse = false) {
    const run = async () => {
      if (!this.connected) throw new Error('Progressor is not connected');
      const response = expectResponse ? this.#awaitResponse() : null;
      const packet = Uint8Array.of(opcode, 0);
      // Older implementations (e.g. WebBLE-based iOS browsers) only have writeValue.
      const control = this.#control;
      const write =
        (control.properties.write ? control.writeValueWithResponse : control.writeValueWithoutResponse) ??
        control.writeValue;
      await write.call(control, packet);
      return response;
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }

  #awaitResponse() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending = null;
        reject(new Error('Progressor did not respond'));
      }, RESPONSE_TIMEOUT_MS);
      this.#pending = { resolve, reject, timer };
    });
  }

  #onData = (event) => {
    const packet = parseNotification(event.target.value);
    switch (packet.tag) {
      case ResponseTag.WEIGHT_MEASURE:
        this.dispatchEvent(new CustomEvent('samples', { detail: packet.samples }));
        break;
      case ResponseTag.CMD_RESPONSE:
        if (this.#pending) {
          clearTimeout(this.#pending.timer);
          this.#pending.resolve(packet.payload);
          this.#pending = null;
        }
        break;
      case ResponseTag.LOW_PWR_WARNING:
        this.dispatchEvent(new Event('lowbattery'));
        break;
    }
  };

  #onDisconnect = () => {
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(new Error('Progressor disconnected'));
      this.#pending = null;
    }
    this.dispatchEvent(new Event('disconnected'));
  };
}
