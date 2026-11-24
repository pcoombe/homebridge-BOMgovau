"use strict";

const pjson = require("../package.json");
const dns = require("node:dns").promises;
const { BlockList } = require("node:net");

const PLUGIN_NAME = pjson.name;
const PLUGIN_VERSION = pjson.version;
const DEFAULT_STATION_URL = "http://reg.bom.gov.au/fwo/IDN60903/IDN60903.94926.json";
const FETCH_TIMEOUT_MS = 10 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1500;
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
 * Fetches and parses weather observations from an approved BOM station URL.
 */
class BomClient {
  /**
   * @param {Object} options
   * @param {string} [options.stationURL] - BOM JSON observation URL
   * @param {string} options.name - Accessory name for the request User-Agent
   * @param {number} options.updateFrequency - Observation cache duration in milliseconds
   * @param {HomebridgeLogger} options.log - Homebridge logger
   */
  constructor({ stationURL, name, updateFrequency, log }) {
    this.name = name;
    this.updateFrequency = updateFrequency;
    this.log = log;
    this.stationURL = stationURL || DEFAULT_STATION_URL;

    if (!this._isValidUrl(this.stationURL)) {
      this.log.error("[BOM gov au] Invalid stationURL: " + this.stationURL + ". Using default.");
      this.stationURL = DEFAULT_STATION_URL;
    }
  }

  /**
   * Fetches the latest station observation and computes its cache expiry.
   *
   * @returns {Promise<{observation: Object, header: Object, fetchedAt: number, expiresAt: number}>}
   */
  async fetchObservations() {
    const json = await this._fetchStationJson();
    const observation = json?.observations?.data?.[0];
    const header = json?.observations?.header?.[0];
    if (!observation || typeof observation !== "object" || !header || typeof header !== "object") {
      throw new Error("BOM response is missing observation data or station header");
    }

    const fetchedAt = Date.now();
    const timestamp = observation.aifstime_utc;
    const validTimestamp = typeof timestamp === "string" && /^\d{14}$/.test(timestamp);
    /** @type {number} */
    const BOMyear = validTimestamp ? parseInt(timestamp.slice(0, 4), 10) : NaN;
    /** @type {number} */
    const BOMmonth = validTimestamp ? parseInt(timestamp.slice(4, 6), 10) - 1 : NaN;
    /** @type {number} */
    const BOMday = validTimestamp ? parseInt(timestamp.slice(6, 8), 10) : NaN;
    /** @type {number} */
    const BOMhour = validTimestamp ? parseInt(timestamp.slice(8, 10), 10) : NaN;
    /** @type {number} */
    const BOMmin = validTimestamp ? parseInt(timestamp.slice(10, 12), 10) : NaN;
    /** @type {number} */
    const BOMsec = validTimestamp ? parseInt(timestamp.slice(12, 14), 10) : NaN;
    /** @type {Date|null} */
    const observationDate = validTimestamp ? new Date(0) : null;
    observationDate?.setUTCFullYear(BOMyear, BOMmonth, BOMday);
    observationDate?.setUTCHours(BOMhour, BOMmin, BOMsec, 0);
    /** @type {number} */
    const observationTime = observationDate?.getTime() ?? NaN;
    const observationExpiry = observationTime + this.updateFrequency;
    const expiresAt = Number.isFinite(observationExpiry) && observationExpiry > fetchedAt
      ? observationExpiry
      : fetchedAt + this.updateFrequency;

    return { observation, header, fetchedAt, expiresAt };
  }

  /**
   * Validates a URL string.
   *
   * @param {string} value - URL to validate
   * @returns {boolean} True if valid URL
   * @private
   */
  _isValidUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return false;
      }
      if (url.username || url.password) {
        return false;
      }
      const hostname = url.hostname.toLowerCase();
      return hostname === "bom.gov.au" || hostname.endsWith(".bom.gov.au");
    } catch {
      return false;
    }
  }

  /**
   * Resolves the station host and rejects private network addresses.
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
   * Fetches station JSON while restricting redirects and response size.
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

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
            await response.body?.cancel();
            currentURL = new URL(location, currentURL).toString();
            break;
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
        } catch (error) {
          clearTimeout(timeout);
          if (attempt === MAX_RETRIES) {
            throw error;
          }
          this.log.warn("[BOM gov au] Fetch attempt " + (attempt + 1) + " failed: " + error.message + ". Retrying...");
          await new Promise(r => setTimeout(r, RETRY_BASE_DELAY_MS * Math.pow(2, attempt)));
        } finally {
          clearTimeout(timeout);
        }
      }
    }

    throw new Error("Too many redirects");
  }
}
module.exports = BomClient;
