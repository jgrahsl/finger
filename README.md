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
runs until you disconnect; **Reset** clears the recording. **Demo** runs
the UI against a simulated device.

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
- `public/src/progressor.js` — BLE protocol: UUIDs, commands, packet parsing, `Progressor` class
- `public/src/simulator.js` — simulated device with the same interface
- `public/src/app.js` — measure tab, tare, CSV export, theme, tabs
- `public/src/chart.js` — canvas line chart
- `public/src/timer.js`, `public/src/interval.js` — interval timer UI/audio and its sequencing
- `public/src/bands.js` — colour thresholds for force values
- `public/src/wakelock.js` — keeps the screen on while measuring or timing
