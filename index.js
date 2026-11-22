/**
 * @file homebridge-bomgovau-v2
 * @description Homebridge plugin for Australian Bureau of Meteorology (BOM) weather data
 * @author Peter Coombe, Originally Stephen Cohen
 * @license Apache-2.0
 * @see https://github.com/pcoombe/homebridge-BOMgovau
 * @see https://github.com/SteveCohen/homebridge-BOMgovau
 */

"use strict";

const { Service, Characteristic } = require("hap-nodejs");
const pjson = require("./package.json");
const dns = require("node:dns").promises;
const { BlockList } = require("node:net");

/** @const {string} Plugin name from package.json */
const PLUGIN_NAME = pjson.name;
/** @const {string} Plugin version from package.json */
const PLUGIN_VERSION = pjson.version;
const DEFAULT_UPDATE_FREQUENCY = 30 * 60 * 1000;
const MIN_UPDATE_FREQUENCY = 60 * 1000;
const MAX_UPDATE_FREQUENCY = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const nonPublicAddresses = new BlockList();
[
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"]
].forEach(([address, prefix, family]) => {
  nonPublicAddresses.addSubnet(address, prefix, family);
});

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
   * @param {HomebridgeAPI} api - Homebridge API instance
   * @param {HomebridgeLogger} logger - Homebridge logger instance
   * @param {Object} config - Accessory configuration
   * @param {string} [config.name="BOM Weather Station"] - Display name for the accessory
   * @param {string} [config.stationURL] - BOM JSON observation URL (defaults to Canberra Airport)
   * @param {number} [config.updateFrequency=1800000] - Update interval in milliseconds (default 30 min)
   * @param {Object} [config.sensors] - Sensor enable/disable configuration
   * @param {boolean} [config.sensors.temperature=true] - Enable temperature sensor
   * @param {boolean} [config.sensors.humidity=true] - Enable humidity sensor
   * @param {boolean} [config.sensors.apparentTemp=true] - Enable apparent temperature sensor
   */
  constructor(api, logger, config) {
    /** @type {HomebridgeLogger} */
    this.log = logger;
    /** @type {string} */
    this.name = config.name || "BOM Weather Station";

    // Load community types and FakeGato - instance local, not global
    /** @type {Object} */
    this.CommunityTypes = require("hap-nodejs-community-types")(api);
    /** @type {Function} */
    this.FakeGatoHistoryService = require("fakegato-history")(api);

    // Station configuration
    /** @type {string} */
    this.stationURL = config.stationURL || "http://reg.bom.gov.au/fwo/IDN60903/IDN60903.94926.json";
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

    // Validate stationURL
    if (!this._isValidUrl(this.stationURL)) {
      this.log.error("[BOM gov au] Invalid stationURL: " + this.stationURL + ". Using default.");
      this.stationURL = "http://reg.bom.gov.au/fwo/IDN60903/IDN60903.94926.json";
    }

    // Sensor configuration
    /** @type {Object.<string, boolean>} */
    this.sensors = {
      temperature: true,
      humidity: true,
      apparentTemp: true
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
      air_temp: 0,
      press: 0,
      rel_hum: 0,
      apparent_t: 0
    };
    /** @type {number} */
    this.BOMdataExpires = 0;
    /** @type {Object|null} */
    this.history = null;
    /** @type {boolean} */
    this._updateLock = false; // Mutex for race condition prevention

    // Setup services
    this.setupServices();

    // Start periodic updates (non-blocking)
    /** @type {NodeJS.Timeout|null} */
    this.updateInterval = setInterval(() => this.updateObservations(), this.updateFrequency);

    // Trigger initial update asynchronously (non-blocking)
    setImmediate(() => this.updateObservations());
  }

  /**
   * Validates a URL string.
   * 
   * @param {string} string - URL to validate
   * @returns {boolean} True if valid URL
   * @private
   */
  _isValidUrl(string) {
    try {
      const url = new URL(string);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return false;
      }
      if (url.username || url.password) {
        return false;
      }
      const hostname = url.hostname.toLowerCase();
      return hostname === "bom.gov.au" || hostname.endsWith(".bom.gov.au");
    } catch (_) {
      return false;
    }
  }

  /**
   * Resolves a station host and prevents DNS resolution to private networks.
   *
   * @param {string} stationURL - BOM station URL
   * @returns {Promise<void>}
   * @private
   */
  async _validateStationHost(stationURL) {
    const url = new URL(stationURL);
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address, family }) =>
      nonPublicAddresses.check(address, family === 6 ? "ipv6" : "ipv4"))) {
      throw new Error("Station host resolves to a non-public IP address");
    }
  }

  /**
   * Fetches the station URL while rejecting redirects outside BOM and limiting response size.
   *
   * @returns {Promise<Object>}
   * @private
   */
  async _fetchStationJson() {
    let currentURL = this.stationURL;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      if (!this._isValidUrl(currentURL)) {
        throw new Error("Station URL is not an approved BOM host");
      }
      await this._validateStationHost(currentURL);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(currentURL, {
          headers: { "User-Agent": PLUGIN_NAME + "/" + PLUGIN_VERSION + " (" + this.name + ")" },
          redirect: "manual",
          signal: controller.signal
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            throw new Error("Redirect response missing Location header");
          }
          currentURL = new URL(location, currentURL).toString();
          continue;
        }

        if (!response.ok) {
          throw new Error("HTTP error " + response.status);
        }

        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
          throw new Error("BOM response exceeds maximum allowed size");
        }

        if (!response.body) {
          throw new Error("BOM response has no body");
        }

        let receivedBytes = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_RESPONSE_BYTES) {
            throw new Error("BOM response exceeds maximum allowed size");
          }
          chunks.push(Buffer.from(chunk));
        }

        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error("Too many redirects");
  }

  /**
   * Sets up HomeKit services based on enabled sensors.
   * 
   * Creates TemperatureSensor, HumiditySensor services and adds
   * pressure characteristic to temperature service.
   * Initializes FakeGato history on first enabled sensor.
   * 
   * @private
   */
  setupServices() {
    // Temperature Service
    if (this.sensors.temperature) {
      /** @type {Service} */
      this.temperatureService = new Service.TemperatureSensor(this.name);
      this.temperatureService.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -100, maxValue: 100 })
        .onGet(this.getStateTemperature.bind(this));

      // Add pressure characteristic (non-standard, added to temperature service)
      this.temperatureService.addCharacteristic(this.CommunityTypes.AtmosphericPressureLevel)
        .setProps({ format: Characteristic.Formats.UINT16, minValue: 800, maxValue: 1200 })
        .onGet(this.getStatePressure.bind(this));

      // Service status
      this.temperatureService.addCharacteristic(Characteristic.StatusFault);
      this.temperatureService.addCharacteristic(Characteristic.StatusActive);
      this.temperatureService.setCharacteristic(Characteristic.StatusActive, false);

      // Initialize FakeGato history (will be created on first enabled sensor)
      this._initHistory();
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

      // Initialize FakeGato history if not already created
      this._initHistory();
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

      // Initialize FakeGato history if not already created
      this._initHistory();
    }
  }

  /**
   * Initializes FakeGato history on the first enabled sensor.
   * 
   * Creates history on temperature service if available, otherwise humidity.
   * Only creates once per accessory instance.
   * 
   * @private
   */
  _initHistory() {
    // Create FakeGato history on the first enabled sensor that supports it
    if (!this.history && (this.sensors.temperature || this.sensors.humidity)) {
      /** @type {Service|null} */
      const primaryService = this.temperatureService || this.humidityService;
      if (primaryService) {
        primaryService.setCharacteristic(Characteristic.SerialNumber, "Station:" + this.name);
        this.history = new this.FakeGatoHistoryService("weather", primaryService, { storage: "fs" });
        this.log("[BOM gov au] Initialized FakeGato history on " + primaryService.displayName);
      }
    }
  }

  /**
   * Returns all HomeKit services for this accessory.
   * 
   * @returns {Service[]} Array of HomeKit services
   */
  getServices() {
    /** @type {Service[]} */
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
   * Uses mutex lock to prevent concurrent fetches (race condition protection).
   * Parses BOM timestamp and sets data expiry based on update frequency.
   * Updates all enabled sensor characteristics and logs to FakeGato history.
   * 
   * @async
   * @returns {Promise<void>}
   */
  async updateObservations() {
    // Mutex to prevent concurrent fetches (race condition fix)
    if (this._updateLock) {
      this.log("[BOM gov au] Update already in progress, skipping");
      return;
    }

    /** @type {number} */
    const now = Date.now();

    if (now >= this.BOMdataExpires) {
      this._updateLock = true;
      this.log("[BOM gov au] Current Time is " + now + ", BOM data expires at " + this.BOMdataExpires);
      this.log("[BOM gov au] Updating observations from BOM.");

      try {
        /** @type {Object} */
        const json = await this._fetchStationJson();

        this.obs = json.observations.data[0];
        this.header = json.observations.header[0];

        this.log("[BOM gov au] Observations retrieved for " + this.header.name + ", " + this.header.state);

        const fetchedAt = Date.now();
        // Parse BOM timestamp (format: YYYYMMDDHHMMSS)
        const timestamp = this.obs.aifstime_utc;
        const validTimestamp = typeof timestamp === "string" && /^\d{14}$/.test(timestamp);
        /** @type {number} */
        const BOMyear = validTimestamp ? parseInt(timestamp.substr(0, 4)) : NaN;
        /** @type {number} */
        const BOMmonth = validTimestamp ? parseInt(timestamp.substr(4, 2)) - 1 : NaN;
        /** @type {number} */
        const BOMday = validTimestamp ? parseInt(timestamp.substr(6, 2)) : NaN;
        /** @type {number} */
        const BOMhour = validTimestamp ? parseInt(timestamp.substr(8, 2)) : NaN;
        /** @type {number} */
        const BOMmin = validTimestamp ? parseInt(timestamp.substr(10, 2)) : NaN;
        /** @type {number} */
        const BOMsec = validTimestamp ? parseInt(timestamp.substr(12, 2)) : NaN;
        const observationTime = validTimestamp
          ? Date.UTC(BOMyear, BOMmonth, BOMday, BOMhour, BOMmin, BOMsec)
          : NaN;
        const observationExpiry = observationTime + this.updateFrequency;

        // Use the observation expiry if it is still ahead; otherwise wait a full interval after fetch.
        this.BOMdataExpires = Number.isFinite(observationExpiry) && observationExpiry > fetchedAt
          ? observationExpiry
          : fetchedAt + this.updateFrequency;
        this.log("[BOM gov au] BOM data will expire at " + new Date(this.BOMdataExpires).toLocaleString() + " which is in " +
          ((this.BOMdataExpires - fetchedAt) / 1000 / 60).toFixed(1) + "min");

        // Update characteristics
        if (this.sensors.temperature && this.temperatureService) {
          this.temperatureService.setCharacteristic(Characteristic.StatusActive, true);
          this.temperatureService.setCharacteristic(Characteristic.StatusFault, false);
          this.temperatureService.updateCharacteristic(Characteristic.CurrentTemperature,
            isNaN(this.obs.air_temp) ? 0 : this.obs.air_temp);
          this.temperatureService.updateCharacteristic(this.CommunityTypes.AtmosphericPressureLevel,
            isNaN(this.obs.press) ? 0 : this.obs.press);
        }

        if (this.sensors.apparentTemp && this.apparentTempService) {
          this.apparentTempService.setCharacteristic(Characteristic.StatusActive, true);
          this.apparentTempService.setCharacteristic(Characteristic.StatusFault, false);
          this.apparentTempService.updateCharacteristic(Characteristic.CurrentTemperature,
            isNaN(this.obs.apparent_t) ? 0 : this.obs.apparent_t);
        }

        if (this.sensors.humidity && this.humidityService) {
          this.humidityService.setCharacteristic(Characteristic.StatusActive, true);
          this.humidityService.setCharacteristic(Characteristic.StatusFault, false);
          this.humidityService.updateCharacteristic(Characteristic.CurrentRelativeHumidity,
            isNaN(this.obs.rel_hum) ? 0 : this.obs.rel_hum);
        }

        // FakeGato logging
        if (this.history) {
          this.history.addEntry({
            time: Math.floor(now / 1000),
            temp: this.obs.air_temp,
            pressure: this.obs.press,
            humidity: this.obs.rel_hum
          });
          this.log("[BOM gov au] Added FakeGato history entry");
        }

      } catch (error) {
        this.log.error("[BOM gov au] Failed to fetch BOM data:", error.message);

        if (this.sensors.temperature && this.temperatureService) {
          this.temperatureService.setCharacteristic(Characteristic.StatusFault, true);
        }
        if (this.sensors.apparentTemp && this.apparentTempService) {
          this.apparentTempService.setCharacteristic(Characteristic.StatusFault, true);
        }
        if (this.sensors.humidity && this.humidityService) {
          this.humidityService.setCharacteristic(Characteristic.StatusFault, true);
        }
      } finally {
        this._updateLock = false;
      }
    } else {
      this.log("[BOM gov au] BOM data will expire at " + new Date(this.BOMdataExpires).toLocaleString() + " which is in " +
        ((this.BOMdataExpires - now) / 1000 / 60).toFixed(1) + "min");
    }
  }

  /**
   * Gets current temperature state.
   * 
   * @async
   * @returns {Promise<number>} Temperature in Celsius, 0 if unavailable
   */
  async getStateTemperature() {
    try {
      await this.updateObservations();
      return isNaN(this.obs.air_temp) ? 0 : this.obs.air_temp;
    } catch (error) {
      this.log.error("[BOM gov au] getStateTemperature error:", error.message);
      return 0; // Safe default
    }
  }

  /**
   * Gets current atmospheric pressure state.
   * 
   * @async
   * @returns {Promise<number>} Pressure in hPa, 0 if unavailable
   */
  async getStatePressure() {
    try {
      await this.updateObservations();
      return isNaN(this.obs.press) ? 0 : this.obs.press;
    } catch (error) {
      this.log.error("[BOM gov au] getStatePressure error:", error.message);
      return 0; // Safe default
    }
  }

  /**
   * Gets current apparent temperature state.
   * 
   * @async
   * @returns {Promise<number>} Apparent temperature in Celsius, 0 if unavailable
   */
  async getStateApparentTemperature() {
    try {
      await this.updateObservations();
      return isNaN(this.obs.apparent_t) ? 0 : this.obs.apparent_t;
    } catch (error) {
      this.log.error("[BOM gov au] getStateApparentTemperature error:", error.message);
      return 0; // Safe default
    }
  }

  /**
   * Gets current humidity state.
   * 
   * @async
   * @returns {Promise<number>} Relative humidity percentage, 0 if unavailable
   */
  async getStateHumidity() {
    try {
      await this.updateObservations();
      return isNaN(this.obs.rel_hum) ? 0 : this.obs.rel_hum;
    } catch (error) {
      this.log.error("[BOM gov au] getStateHumidity error:", error.message);
      return 0; // Safe default
    }
  }
}

/**
 * Homebridge plugin entry point.
 * 
 * Registers the BOMgovau accessory with Homebridge.
 * 
 * @param {HomebridgeAPI} api - Homebridge API instance
 */
module.exports = (api) => {
  api.registerAccessory(PLUGIN_NAME, "BOMgovau", BOMgovauAccessory);
};