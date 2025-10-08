'use strict';
const axios = require('axios');

class DanfossAPI {
  constructor(opts, log) {
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.tokenUrl = opts.tokenUrl;
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, ''); // no trailing slash
    this.scope = opts.scope || '';
    this.log = log;

    this._token = null;
    this._tokenExpiry = 0;
    this._client = axios.create({ timeout: 15000 });
  }

  async ensureToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this._token && now < (this._tokenExpiry - 60)) {
      return this._token;
    }
    if (!this.tokenUrl) {
      throw new Error('tokenUrl not configured. Please set in adapter settings.');
    }

    this.log.info('🔑 Refreshing OAuth2 token...');
    try {
      const params = new URLSearchParams();
      params.append('grant_type', 'client_credentials');
      if (this.scope) params.append('scope', this.scope);

      const res = await this._client.post(this.tokenUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        auth: { username: this.apiKey, password: this.apiSecret }
      });

      const data = res.data;
      this._token = data.access_token;
      const expiresIn = Number(data.expires_in || 1800);
      this._tokenExpiry = Math.floor(Date.now() / 1000) + expiresIn;
      this.log.info(`✅ Token acquired. Expires in ~${expiresIn}s`);
      return this._token;
    } catch (err) {
      const msg = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
      throw new Error('Token request failed: ' + msg);
    }
  }

  async _request(method, path, options = {}) {
    const token = await this.ensureToken();
    const url = `${this.apiBaseUrl}${path}`;
    try {
      const res = await this._client.request({
        method,
        url,
        headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
        ...options
      });
      return res.data;
    } catch (err) {
      if (err.response && err.response.status === 401) {
        this._token = null;
        await this.ensureToken();
        const res2 = await this._client.request({
          method,
          url,
          headers: { Authorization: `Bearer ${this._token}`, ...(options.headers || {}) },
          ...options
        });
        return res2.data;
      }
      throw err;
    }
  }

  // Geräteliste abrufen
  async getDevices() {
    const data = await this._request('GET', '/devices');

    // Danfoss API liefert Geräte
    const arr = Array.isArray(data?.result)
      ? data.result
      : Array.isArray(data?.devices)
      ? data.devices
      : Array.isArray(data)
      ? data
      : [];

    if (!arr.length) {
      this.log.warn('⚠️ No devices returned by Danfoss API.');
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
      return {
        id: d.id || d.deviceId || d.uid || String(d.uuid || d.name),
        name: d.name?.trim() || d.displayName || 'Device',
        type: d.device_type || d.deviceType || d.type || 'unknown',
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

  // Gerätestatus abrufen
  async getDeviceStatus(deviceId) {
    try {
      const data = await this._request('GET', `/devices/${encodeURIComponent(deviceId)}/status`);
      if (Array.isArray(data?.result)) return data.result;
      return data;
    } catch (e) {
      try {
        const data = await this._request('GET', `/devices/${encodeURIComponent(deviceId)}`);
        return data;
      } catch (e2) {
        const list = await this.getDevices();
        const found = list.find(d => d.id === deviceId);
        return found?.status || {};
      }
    }
  }

  // Befehl senden (z. B. Temperatur setzen)
  async sendCommand(deviceId, payload) {
    return await this._request('POST', `/devices/${encodeURIComponent(deviceId)}/commands`, {
      headers: { 'Content-Type': 'application/json' },
      data: payload
    });
  }
}

module.exports = DanfossAPI;
