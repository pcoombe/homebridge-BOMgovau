
# Homebridge-BOMgovau-v2
[![Homebridge 2.x](https://img.shields.io/badge/Homebridge-2.x-blue.svg)](https://homebridge.io/)
[![GitHub last commit](https://img.shields.io/github/last-commit/pcoombe/homebridge-BOMgovau.svg)](https://github.com/pcoombe/homebridge-BOMgovau)
[![npm version](https://img.shields.io/npm/v/homebridge-bomgovau-v2.svg)](https://www.npmjs.com/package/homebridge-bomgovau-v2)
[![npm](https://img.shields.io/npm/dt/homebridge-bomgovau-v2.svg)](https://www.npmjs.com/package/homebridge-bomgovau-v2)
[![License](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)

Retrieves official weather data (temperature, humidity, apparent temperature, air pressure) from the Australian [Bureau of Meteorology (BOM)](http://www.bom.gov.au) and exposes it to Apple HomeKit via Homebridge.

This project is a fork of [SteveCohen/homebridge-BOMgovau](https://github.com/SteveCohen/homebridge-BOMgovau).
The npm package is published as `homebridge-bomgovau-v2`; the Homebridge accessory identifier remains `BOMgovau` for configuration compatibility.

## Features

- **Temperature** - Current air temperature (°C)
- **Apparent Temperature** - "Feels like" temperature accounting for wind/humidity
- **Humidity** - Relative humidity (%)
- **Air Pressure** - Atmospheric pressure (hPa) - visible in Eve/Home+ apps
- **Historical Data** - FakeGato history support for charts in Eve app
- **Configurable** - Enable/disable individual sensors, custom update interval
- **Homebridge 2.x Compatible** - Modern ES6 class-based accessory

---

## Installation

### Via Homebridge Config UI X (Recommended)
1. Open Homebridge Config UI X
2. Go to **Plugins** tab
3. Search for `homebridge-bomgovau-v2`
4. Click **Install**

### Via NPM
```bash
npm install -g homebridge-bomgovau-v2
```

### Development checks

The single **CI & Publish** GitHub Actions workflow runs lint and JavaScript syntax checks on pushes and pull requests. Run the same checks locally with:

```bash
npm run lint
npm run parse
```

### Publishing to npm

The **CI & Publish** workflow also publishes the package when run manually or when a GitHub release is published, after lint and parse checks pass. Before using it, add an npm publishing token as the repository Actions secret `NPM_TOKEN` under **Settings → Secrets and variables → Actions**.

### Test a BOM feed without Homebridge

The standalone script runs the plugin's fetch, parsing, and sensor-update path with mocked Homebridge services:

```bash
npm run test:bom-feed
```

By default, it tests the Penrith station feed. To test another feed, pass its URL:

```bash
npm run test:bom-feed -- "http://www.bom.gov.au/fwo/IDN60901/IDN60901.94763.json"
```

The test needs network access to BOM. It exits with an error if loading or updating the sensor values fails.

---

## Configuration

### Finding Your Station URL

1. Visit [BOM Observations](http://www.bom.gov.au/australia/observations/)
2. Find your nearest weather station
3. At the bottom of the station page, locate the **JSON data feed** link
4. Copy the URL (format: `http://reg.bom.gov.au/fwo/IDX60XXX/IDX60XXX.XXXXX.json`)

### Homebridge accessory configuration

```json
{
  "accessories": [
    {
      "accessory": "BOMgovau",
      "name": "Canberra Airport",
      "stationURL": "http://reg.bom.gov.au/fwo/IDN60903/IDN60903.94926.json",
      "updateFrequency": 1800000,
      "sensors": {
        "temperature": true,
        "humidity": true,
        "apparentTemp": true,
        "pressure": true
      }
    }
  ]
}
```

> This plugin registers a Homebridge accessory, not a dynamic platform. Configure it under the `accessories` array; a `platforms` entry is not supported.
>
> Pressure is exposed as a separate Eve-compatible Air Pressure service. Sensors with unavailable or invalid readings are marked inactive and faulted, so compatible HomeKit apps can show them as offline; the plugin does not fabricate readings.

### Configuring via Homebridge Config UI X

If you use [Homebridge Config UI X](https://github.com/homebridge/homebridge-config-ui-x), this plugin can be configured through its graphical settings editor instead of editing `config.json` by hand — the plugin declares a configuration schema (`configSchema` in `package.json`) that Config UI X renders as a form:

1. Open Homebridge Config UI X
2. Go to **Plugins** → **homebridge-bomgovau-v2** → **Configure**, or open **Accessories** and select your BOM Weather Station accessory
3. Set the accessory name, BOM station URL, update interval, and enable/disable the sensors you want
4. Save the configuration and restart Homebridge

The UI options match the manual configuration options below: `name`, `stationURL`, `updateFrequency`, and `sensors` (temperature, humidity, apparent temperature, pressure). The defaults are the same as shown in the table below.

> This plugin registers a Homebridge accessory, not a dynamic platform. Configure it under **Accessories** rather than **Platforms** in Config UI X.

---

## Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `accessory` | string | Yes | `"BOMgovau"` | Must be `BOMgovau` |
| `name` | string | Yes | - | Display name in HomeKit |
| `stationURL` | string | No | Canberra Airport | BOM JSON observation URL |
| `updateFrequency` | number | No | `1800000` (30 min) | Update interval in milliseconds |
| `sensors.temperature` | boolean | No | `true` | Enable temperature sensor |
| `sensors.humidity` | boolean | No | `true` | Enable humidity sensor |
| `sensors.apparentTemp` | boolean | No | `true` | Enable apparent temperature sensor |
| `sensors.pressure` | boolean | No | `true` | Enable separate Eve-compatible air-pressure service |

### Example: Disable Humidity

```json
{
  "accessory": "BOMgovau",
  "name": "Melbourne Olympic Park",
  "stationURL": "http://reg.bom.gov.au/fwo/IDV60901/IDV60901.94866.json",
  "sensors": {
    "humidity": false
  }
}
```

### Example: Custom Update Interval (10 minutes)

```json
{
  "accessory": "BOMgovau",
  "name": "Sydney Observatory Hill",
  "stationURL": "http://reg.bom.gov.au/fwo/IDN60901/IDN60901.94768.json",
  "updateFrequency": 600000
}
```

---

## Supported Stations

Any BOM station with a JSON observation feed. Common examples:

| Location | Station URL |
|----------|-------------|
| Canberra Airport | `http://reg.bom.gov.au/fwo/IDN60903/IDN60903.94926.json` |
| Sydney Observatory Hill | `http://reg.bom.gov.au/fwo/IDN60901/IDN60901.94768.json` |
| Melbourne Olympic Park | `http://reg.bom.gov.au/fwo/IDV60901/IDV60901.94866.json` |
| Brisbane Aero | `http://reg.bom.gov.au/fwo/IDQ60901/IDQ60901.94576.json` |
| Perth Airport | `http://reg.bom.gov.au/fwo/IDW60901/IDW60901.94610.json` |
| Adelaide Airport | `http://reg.bom.gov.au/fwo/IDS60901/IDS60901.94672.json` |
| Hobart Airport | `http://reg.bom.gov.au/fwo/IDT60901/IDT60901.94970.json` |
| Darwin Airport | `http://reg.bom.gov.au/fwo/IDD60901/IDD60901.94120.json` |

> Find more at [BOM Observation Stations](http://www.bom.gov.au/australia/observations/)

---

## Historical Data (FakeGato)

The plugin supports [FakeGato History](https://github.com/simont77/fakegato-history) for viewing historical charts in the **Eve app** or **Home+**.

- Automatically enabled when a temperature, humidity, or pressure sensor is active
- Uses FakeGato's standard `weather` format with temperature, humidity, and pressure in every entry; missing or invalid history values are recorded as `0` (live sensors still show offline)
- Data persists across Homebridge restarts

---

## Troubleshooting

### Sensors not appearing in Home app
1. Restart Homebridge after configuration changes
2. Check Homebridge logs for errors
3. Verify `stationURL` returns valid JSON (test in browser)

### "Invalid stationURL" error
- Ensure URL starts with `http://` (BOM uses HTTP, not HTTPS)
- Verify the URL returns JSON data in browser
- Plugin falls back to Canberra Airport if URL invalid

### Data not updating
- BOM publishes new data every 30 minutes
- Check `updateFrequency` isn't set too low (minimum ~5 min recommended)
- View logs for "Updating observations from BOM" messages

### Plugin fails to install on Synology/NAS
- Version 0.2.0+ uses npm registry for all dependencies (no git required)
- Ensure Node.js 18+ is installed

---

## Version History

| Version | Date | Major Changes |
|---------|------|---------------|
| **0.3.0** | 2026-11 | Add configuration schema for **Homebridge Config UI X** |
| **0.2.7** | 2026-11 | Improve all log levels |
| **0.2.6** | 2026-11 | Fix BOM read errors and use fallback values |
| **0.2.5** | 2026-11 | Separate BOM client module |
| **0.2.4** | 2026-11 | Improve Homebridge v2 compatibility |
| **0.2.3** | 2026-11 | Child bridge failure fix |
| **0.2.0** | 2026-11 | **Homebridge 2.x compatibility**; ES6 class-based accessory; CI/CD pipeline |
| **0.1.6** | 2022-01 | Initial release (original by Stephen Cohen); temperature, humidity, apparent temperature, and pressure sensors |

---

## License

Apache-2.0 © [Stephen Cohen](https://github.com/SteveCohen)

## Contributing

Issues and PRs welcome at [github.com/pcoombe/homebridge-BOMgovau](https://github.com/pcoombe/homebridge-BOMgovau)

---

## Disclaimer

This plugin is not affiliated with the Australian Bureau of Meteorology. 
Weather data sourced from [BOM public API](http://www.bom.gov.au/other/access.shtml).
