"use strict";

const { JSONPath } = require("jsonpath-plus");

let Service, Characteristic;

const PLUGIN_NAME = "homebridge-http-json-dimmer";
const PLATFORM_NAME = "HTTP-JSON-DIMMER";

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HttpJsonDimmerPlatform);
};

// ---------- helpers ----------
function parseBooleanLoose(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "on" || t === "1") return true;
    if (t === "false" || t === "off" || t === "0") return false;
  }
  return Boolean(v);
}

function clampInt(n, min, max, fallback = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.round(x)));
}

function tryJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickJsonValue(obj, selector) {
  if (!selector) return undefined;
  const sel = String(selector).trim();
  if (!sel) return undefined;

  if (sel.startsWith("$")) {
    return JSONPath({ path: sel, json: obj, wrap: false });
  }

  const parts = sel.split(".").map((p) => p.trim()).filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

async function httpGet(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

function toHomeKitBrightness(raw, scale, fallback = 0) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;

  switch (scale) {
    case "0-1":
      return clampInt(n * 100, 0, 100, fallback);
    case "0-255":
      return clampInt((n / 255) * 100, 0, 100, fallback);
    case "0-100":
    default:
      return clampInt(n, 0, 100, fallback);
  }
}

function fromHomeKitBrightness(hk, scale) {
  const v = clampInt(hk, 0, 100, 0);
  switch (scale) {
    case "0-1":
      return (v / 100).toFixed(3);
    case "0-255":
      return clampInt((v / 100) * 255, 0, 255, 0);
    case "0-100":
    default:
      return v;
  }
}

// ---------- platform ----------
class HttpJsonDimmerPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.accessories = new Map(); // uuid -> accessory

    api.on("didFinishLaunching", async () => {
      await this.syncDevices();
    });
  }

  configureAccessory(accessory) {
    // Called by Homebridge to restore cached accessories
    this.accessories.set(accessory.UUID, accessory);
  }

  async syncDevices() {
    const devices = Array.isArray(this.config.devices) ? this.config.devices : [];
    const desiredUuids = new Set();

    for (const dev of devices) {
      if (!dev || !dev.name || !dev.onUrl || !dev.offUrl) continue;

      const stableKey = String(dev.id || dev.name);
      const uuid = this.api.hap.uuid.generate(`http-json-dimmer:${stableKey}`);
      desiredUuids.add(uuid);

      let accessory = this.accessories.get(uuid);

      if (!accessory) {
        accessory = new this.api.platformAccessory(dev.name, uuid);
        accessory.context.device = dev;
        this.attachServices(accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
        this.log(`Registered: ${dev.name} (${stableKey})`);
      } else {
        // update context + display name
        accessory.displayName = dev.name;
        accessory.context.device = dev;
        this.attachServices(accessory);
        this.api.updatePlatformAccessories([accessory]);
        this.log(`Updated: ${dev.name} (${stableKey})`);
      }
    }

    // Remove accessories no longer in config
    const toRemove = [];
    for (const [uuid, acc] of this.accessories.entries()) {
      if (!desiredUuids.has(uuid)) {
        toRemove.push(acc);
        this.accessories.delete(uuid);
      }
    }
    if (toRemove.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRemove);
      this.log(`Removed ${toRemove.length} accessory(ies)`);
    }
  }

  attachServices(accessory) {
    const dev = accessory.context.device || {};
    const controller = new DeviceController(this.log, dev);

    // AccessoryInformation
    const info =
      accessory.getService(Service.AccessoryInformation) ||
      accessory.addService(Service.AccessoryInformation);

    info
      .setCharacteristic(Characteristic.Manufacturer, dev.manufacturer || "HTTP JSON Dimmer")
      .setCharacteristic(Characteristic.Model, dev.model || "HTTP-JSON-DIMMER")
      .setCharacteristic(Characteristic.SerialNumber, dev.serial || (dev.id || dev.name || "http-json-dimmer"));

    // Lightbulb
    const svc = accessory.getService(Service.Lightbulb) || accessory.addService(Service.Lightbulb, dev.name);

    svc.getCharacteristic(Characteristic.On)
      .on("get", controller.getOn.bind(controller))
      .on("set", controller.setOn.bind(controller));

    svc.getCharacteristic(Characteristic.Brightness)
      .on("get", controller.getBrightness.bind(controller))
      .on("set", controller.setBrightness.bind(controller));
  }
}

// ---------- per-device controller ----------
class DeviceController {
  constructor(log, dev) {
    this.log = log;
    this.dev = dev || {};

    this.isOn = false;
    this.brightness = 0;

    this.timeoutMs = clampInt(this.dev.timeoutMs, 500, 20000, 4000);

    this.onJsonPath = this.dev.onJsonPath || this.dev.statusOnJsonPath || "$.on";
    this.brightnessJsonPath = this.dev.brightnessJsonPath || "$.brightness";

    this.brightnessScale = this.dev.brightnessScale || "0-100";
    this.brightnessWriteScale = this.dev.brightnessWriteScale || this.brightnessScale;
  }

  async getOn(callback) {
    try {
      if (!this.dev.statusUrl) return callback(null, this.isOn);

      const { ok, status, body } = await httpGet(this.dev.statusUrl, this.timeoutMs);
      if (!ok) return callback(null, this.isOn);

      const json = tryJsonParse(body);
      if (!json) {
        this.isOn = parseBooleanLoose(body);
        return callback(null, this.isOn);
      }

      this.isOn = parseBooleanLoose(pickJsonValue(json, this.onJsonPath));
      return callback(null, this.isOn);
    } catch (e) {
      this.log(`getOn error (${this.dev.name}): ${e?.message || e}`);
      return callback(null, this.isOn);
    }
  }

  async setOn(value, callback) {
    try {
      this.isOn = Boolean(value);
      const url = this.isOn ? this.dev.onUrl : this.dev.offUrl;
      if (!url) return callback(null);

      await httpGet(url, this.timeoutMs);
      return callback(null);
    } catch (e) {
      this.log(`setOn error (${this.dev.name}): ${e?.message || e}`);
      return callback(null);
    }
  }

  async getBrightness(callback) {
    try {
      if (!this.dev.getBrightnessUrl) return callback(null, this.brightness);

      const { ok, body } = await httpGet(this.dev.getBrightnessUrl, this.timeoutMs);
      if (!ok) return callback(null, this.brightness);

      const json = tryJsonParse(body);
      if (!json) {
        this.brightness = toHomeKitBrightness(body, this.brightnessScale, this.brightness);
        return callback(null, this.brightness);
      }

      const v = pickJsonValue(json, this.brightnessJsonPath);
      this.brightness = toHomeKitBrightness(v, this.brightnessScale, this.brightness);
      return callback(null, this.brightness);
    } catch (e) {
      this.log(`getBrightness error (${this.dev.name}): ${e?.message || e}`);
      return callback(null, this.brightness);
    }
  }

  async setBrightness(value, callback) {
    try {
      const hk = clampInt(value, 0, 100, 0);
      this.brightness = hk;

      if (!this.dev.setBrightnessUrl) return callback(null, hk);

      const deviceVal = fromHomeKitBrightness(hk, this.brightnessWriteScale);
      const url = `${this.dev.setBrightnessUrl}${encodeURIComponent(String(deviceVal))}`;

      await httpGet(url, this.timeoutMs);
      return callback(null, hk);
    } catch (e) {
      this.log(`setBrightness error (${this.dev.name}): ${e?.message || e}`);
      return callback(null, this.brightness);
    }
  }
}