
# Homebridge-BOMgovau-v2

[![npm version](https://img.shields.io/npm/v/homebridge-bomgovau-v2.svg)](https://www.npmjs.com/package/homebridge-bomgovau-v2)
[![Homebridge 2.x](https://img.shields.io/badge/Homebridge-2.x-blue.svg)](https://homebridge.io/)
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

### Config.json (Legacy)

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
        "apparentTemp": true
      }
    }
  ]
}
```

### Homebridge UI (Config.json for Homebridge 2.x)

```json
{
  "platforms": [
    {
      "platform": "BOMgovau",
      "name": "Canberra Airport",
      "stationURL": "http://reg.bom.gov.au/fwo/IDN60903/IDN60903.94926.json",
      "updateFrequency": 1800000,
      "sensors": {
        "temperature": true,
        "humidity": true,
        "apparentTemp": true
      }
    }
  ]
}
```

> **Note**: The accessory can be configured either as an accessory (`accessories` array) or platform (`platforms` array). Both work with Homebridge 2.x.

---

## Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `accessory` / `platform` | string | Yes | `"BOMgovau"` | Must be `BOMgovau` |
| `name` | string | Yes | - | Display name in HomeKit |
| `stationURL` | string | No | Canberra Airport | BOM JSON observation URL |
| `updateFrequency` | number | No | `1800000` (30 min) | Update interval in milliseconds |
| `sensors.temperature` | boolean | No | `true` | Enable temperature sensor |
| `sensors.humidity` | boolean | No | `true` | Enable humidity sensor |
| `sensors.apparentTemp` | boolean | No | `true` | Enable apparent temperature sensor |

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

- Automatically enabled when temperature or humidity sensor is active
- Logs temperature, humidity, and pressure every 30 minutes
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

| Version | Changes |
|---------|---------|
| **0.2.0** | Homebridge 2.x compatibility, bug fixes, JSDoc, npm dependencies |
| 0.1.6 | Initial release with basic temperature/humidity/pressure support |

---

## License

Apache-2.0 © [Stephen Cohen](https://github.com/SteveCohen)

## Contributing

Issues and PRs welcome at [github.com/pcoombe/homebridge-BOMgovau](https://github.com/pcoombe/homebridge-BOMgovau)

---

## Disclaimer

This plugin is not affiliated with the Australian Bureau of Meteorology. Weather data sourced from [BOM public API](http://www.bom.gov.au/other/access.shtml).
