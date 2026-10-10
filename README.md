# Finger

Web app that connects to a [Tindeq Progressor](https://tindeq.com/) over Bluetooth and streams
force data live. No build step and no dependencies.

## Run

Web Bluetooth only works on `https://` or `localhost`, so serve the `public` folder rather than
opening `index.html` from disk:

```sh
python3 -m http.server 8000 --directory public
```

Open <http://localhost:8000> in Chrome, Edge or Opera (desktop or Android). Firefox and Safari do
not support Web Bluetooth; on iOS use the Bluefy browser. On Linux, Chrome needs BlueZ 5.41+ and
may need `chrome://flags/#enable-experimental-web-platform-features`.

Wake the Progressor, press **Connect** and pick it in the chooser. Streaming starts at once and
runs until you disconnect; **Reset** clears the recording.

The **RFD** tab measures rate of force development. There is nothing to press: once the force has
been steady for a moment, that is taken as the resting level, and every clear pull after it is
recorded as an attempt when you let go (or after 5 seconds). A clear pull rises at least 5 kg above
the resting level and at 20 kg/s or faster. Each attempt shows:

- **Peak RFD** — the steepest rise over any 100 ms window, in kg/s
- **20–80 % RFD** — the average rise between 20 % and 80 % of that pull's peak force
- **Peak force** and **time to peak** from the onset, 2 kg above the resting level

The chart marks the onset, the 20 % and 80 % points and the peak with dotted lines.

**Demo** runs the UI against a simulated device.

## Deploy (home server)

`docker-compose.yml` serves the app through the existing nginx-proxy stack, which provides HTTPS:

```sh
docker compose up -d                              # serves finger.grahsl.net
FINGER_HOST=other.example.org docker compose up -d   # or another hostname
```

The hostname needs a DNS record pointing at the server before the certificate can be issued.
Only `public/` is served; it is mounted read-only from this checkout, so edits there are live
without a restart.

On an iPad or iPhone, open the page in the [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)
browser: Safari and Chrome on iOS have no Web Bluetooth.

## Test

```sh
node --test
```

## Layout

Everything served to the browser lives in `public/`:

- `public/index.html`, `public/style.css` — page and styles
- `public/js/progressor.js` — BLE protocol: UUIDs, commands, packet parsing, `Progressor` class
- `public/js/simulator.js` — simulated device with the same interface
- `public/js/app.js` — measure tab, tare, CSV export, theme, tabs
- `public/js/chart.js` — canvas line chart
- `public/js/timer.js`, `public/js/interval.js` — interval timer UI/audio and its sequencing
- `public/js/rfdview.js`, `public/js/rfd.js` — rate of force development tab and its calculation
- `public/js/bands.js` — colour thresholds for force values
- `public/js/wakelock.js` — keeps the screen on while measuring or timing
