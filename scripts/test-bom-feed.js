"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const stationURL = process.argv[2] ||
  process.env.STATION_URL ||
  "http://www.bom.gov.au/fwo/IDN60901/IDN60901.94763.json";

class CharacteristicMock {
  constructor(displayName, UUID, props) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.props = props;
    this.value = this.getDefaultValue();
  }

  setProps(props) {
    this.props = props;
    return this;
  }

  onGet(handler) {
    this.getter = handler;
    return this;
  }

  getDefaultValue() {
    return 0;
  }
}

class ServiceMock {
  constructor(displayName, UUID, subtype) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.subtype = subtype;
    this.characteristics = new Map();
  }

  getCharacteristic(type) {
    if (!this.characteristics.has(type)) {
      const characteristic = typeof type === "function"
        ? new type()
        : new CharacteristicMock();
      this.characteristics.set(type, characteristic);
    }
    return this.characteristics.get(type);
  }

  addCharacteristic(type) {
    return this.getCharacteristic(type);
  }

  addOptionalCharacteristic(type) {
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

const Service = class extends ServiceMock {};
Service.AccessoryInformation = class extends Service {};
Service.TemperatureSensor = class extends Service {};
Service.HumiditySensor = class extends Service {};
CharacteristicMock.Formats = { UINT16: "uint16" };
CharacteristicMock.Perms = {
  READ: "pr",
  WRITE: "pw",
  PAIRED_READ: "pr",
  NOTIFY: "ev"
};
CharacteristicMock.Units = { PRESSURE: "hPa" };
const Characteristic = new Proxy(CharacteristicMock, {
  get: (target, key, receiver) =>
    key in target ? Reflect.get(target, key, receiver) : String(key)
});
let fakegatoApi;
let historyConfig;
const historyEntries = [];

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "fakegato-history") {
    return api => {
      fakegatoApi = api;
      return class {
        constructor(type, accessory, options) {
          historyConfig = { type, accessory, options };
          this.displayName = `${accessory.displayName} History`;
          this.characteristics = new Map();
        }

        addEntry(entry) {
          historyEntries.push(entry);
        }
      };
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function characteristicValue(service, type) {
  return service.characteristics.get(type)?.value;
}

async function main() {
  const api = {
    hap: {
      Service,
      Characteristic,
      uuid: () => "mock-uuid",
      Formats: Characteristic.Formats,
      Perms: Characteristic.Perms
    },
    registerAccessory(pluginName, accessoryName, accessoryClass) {
      this.accessoryClass = accessoryClass;
      this.accessoryName = accessoryName;
    }
  };
  const logErrors = [];
  const infoLogs = [];
  const logger = (...args) => infoLogs.push(args.join(" "));
  logger.debug = () => {};
  logger.warn = () => {};
  logger.error = (...args) => logErrors.push(args.join(" "));

  let accessory;
  try {
    require(path.join(__dirname, "..", "index.js"))(api);
    assert.ok(api.accessoryClass, "Plugin did not register its accessory");
    assert.equal(api.accessoryName, "BOMgovau");

    accessory = new api.accessoryClass(logger, {
      name: "BOM feed test",
      stationURL,
      sensors: {
        temperature: true,
        humidity: true,
        apparentTemp: true,
        pressure: true
      }
    }, api);

    clearInterval(accessory.updateInterval);
    assert.equal(fakegatoApi, api, "FakeGato did not receive the Homebridge API");
    assert.equal(historyConfig.type, "weather", "FakeGato should use its standard weather format");
    assert.ok(accessory.getServices().includes(accessory.history),
      "FakeGato history service was not exposed");
    assert.ok(accessory.getServices().includes(accessory.airPressureService),
      "Pressure should be exposed as its own service");
    assert.equal(accessory.airPressureService.UUID, "E863F00A-079E-48FF-8F27-9C2605A29F52");
    const pressure = accessory.airPressureService.characteristics.get(
      accessory.AirPressureCharacteristic
    );
    assert.ok(pressure, "Eve Air Pressure characteristic was not created");
    assert.equal(pressure.UUID, "E863F10F-079E-48FF-8F27-9C2605A29F52");
    assert.equal(pressure.props.unit, "hPa");
    assert.equal(pressure.props.minValue, 700);
    assert.equal(pressure.props.maxValue, 1100);
    const fetchObservations = accessory.bomClient.fetchObservations.bind(accessory.bomClient);
    accessory.bomClient.fetchObservations = async () => {
      throw new Error("Simulated initial BOM request failure");
    };
    const [initialTemperature, initialHumidity, initialApparentTemperature, initialPressure] =
      await Promise.all([
        accessory.getStateTemperature(),
        accessory.getStateHumidity(),
        accessory.getStateApparentTemperature(),
        accessory.getStatePressure()
      ]);
    assert.ok(initialTemperature >= -100 && initialTemperature <= 100,
      "Initial temperature getter should return a valid fallback");
    assert.ok(initialHumidity >= 0 && initialHumidity <= 100,
      "Initial humidity getter should return a valid fallback");
    assert.ok(initialApparentTemperature >= -100 && initialApparentTemperature <= 100,
      "Initial apparent temperature getter should return a valid fallback");
    assert.ok(initialPressure >= 700 && initialPressure <= 1100,
      "Initial pressure getter should return a valid fallback");
    assert.equal(initialPressure, 1013, "Initial pressure should use the in-range fallback");
    assert.equal(accessory.obs.air_temp, undefined,
      "Temperature should not start with a plausible zero reading");
    assert.equal(accessory.obs.rel_hum, undefined,
      "Humidity should not start with a plausible zero reading");
    assert.equal(accessory.obs.apparent_t, undefined,
      "Apparent temperature should not start with a plausible zero reading");
    assert.equal(characteristicValue(accessory.temperatureService, "StatusActive"), false);
    assert.equal(characteristicValue(accessory.temperatureService, "StatusFault"), true);
    assert.equal(characteristicValue(accessory.humidityService, "StatusActive"), false);
    assert.equal(characteristicValue(accessory.humidityService, "StatusFault"), true);
    assert.equal(characteristicValue(accessory.apparentTempService, "StatusActive"), false);
    assert.equal(characteristicValue(accessory.apparentTempService, "StatusFault"), true);
    assert.equal(characteristicValue(accessory.airPressureService, "StatusActive"), false);
    assert.equal(characteristicValue(accessory.airPressureService, "StatusFault"), true);
    logErrors.length = 0;

    let fetchCount = 0;
    accessory.bomClient.fetchObservations = async () => {
      fetchCount++;
      return fetchObservations();
    };
    const [temperatureReading, humidityReading] = await Promise.all([
      accessory.getStateTemperature(),
      accessory.getStateHumidity()
    ]);
    assert.equal(fetchCount, 1, "Concurrent sensor reads should share one feed request");
    assert.equal(temperatureReading, accessory.obs.air_temp);
    assert.equal(humidityReading, accessory.obs.rel_hum);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(logErrors.length, 0, `Plugin logged errors:\n${logErrors.join("\n")}`);
    const readingsLog = infoLogs.find(message => message.includes("[BOM gov au] Current readings:"));
    assert.ok(readingsLog, "Successful observation retrieval should log current readings");
    assert.ok(readingsLog.includes(`temperature: ${accessory.obs.air_temp} °C`));
    assert.ok(readingsLog.includes(`apparent temperature: ${accessory.obs.apparent_t} °C`));
    assert.ok(readingsLog.includes(`humidity: ${accessory.obs.rel_hum}%`));
    assert.ok(readingsLog.includes(typeof accessory.obs.press === "number" &&
      accessory.obs.press >= 700 && accessory.obs.press <= 1100
      ? `pressure: ${accessory.obs.press} hPa`
      : "pressure: unavailable"));
    assert.ok(accessory.header?.name, "BOM station name was not loaded");
    assert.ok(accessory.header?.state, "BOM station state was not loaded");
    assert.ok(/^\d{14}$/.test(accessory.obs?.aifstime_utc), "Observation timestamp is invalid");
    const originalTemperature = accessory.obs.air_temp;
    assert.equal(accessory._getObservationValue("air_temp", -100, 100), originalTemperature);
    accessory.obs.air_temp = null;
    assert.equal(accessory._getObservationValue("air_temp", -100, 100), undefined,
      "Null temperature must be treated as unavailable");
    accessory.obs.air_temp = originalTemperature;

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
      assert.equal(characteristicValue(service, "StatusActive"), true, `${label} service is offline`);
    }

    if (typeof accessory.obs.press === "number" &&
      Number.isFinite(accessory.obs.press) &&
      accessory.obs.press >= 700 &&
      accessory.obs.press <= 1100) {
      assert.equal(
        characteristicValue(accessory.airPressureService, accessory.AirPressureCharacteristic),
        accessory.obs.press,
        "Pressure characteristic was not updated from BOM data"
      );
      assert.equal(characteristicValue(accessory.airPressureService, "StatusFault"), false);
      assert.equal(characteristicValue(accessory.airPressureService, "StatusActive"), true,
        "Pressure service is offline despite a valid reading");
    } else {
      assert.equal(characteristicValue(accessory.airPressureService, "StatusFault"), true,
        "Pressure service should be faulted when the feed omits pressure");
      assert.equal(characteristicValue(accessory.airPressureService, "StatusActive"), false,
        "Pressure service should be offline when the feed omits pressure");
      const pressureReading = await accessory.getStatePressure();
      assert.ok(pressureReading >= 700 && pressureReading <= 1100,
        "Missing pressure should return a valid fallback value");
      assert.equal(characteristicValue(accessory.airPressureService, "StatusActive"), false);
      assert.equal(characteristicValue(accessory.airPressureService, "StatusFault"), true);
    }

    assert.equal(historyEntries.length, 1, "A complete weather history entry should be recorded");
    assert.equal(historyEntries[0].temp, accessory.obs.air_temp);
    assert.equal(historyEntries[0].humidity, accessory.obs.rel_hum);
    assert.equal(historyEntries[0].pressure, 0,
      "Missing pressure should be recorded as zero in the weather history entry");

    assert.ok(accessory.BOMdataExpires > Date.now(), "Observation cache expiry is not in the future");

    const lastPressureValue = characteristicValue(
      accessory.airPressureService,
      accessory.AirPressureCharacteristic
    );
    const missingPressureAt = Date.now();
    accessory.BOMdataExpires = 0;
    accessory.bomClient.fetchObservations = async () => ({
      observation: {
        ...accessory.obs,
        press: undefined
      },
      header: accessory.header,
      fetchedAt: missingPressureAt,
      expiresAt: missingPressureAt + 60_000
    });
    await accessory.updateObservations();
    assert.equal(characteristicValue(accessory.airPressureService, "StatusActive"), false,
      "A missing pressure reading should mark the pressure sensor offline");
    assert.equal(characteristicValue(accessory.airPressureService, "StatusFault"), true,
      "A missing pressure reading should mark the pressure sensor faulted");
    assert.equal(await accessory.getStatePressure(), lastPressureValue,
      "A missing pressure reading should return the last valid HomeKit pressure value");

    const cachedTemperature = accessory.obs.air_temp;
    const cachedExpiry = accessory.BOMdataExpires;
    accessory.BOMdataExpires = 0;
    accessory.bomClient.fetchObservations = async () => {
      throw new Error("Simulated refresh failure");
    };
    assert.equal(await accessory.getStateTemperature(), cachedTemperature,
      "A failed refresh should preserve the last successful temperature");
    assert.equal(characteristicValue(accessory.temperatureService, "StatusActive"), false,
      "A failed refresh should mark the temperature service offline");
    assert.equal(characteristicValue(accessory.temperatureService, "StatusFault"), true,
      "A failed refresh should mark the temperature service faulted");
    accessory.BOMdataExpires = cachedExpiry;

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
