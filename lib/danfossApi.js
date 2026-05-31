"use strict";
const axios = require("axios");

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function inferDeviceType(rawType, statusMap) {
  const map = statusMap || {};
  if (rawType && rawType !== "unknown") {
    return rawType;
  }

  const statusCodes = Object.keys(map);
  const hasOnlyRelayShape = statusCodes.length > 0 && statusCodes.every(code => ["switch", "fault"].includes(code));
  if (hasOnlyRelayShape) {
    return "Danfoss Ally Boiler Relay";
  }

  if ("system_status_water" in map || "output_status" in map || "temp_mode" in map) {
    return "Danfoss Icon2";
  }

  if ("battery_percentage" in map && "temp_current" in map && "temp_set" in map) {
    return "Danfoss Ally Radiator Thermostat";
  }

  return rawType || "unknown";
}

function inferDeviceName(d, statusMap, type) {
  const map = statusMap || {};
  const explicitName = firstNonEmpty(
    d.name,
    d.displayName,
    d.deviceName,
    d.device_name,
    d.customName,
    d.custom_name,
    d.label,
    d.productName,
    d.product_name
  );

  if (explicitName && explicitName.toLowerCase() !== "device") {
    return explicitName;
  }

  const statusCodes = Object.keys(map);
  const hasOnlyRelayShape = statusCodes.length > 0 && statusCodes.every(code => ["switch", "fault"].includes(code));
  if (hasOnlyRelayShape) {
    return "Boiler Relay";
  }

  if (type && type !== "unknown") {
    return type;
  }

  return explicitName || "Device";
}

/**
 * Danfoss API client for Ally Cloud
 */
class DanfossAPI {
  /**
     Kostrukor
   
   * @param opts
   * @param log
   */
  constructor(opts, log) {
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.tokenUrl = opts.tokenUrl;
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, ""); // no trailing slash
    this.scope = opts.scope || "";
    this.log = log;

    // optional: zusätzliche Header (nur nutzen, wenn der Anbieter sie fordert)
    this.extraHeaders = opts.extraHeaders || {}; // { 'X-App-Key': '...', 'X-Organization-Id': '...', ... }

    this._token = null;
    this._tokenExpiry = 0;
    this._client = axios.create({
      timeout: 15000
    });
  }

  /**
     sinnvolle Defaults; werden mit extraHeaders gemerged
   */
  _defaultHeaders() {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Client": "iobroker-danfoss-ally/1.0"
    };
  }

  /**
     check token
   */
  async ensureToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this._token && now < this._tokenExpiry - 60) {
      return this._token;
    }
    if (!this.tokenUrl) {
      throw new Error("tokenUrl not configured. Please set in adapter settings.");
    }

    this.log.info("Refreshing OAuth2 token...");
    try {
      const params = new URLSearchParams();
      params.append("grant_type", "client_credentials");
      if (this.scope) {
        params.append("scope", this.scope);
      }

      const res = await this._client.post(this.tokenUrl, params.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        auth: {
          username: this.apiKey,
          password: this.apiSecret
        }
      });

      const data = res.data;
      this._token = data.access_token;
      const expiresIn = Number(data.expires_in || 1800);
      this._tokenExpiry = Math.floor(Date.now() / 1000) + expiresIn;
      this.log.info(`Token acquired. Expires in ~${expiresIn}s`);
      return this._token;
    } catch (err) {
      const msg = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
      throw new Error(`Token request failed: ${msg}`);
    }
  }

  /**
     Start Request
   
   * @param method
   * @param path
   * @param options
   */
  async _request(method, path, options = {}) {
    const token = await this.ensureToken();
    const url = `${this.apiBaseUrl}${path}`;

    // Headers aufbauen: Bearer + Defaults + extraHeaders + call-spezifische headers
    const headers = {
      Authorization: `Bearer ${token}`,
      ...this._defaultHeaders(),
      ...this.extraHeaders,
      ...(options.headers || {})
    };

    try {
      const res = await this._client.request({
        method,
        url,
        headers,
        ...options
      });
      return res.data;
    } catch (err) {
      // Token-Expiry oder abgelaufene Session: einmal neu probieren
      if (err.response && err.response.status === 401) {
        this._token = null;
        const t2 = await this.ensureToken();
        const headers2 = {
          Authorization: `Bearer ${t2}`,
          ...this._defaultHeaders(),
          ...this.extraHeaders,
          ...(options.headers || {})
        };
        const res2 = await this._client.request({
          method,
          url,
          headers: headers2,
          ...options
        });
        return res2.data;
      }
      throw err;
    }
  }

  /**
     Geräteliste abrufen
   */
  async getDevices() {
    const data = await this._request("GET", "/devices");

    const arr = Array.isArray(data?.result)
      ? data.result
      : Array.isArray(data?.devices)
        ? data.devices
        : Array.isArray(data)
          ? data
          : [];

    if (!arr.length) {
      this.log.warn("No devices returned by Danfoss API.");
      return [];
    }

    return arr.map(d => {
      const statusMap = {};
      if (Array.isArray(d.status)) {
        d.status.forEach(s => {
          if (s.code && s.value !== undefined) {
            statusMap[s.code] = s.value;
          }
        });
      }
      const rawType = d.device_type || d.deviceType || d.type || "unknown";
      const type = inferDeviceType(rawType, statusMap);
      const name = inferDeviceName(d, statusMap, type);

      return {
        id: d.id || d.deviceId || d.uid || String(d.uuid || d.name),
        name,
        type,
        time_zone: d.time_zone || null,
        online: !!d.online,
        battery: statusMap.battery_percentage ?? null,
        temperature: (statusMap.temp_current ?? statusMap.temp_set) / 10 || null,
        humidity: (statusMap.humidity_value ?? 0) / 10 || null,
        mode: statusMap.mode || null,
        fault: statusMap.fault || 0,
        status: statusMap,
        raw: d
      };
    });
  }

  /**
     Gerätestatus abrufen
   
   * @param deviceId
   */
  async getDeviceStatus(deviceId) {
    try {
      const data = await this._request("GET", `/devices/${encodeURIComponent(deviceId)}/status`);
      if (Array.isArray(data?.result)) {
        return data.result;
      }
      return data;
    } catch {
      try {
        const data = await this._request("GET", `/devices/${encodeURIComponent(deviceId)}`);
        return data;
      } catch {
        const list = await this.getDevices();
        const found = list.find(d => d.id === deviceId);
        return found?.status || {};
      }
    }
  }

  /**
     Befehle senden (batchfähig)
   
   * @param deviceId
   * @param payload
   */
  async sendCommand(deviceId, payload) {
    // payload: { commands: [{ code, value }, ...] }
    return await this._request("POST", `/devices/${encodeURIComponent(deviceId)}/commands`, {
      data: payload
    });
  }
}

module.exports = DanfossAPI;
