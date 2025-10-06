'use strict';
const axios = require('axios');

class DanfossAPI {
  constructor(opts, log) {
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.tokenUrl = opts.tokenUrl;       // must be set by user
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/,''); // no trailing slash
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
    this.log.info('Refreshing OAuth2 token...');
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
      this.log.info('Token acquired. Expires in ~' + expiresIn + 's');
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
        headers: { Authorization: `Bearer ${token}` , ...(options.headers||{})},
        ...options
      });
      return res.data;
    } catch (err) {
      // Try once to refresh on unauthorized
      if (err.response && err.response.status === 401) {
        this._token = null;
        await this.ensureToken();
        const res2 = await this._client.request({
          method,
          url,
          headers: { Authorization: `Bearer ${this._token}` , ...(options.headers||{})},
          ...options
        });
        return res2.data;
      }
      throw err;
    }
  }

  // Device discovery
  async getDevices() {
    // Common pattern from third-party docs: GET /devices
    const data = await this._request('GET', '/devices');
    // Normalize to array of {id,name,type}
    const devices = Array.isArray(data?.devices) ? data.devices : (Array.isArray(data) ? data : []);
    return devices.map(d => ({
      id: d.id || d.deviceId || d.unique_id || d.uid || String(d.uuid || d.name),
      name: d.name || d.displayName || d.roomName || d.deviceName || 'Device',
      type: d.type || d.deviceType || 'unknown',
      raw: d
    })).filter(d => d.id);
  }

  // Device status (temperature/humidity etc.). If API doesn’t have a separate status endpoint,
  // this can be mapped to the device object fields directly.
  async getDeviceStatus(deviceId) {
    // Try a dedicated status endpoint first
    try {
      const data = await this._request('GET', `/devices/${encodeURIComponent(deviceId)}/status`);
      return data;
    } catch (e) {
      // Fallback: GET /devices/{id}
      try {
        const data = await this._request('GET', `/devices/${encodeURIComponent(deviceId)}`);
        return data;
      } catch (e2) {
        // Last resort: re-fetch all and pick
        const list = await this.getDevices();
        const found = list.find(d => d.id == deviceId);
        return found?.raw || {};
      }
    }
  }

  // Optional: send command, e.g. set temperature
  async sendCommand(deviceId, payload) {
    // Known pattern from community docs: POST /devices/{id}/commands
    return await this._request('POST', `/devices/${encodeURIComponent(deviceId)}/commands`, {
      headers: { 'Content-Type': 'application/json' },
      data: payload
    });
  }
}

module.exports = DanfossAPI;