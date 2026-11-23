/**
 * @file homebridge-bomgovau-v2
 * @description Homebridge plugin for Australian Bureau of Meteorology (BOM) weather data
 * @author Peter Coombe, Originally Stephen Cohen
 * @license Apache-2.0
 * @see https://github.com/pcoombe/homebridge-BOMgovau
 * @see https://github.com/SteveCohen/homebridge-BOMgovau
 */

"use strict";

const pjson = require("./package.json");
const BomClient = require("./lib/bom-client");

/** @const {string} Plugin name from package.json */
const PLUGIN_NAME = pjson.name;
/** @const {string} Plugin version from package.json */
const PLUGIN_VERSION = pjson.version;
const DEFAULT_UPDATE_FREQUENCY = 30 * 60 * 1000;
const MIN_UPDATE_FREQUENCY = 60 * 1000;
const MAX_UPDATE_FREQUENCY = 24 * 60 * 60 * 1000;
const EVE_AIR_PRESSURE_SERVICE_UUID = "E863F00A-079E-48FF-8F27-9C2605A29F52";
const EVE_AIR_PRESSURE_CHAR_UUID = "E863F10F-079E-48FF-8F27-9C2605A29F52";

/**
 * BOMgovauAccessory - Homebridge accessory for BOM weather station data
 * 
 * Fetches weather observations from the Australian Bureau of Meteorology (BOM)
 * and exposes them as HomeKit temperature, humidity, and pressure sensors.
 * 
 * @class
 * @implements {HomebridgeAccessory}
 */
class BOMgovauAccessory {
  /**
   * Creates an instance of BOMgovauAccessory.
   * 
   * @param {HomebridgeLogger} logger - Homebridge logger instance
   * @param {Object} config - Accessory configuration
   * @param {HomebridgeAPI} api - Homebridge API instance
   * @param {string} [config.name="BOM Weather Station"] - Display name for the accessory
   * @param {string} [config.stationURL] - BOM JSON observation URL (defaults to Canberra Airport)
   * @param {number} [config.updateFrequency=1800000] - Update interval in milliseconds (default 30 min)
   * @param {Object} [config.sensors] - Sensor enable/disable configuration
   * @param {boolean} [config.sensors.temperature=true] - Enable temperature sensor
   * @param {boolean} [config.sensors.humidity=true] - Enable humidity sensor
   * @param {boolean} [config.sensors.apparentTemp=true] - Enable apparent temperature sensor
   * @param {boolean} [config.sensors.pressure=true] - Enable air pressure sensor
   */
  constructor(logger, config, api) {
    const { Characteristic, Service, Formats, Perms } = api.hap;
    this.hap = api.hap;

    /** @type {HomebridgeLogger} */
    this.log = logger;
    /** @type {string} */
    this.name = config.name || "BOM Weather Station";

    class AirPressureCharacteristic extends Characteristic {
      constructor() {
        super("Air Pressure", EVE_AIR_PRESSURE_CHAR_UUID, {
          format: Formats.UINT16,
          unit: "hPa",
          minValue: 700,
          maxValue: 1100,
          minStep: 1,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
      }
    }

    class AirPressureService extends Service {
      constructor(displayName, subtype) {
        super(displayName, EVE_AIR_PRESSURE_SERVICE_UUID, subtype);
        this.addCharacteristic(AirPressureCharacteristic);
        this.addOptionalCharacteristic(Characteristic.Name);
        this.addCharacteristic(Characteristic.StatusFault);
        this.addCharacteristic(Characteristic.StatusActive);
      }
    }

    /** @type {Function} */
    this.AirPressureCharacteristic = AirPressureCharacteristic;
    /** @type {typeof Service} */
    this.AirPressureService = AirPressureService;
    /** @type {Service|null} */
    this.airPressureService = null;
    /** @type {Function} */
    this.FakeGatoHistoryService = require("fakegato-history")(api);

    // Station configuration
    /** @type {number} */
    this.updateFrequency = Number.isSafeInteger(config.updateFrequency) &&
      config.updateFrequency >= MIN_UPDATE_FREQUENCY &&
      config.updateFrequency <= MAX_UPDATE_FREQUENCY
      ? config.updateFrequency
      : DEFAULT_UPDATE_FREQUENCY;

    if (config.updateFrequency !== undefined &&
      this.updateFrequency !== config.updateFrequency) {
      this.log.warn("[BOM gov au] Invalid updateFrequency: " + config.updateFrequency +
        ". Using " + this.updateFrequency + " ms.");
    }

    this.bomClient = new BomClient({
      stationURL: config.stationURL,
      name: this.name,
      updateFrequency: this.updateFrequency,
      log: this.log
    });
    /** @type {string} */
    this.stationURL = this.bomClient.stationURL;

    // Sensor configuration
    /** @type {Object.<string, boolean>} */
    this.sensors = {
      temperature: true,
      humidity: true,
      apparentTemp: true,
      pressure: true
    };

    if (config.sensors) {
      Object.keys(this.sensors).forEach(sensor => {
        if (config.sensors[sensor] !== undefined) {
          this.sensors[sensor] = config.sensors[sensor];
        }
      });
    }

    this.log("[BOM gov au] Enabling sensors:");
    Object.keys(this.sensors).forEach(sensor => {
      this.log("[BOM gov au] Sensor %s = %s", sensor, this.sensors[sensor]);
    });

    this.log("[BOM gov au] Station Name is %s", this.name);
    this.log("[BOM gov au] Station URL is %s", this.stationURL);

    // Current observations
    /** @type {Object} */
    this.obs = {
      air_temp: undefined,
      press: undefined,
      rel_hum: undefined,
      apparent_t: undefined
    };
    /** @type {number} */
    this.BOMdataExpires = 0;
    /** @type {Object|null} */
    this.history = null;
    /** @type {Promise<void>|null} */
    this._updatePromise = null;

    // Setup services
    this.setupServices();

    // Start periodic updates (non-blocking)
    /** @type {NodeJS.Timeout|null} */
    this.updateInterval = setInterval(() => this.updateObservations(), this.updateFrequency);

    // Trigger initial update asynchronously (non-blocking)
    setImmediate(() => this.updateObservations());
  }

  /**
   * Returns a finite observation value within the sensor's supported range.
   *
   * @param {string} field - BOM observation field
   * @param {number} min - Inclusive minimum
   * @param {number} max - Inclusive maximum
   * @returns {number|undefined}
   * @private
   */
  _getObservationValue(field, min, max) {
    const value = this.obs[field];
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
      ? value
      : undefined;
  }

  /**
   * Sets up HomeKit services based on enabled sensors.
   * 
   * Creates TemperatureSensor and HumiditySensor services.
   * Initializes FakeGato history on first enabled sensor.
   * 
   * @private
   */
  setupServices() {
    const { Service, Characteristic } = this.hap;

    // Temperature Service
    if (this.sensors.temperature) {
      /** @type {Service} */
      this.temperatureService = new Service.TemperatureSensor(this.name);
      this.temperatureService.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -100, maxValue: 100 })
        .onGet(this.getStateTemperature.bind(this));

      // Service status
      this.temperatureService.addCharacteristic(Characteristic.StatusFault);
      this.temperatureService.addCharacteristic(Characteristic.StatusActive);
      this.temperatureService.setCharacteristic(Characteristic.StatusActive, false);

    }

    // Apparent Temperature Service
    if (this.sensors.apparentTemp) {
      /** @type {Service} */
      this.apparentTempService = new Service.TemperatureSensor(this.name + " Apparent Temp", "apparentTemp");
      this.apparentTempService.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -100, maxValue: 100 })
        .onGet(this.getStateApparentTemperature.bind(this));

      // Service status (added for consistency)
      this.apparentTempService.addCharacteristic(Characteristic.StatusFault);
      this.apparentTempService.addCharacteristic(Characteristic.StatusActive);
      this.apparentTempService.setCharacteristic(Characteristic.StatusActive, false);

    }

    // Humidity Service
    if (this.sensors.humidity) {
      /** @type {Service} */
      this.humidityService = new Service.HumiditySensor(this.name);
      this.humidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(this.getStateHumidity.bind(this));

      this.humidityService.addCharacteristic(Characteristic.StatusFault);
      this.humidityService.addCharacteristic(Characteristic.StatusActive);
      this.humidityService.setCharacteristic(Characteristic.StatusActive, false);
      this.humidityService.setCharacteristic(Characteristic.SerialNumber, "Station:" + this.name);

    }

    if (this.sensors.pressure) {
      this.airPressureService = new this.AirPressureService(this.name + " Air Pressure", "airPressure");
      this.airPressureService.getCharacteristic(this.AirPressureCharacteristic)
        .onGet(this.getStatePressure.bind(this));
      this.airPressureService.setCharacteristic(Characteristic.StatusFault, true);
      this.airPressureService.setCharacteristic(Characteristic.StatusActive, false);
    }

    this._initHistory();
  }

  /**
   * Initializes FakeGato weather history using the enabled sensor services.
   *
   * Weather history entries contain temperature, humidity, and pressure.
   * Missing readings are recorded as zero to preserve the expected entry format.
   * 
   * @private
   */
  _initHistory() {
    const sensorServices = [
      this.temperatureService,
      this.humidityService,
      this.airPressureService
    ].filter(Boolean);

    if (!this.history && sensorServices.length) {
      const historyAccessory = {
        displayName: this.name,
        log: this.log,
        services: sensorServices
      };
      this.history = new this.FakeGatoHistoryService("weather", historyAccessory, {
        storage: "fs"
      });
      this.log("[BOM gov au] Initialized FakeGato history");
    }
  }

  /**
   * Returns all HomeKit services for this accessory.
   *
   * @returns {Service[]} Array of HomeKit services
   */
  getServices() {
    const { Service, Characteristic } = this.hap;

    const services = [
      new Service.AccessoryInformation()
        .setCharacteristic(Characteristic.Manufacturer, "PCoombe")
        .setCharacteristic(Characteristic.Model, "Homebridge-BOMgovau-v2 v" + PLUGIN_VERSION)
        .setCharacteristic(Characteristic.FirmwareRevision, "v" + PLUGIN_VERSION)
        .setCharacteristic(Characteristic.SerialNumber, "Station: " + this.name)
    ];

    if (this.sensors.temperature && this.temperatureService) {
      services.push(this.temperatureService);
    }
    if (this.sensors.apparentTemp && this.apparentTempService) {
      services.push(this.apparentTempService);
    }
    if (this.sensors.humidity && this.humidityService) {
      services.push(this.humidityService);
    }
    if (this.sensors.pressure && this.airPressureService) {
      services.push(this.airPressureService);
    }
    if (this.history) {
      services.push(this.history);
    }

    return services;
  }

  /**
   * Shutdown method for cleanup.
   *
   * Called by Homebridge when accessory is removed.
   * Clears the periodic update interval.
   */
  shutdown() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      this.log("[BOM gov au] Stopped periodic updates");
    }
  }

  /**
   * Fetches and updates weather observations from BOM.
   *
   * Concurrent callers share the same in-flight request.
   *
   * @async
   * @returns {Promise<void>}
   */
  updateObservations() {
    if (!this._updatePromise) {
      this._updatePromise = this._performObservationUpdate()
        .finally(() => {
          this._updatePromise = null;
        });
    }
    return this._updatePromise;
  }

  /**
   * Fetches observations, updates sensor availability, and records history.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _performObservationUpdate() {
    const { Characteristic } = this.hap;

    /** @type {number} */
    const now = Date.now();

    if (now < this.BOMdataExpires) {
      this.log("[BOM gov au] BOM data will expire at " + new Date(this.BOMdataExpires).toLocaleString() + " which is in " +
        ((this.BOMdataExpires - now) / 1000 / 60).toFixed(1) + "min");
      return;
    }

    this.log("[BOM gov au] Current Time is " + now + ", BOM data expires at " + this.BOMdataExpires);
    this.log("[BOM gov au] Updating observations from BOM.");

    try {
      const { observation, header, fetchedAt, expiresAt } = await this.bomClient.fetchObservations();
      this.obs = observation;
      this.header = header;
      this.log("[BOM gov au] Observations retrieved for " + this.header.name + ", " + this.header.state);

      this.BOMdataExpires = expiresAt;
      this.log("[BOM gov au] BOM data will expire at " + new Date(this.BOMdataExpires).toLocaleString() + " which is in " +
        ((this.BOMdataExpires - fetchedAt) / 1000 / 60).toFixed(1) + "min");

      const temperature = this._getObservationValue("air_temp", -100, 100);
      const apparentTemp = this._getObservationValue("apparent_t", -100, 100);
      const humidity = this._getObservationValue("rel_hum", 0, 100);
      const pressure = this._getObservationValue("press", 700, 1100);

      if (this.sensors.temperature && this.temperatureService) {
        this.temperatureService.setCharacteristic(Characteristic.StatusActive, temperature !== undefined);
        this.temperatureService.setCharacteristic(Characteristic.StatusFault, temperature === undefined);
        if (temperature !== undefined) {
          this.temperatureService.updateCharacteristic(Characteristic.CurrentTemperature, temperature);
        }
      }

      if (this.sensors.apparentTemp && this.apparentTempService) {
        this.apparentTempService.setCharacteristic(Characteristic.StatusActive, apparentTemp !== undefined);
        this.apparentTempService.setCharacteristic(Characteristic.StatusFault, apparentTemp === undefined);
        if (apparentTemp !== undefined) {
          this.apparentTempService.updateCharacteristic(Characteristic.CurrentTemperature, apparentTemp);
        }
      }

      if (this.sensors.humidity && this.humidityService) {
        this.humidityService.setCharacteristic(Characteristic.StatusActive, humidity !== undefined);
        this.humidityService.setCharacteristic(Characteristic.StatusFault, humidity === undefined);
        if (humidity !== undefined) {
          this.humidityService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humidity);
        }
      }

      if (this.sensors.pressure && this.airPressureService) {
        this.airPressureService.setCharacteristic(Characteristic.StatusActive, pressure !== undefined);
        this.airPressureService.setCharacteristic(Characteristic.StatusFault, pressure === undefined);
        if (pressure !== undefined) {
          this.airPressureService.updateCharacteristic(this.AirPressureCharacteristic, pressure);
        }
      }

      if (this.history) {
        this.history.addEntry({
          time: Math.floor(fetchedAt / 1000),
          temp: temperature ?? 0,
          humidity: humidity ?? 0,
          pressure: pressure ?? 0
        });
        this.log("[BOM gov au] Added FakeGato history entry");
      }
    } catch (error) {
      this.log.error("[BOM gov au] Failed to fetch BOM data:", error.message);

      if (this.sensors.temperature && this.temperatureService) {
        this.temperatureService.setCharacteristic(Characteristic.StatusActive, false);
        this.temperatureService.setCharacteristic(Characteristic.StatusFault, true);
      }
      if (this.sensors.apparentTemp && this.apparentTempService) {
        this.apparentTempService.setCharacteristic(Characteristic.StatusActive, false);
        this.apparentTempService.setCharacteristic(Characteristic.StatusFault, true);
      }
      if (this.sensors.humidity && this.humidityService) {
        this.humidityService.setCharacteristic(Characteristic.StatusActive, false);
        this.humidityService.setCharacteristic(Characteristic.StatusFault, true);
      }
      if (this.sensors.pressure && this.airPressureService) {
        this.airPressureService.setCharacteristic(Characteristic.StatusActive, false);
        this.airPressureService.setCharacteristic(Characteristic.StatusFault, true);
      }
    }
  }

  /**
   * Gets the current air temperature.
   *
   * @returns {Promise<number>} Temperature in Celsius
   * @throws {Error} If temperature is unavailable or outside the supported range
   */
  async getStateTemperature() {
    await this.updateObservations();
    const value = this._getObservationValue("air_temp", -100, 100);
    if (value === undefined) {
      throw new Error("BOM temperature is unavailable or outside the supported range");
    }
    return value;
  }

  /**
   * Gets the current air pressure.
   *
   * @returns {Promise<number>} Pressure in hPa
   * @throws {Error} If pressure is unavailable or outside the supported range
   */
  async getStatePressure() {
    await this.updateObservations();
    const value = this._getObservationValue("press", 700, 1100);
    if (value === undefined) {
      throw new Error("BOM pressure is unavailable or outside the supported range");
    }
    return value;
  }

  /**
   * Gets the current apparent temperature.
   *
   * @returns {Promise<number>} Apparent temperature in Celsius
   * @throws {Error} If apparent temperature is unavailable or outside the supported range
   */
  async getStateApparentTemperature() {
    await this.updateObservations();
    const value = this._getObservationValue("apparent_t", -100, 100);
    if (value === undefined) {
      throw new Error("BOM apparent temperature is unavailable or outside the supported range");
    }
    return value;
  }

  /**
   * Gets the current relative humidity.
   *
   * @returns {Promise<number>} Relative humidity percentage
   * @throws {Error} If humidity is unavailable or outside the supported range
   */
  async getStateHumidity() {
    await this.updateObservations();
    const value = this._getObservationValue("rel_hum", 0, 100);
    if (value === undefined) {
      throw new Error("BOM humidity is unavailable or outside the supported range");
    }
    return value;
  }
}

/**
 * Homebridge plugin entry point.
 *
 * @param {HomebridgeAPI} api - Homebridge API instance
 */
module.exports = api => {
  api.registerAccessory(PLUGIN_NAME, "BOMgovau", BOMgovauAccessory);
};