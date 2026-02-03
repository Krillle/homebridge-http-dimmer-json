"use strict";

let Service, Characteristic;

const { JSONPath } = require("jsonpath-plus");

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerAccessory(
    "homebridge-http-json-dimmer",
    "HTTP-JSON-DIMMER",
    HttpJsonDimmerAccessory
  );
};

// ---------------------------
// Helpers
// ---------------------------
function withTrailingSlashTrim(s) {
  return String(s || "").trim();
}

function parseBooleanLoose(v) {
  // Accept: true/false, 1/0, "1"/"0", "true"/"false", "on"/"off"
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
  // selector supports:
  // - JSONPath (starting with "$")
  // - dotted path "a.b.c"
  // - direct top-level key "on"
  if (!selector) return undefined;
  const sel = String(selector).trim();
  if (!sel) return undefined;

  if (sel.startsWith("$")) {
    const res = JSONPath({ path: sel, json: obj, wrap: false });
    return res;
  }

  // dotted path
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

class HttpJsonDimmerAccessory {
  constructor(log, config) {
    this.log = log;
    this.config = config || {};

    // Required basics
    this.name = this.config.name || "HTTP JSON Dimmer";

    // URLs
    this.onUrl = withTrailingSlashTrim(this.config.onUrl);
    this.offUrl = withTrailingSlashTrim(this.config.offUrl);
    this.statusUrl = withTrailingSlashTrim(this.config.statusUrl);
    this.setBrightnessUrl = withTrailingSlashTrim(this.config.setBrightnessUrl);
    this.getBrightnessUrl = withTrailingSlashTrim(this.config.getBrightnessUrl);

    // JSON selectors (new)
    // Examples for Shelly RPC Light.GetStatus:
    //   onJsonPath: "$.on"
    //   brightnessJsonPath: "$.brightness"
    this.onJsonPath = this.config.onJsonPath || this.config.statusOnJsonPath || "$.on";
    this.brightnessJsonPath = this.config.brightnessJsonPath || "$.brightness";

    // Parsing behavior
    this.timeoutMs = clampInt(this.config.timeoutMs, 500, 20000, 4000);

    // Some devices want brightness 0..1 or 0..255; default 0..100
    this.brightnessScale = this.config.brightnessScale || "0-100"; // "0-100" | "0-255" | "0-1"
    this.brightnessWriteScale = this.config.brightnessWriteScale || this.brightnessScale;

    // State cache
    this.isOn = false;
    this.brightness = 0;

    // HomeKit service
    this.service = new Service.Lightbulb(this.name);
  }

  getServices() {
    const info = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, this.config.manufacturer || "http-json-dimmer")
      .setCharacteristic(Characteristic.Model, this.config.model || "HTTP-JSON-DIMMER")
      .setCharacteristic(Characteristic.SerialNumber, this.config.serial || "homebridge-http-json-dimmer");

    this.service
      .getCharacteristic(Characteristic.On)
      .on("get", this.getOn.bind(this))
      .on("set", this.setOn.bind(this));

    this.service
      .getCharacteristic(Characteristic.Brightness)
      .on("get", this.getBrightness.bind(this))
      .on("set", this.setBrightness.bind(this));

    return [info, this.service];
  }

  // ---------------------------
  // HomeKit Handlers
  // ---------------------------
  async getOn(callback) {
    try {
      if (!this.statusUrl) return callback(null, this.isOn);

      const { ok, status, body } = await httpGet(this.statusUrl, this.timeoutMs);
      if (!ok) {
        this.log(`statusUrl not OK (${status}). Body: ${body?.slice?.(0, 200)}`);
        return callback(null, this.isOn);
      }

      const json = tryJsonParse(body);
      if (!json) {
        // Fallback: allow plain text 1/0/true/false
        this.isOn = parseBooleanLoose(body);
        return callback(null, this.isOn);
      }

      const v = pickJsonValue(json, this.onJsonPath);
      this.isOn = parseBooleanLoose(v);
      return callback(null, this.isOn);
    } catch (e) {
      this.log(`getOn error: ${e?.message || e}`);
      return callback(null, this.isOn);
    }
  }

  async setOn(value, callback) {
    try {
      this.isOn = Boolean(value);

      const url = this.isOn ? this.onUrl : this.offUrl;
      if (!url) return callback(null);

      const { ok, status, body } = await httpGet(url, this.timeoutMs);
      if (!ok) {
        this.log(`setOn failed (${status}). Body: ${body?.slice?.(0, 200)}`);
      }
      return callback(null);
    } catch (e) {
      this.log(`setOn error: ${e?.message || e}`);
      return callback(null);
    }
  }

  async getBrightness(callback) {
    try {
      if (!this.getBrightnessUrl) return callback(null, this.brightness);

      const { ok, status, body } = await httpGet(this.getBrightnessUrl, this.timeoutMs);
      if (!ok) {
        this.log(`getBrightnessUrl not OK (${status}). Body: ${body?.slice?.(0, 200)}`);
        return callback(null, this.brightness);
      }

      const json = tryJsonParse(body);
      if (!json) {
        // Fallback: plain numeric text
        const raw = Number(body);
        this.brightness = this._toHomeKitBrightness(raw, this.brightnessScale);
        return callback(null, this.brightness);
      }

      const v = pickJsonValue(json, this.brightnessJsonPath);
      this.brightness = this._toHomeKitBrightness(v, this.brightnessScale);
      return callback(null, this.brightness);
    } catch (e) {
      this.log(`getBrightness error: ${e?.message || e}`);
      return callback(null, this.brightness);
    }
  }

  async setBrightness(value, callback) {
    try {
      const hkBrightness = clampInt(value, 0, 100, 0);
      this.brightness = hkBrightness;

      if (!this.setBrightnessUrl) return callback(null, hkBrightness);

      const deviceBrightness = this._fromHomeKitBrightness(hkBrightness, this.brightnessWriteScale);
      const url = `${this.setBrightnessUrl}${encodeURIComponent(String(deviceBrightness))}`;

      const { ok, status, body } = await httpGet(url, this.timeoutMs);
      if (!ok) {
        this.log(`setBrightness failed (${status}). Body: ${body?.slice?.(0, 200)}`);
      }

      // If brightness is set to 0, some systems expect Off; optional behavior could be added.
      return callback(null, hkBrightness);
    } catch (e) {
      this.log(`setBrightness error: ${e?.message || e}`);
      return callback(null, this.brightness);
    }
  }

  // ---------------------------
  // Brightness scaling
  // ---------------------------
  _toHomeKitBrightness(raw, scale) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return this.brightness;

    switch (scale) {
      case "0-1":
        return clampInt(n * 100, 0, 100, this.brightness);
      case "0-255":
        return clampInt((n / 255) * 100, 0, 100, this.brightness);
      case "0-100":
      default:
        return clampInt(n, 0, 100, this.brightness);
    }
  }

  _fromHomeKitBrightness(hk, scale) {
    switch (scale) {
      case "0-1":
        return (hk / 100).toFixed(3);
      case "0-255":
        return clampInt((hk / 100) * 255, 0, 255, 0);
      case "0-100":
      default:
        return hk;
    }
  }
}