"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const stationURL = process.argv[2] ||
  process.env.STATION_URL ||
  "http://www.bom.gov.au/fwo/IDN60901/IDN60901.94763.json";

class CharacteristicMock {
  setProps(props) {
    this.props = props;
    return this;
  }

  onGet(handler) {
    this.getter = handler;
    return this;
  }
}

class ServiceMock {
  constructor(displayName) {
    this.displayName = displayName;
    this.characteristics = new Map();
  }

  getCharacteristic(type) {
    if (!this.characteristics.has(type)) {
      this.characteristics.set(type, new CharacteristicMock());
    }
    return this.characteristics.get(type);
  }

  addCharacteristic(type) {
    return this.getCharacteristic(type);
  }

  setCharacteristic(type, value) {
    this.getCharacteristic(type).value = value;
    return this;
  }

  updateCharacteristic(type, value) {
    this.getCharacteristic(type).value = value;
    return this;
  }
}

const Service = {
  AccessoryInformation: class extends ServiceMock {},
  TemperatureSensor: class extends ServiceMock {},
  HumiditySensor: class extends ServiceMock {}
};
const Characteristic = new Proxy(
  { Formats: { UINT16: "uint16" } },
  { get: (target, key) => key in target ? target[key] : String(key) }
);
const historyService = class {
  addEntry() {}
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "hap-nodejs") {
    return { Service, Characteristic };
  }
  if (request === "hap-nodejs-community-types") {
    return () => ({ AtmosphericPressureLevel: "AtmosphericPressureLevel" });
  }
  if (request === "fakegato-history") {
    return () => historyService;
  }
  return originalLoad.call(this, request, parent, isMain);
};

function characteristicValue(service, type) {
  return service.characteristics.get(type)?.value;
}

async function main() {
  const api = {
    registerAccessory(pluginName, accessoryName, accessoryClass) {
      this.accessoryClass = accessoryClass;
      this.accessoryName = accessoryName;
    }
  };
  const logErrors = [];
  const logger = () => {};
  logger.warn = () => {};
  logger.error = (...args) => logErrors.push(args.join(" "));

  let accessory;
  try {
    require(path.join(__dirname, "..", "index.js"))(api);
    assert.ok(api.accessoryClass, "Plugin did not register its accessory");
    assert.equal(api.accessoryName, "BOMgovau");

    accessory = new api.accessoryClass(api, logger, {
      name: "BOM feed test",
      stationURL,
      sensors: {
        temperature: true,
        humidity: true,
        apparentTemp: true
      }
    });

    clearInterval(accessory.updateInterval);
    await accessory.updateObservations();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(logErrors.length, 0, `Plugin logged errors:\n${logErrors.join("\n")}`);
    assert.ok(accessory.header?.name, "BOM station name was not loaded");
    assert.ok(accessory.header?.state, "BOM station state was not loaded");
    assert.ok(/^\d{14}$/.test(accessory.obs?.aifstime_utc), "Observation timestamp is invalid");

    const checks = [
      ["temperature", accessory.temperatureService, "CurrentTemperature", accessory.obs.air_temp],
      ["apparent temperature", accessory.apparentTempService, "CurrentTemperature", accessory.obs.apparent_t],
      ["humidity", accessory.humidityService, "CurrentRelativeHumidity", accessory.obs.rel_hum]
    ];

    for (const [label, service, characteristic, expectedValue] of checks) {
      assert.ok(service, `${label} service was not created`);
      assert.ok(Number.isFinite(Number(expectedValue)), `${label} value is not numeric`);
      assert.equal(
        characteristicValue(service, characteristic),
        expectedValue,
        `${label} characteristic was not updated from BOM data`
      );
      assert.equal(characteristicValue(service, "StatusFault"), false, `${label} service has a fault`);
    }

    assert.ok(accessory.BOMdataExpires > Date.now(), "Observation cache expiry is not in the future");

    console.log("BOM plugin data test passed");
    console.log(`Station: ${accessory.header.name}, ${accessory.header.state}`);
    console.log(`Observed at: ${accessory.obs.aifstime_utc}`);
    console.log(`Temperature: ${accessory.obs.air_temp} °C`);
    console.log(`Apparent temperature: ${accessory.obs.apparent_t} °C`);
    console.log(`Humidity: ${accessory.obs.rel_hum}%`);
    console.log(`Pressure: ${accessory.obs.press ?? "not reported"} hPa`);
    console.log(`Cached until: ${new Date(accessory.BOMdataExpires).toLocaleString()}`);
  } finally {
    accessory?.shutdown();
    Module._load = originalLoad;
  }
}

main().catch(error => {
  console.error("BOM plugin data test failed:", error.message);
  process.exitCode = 1;
});
