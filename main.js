'use strict';
const utils = require('@iobroker/adapter-core');
const DanfossAPI = require('./lib/danfossApi');

class DanfossAlly extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: 'danfoss-ally' });
    this.api = null;
    this.polling = null;
    this.devices = [];
  }

  async onReady() {
    const { apiKey, apiSecret, tokenUrl, apiBaseUrl, scope, pollingInterval } = this.config;
    if (!apiKey || !apiSecret) {
      this.log.error('API Key/Secret missing. Please configure adapter.');
      return;
    }

    this.api = new DanfossAPI({ apiKey, apiSecret, tokenUrl, apiBaseUrl, scope }, this.log);

    try {
      // Ensure we can authenticate up-front
      await this.api.ensureToken();

      // Initial discovery
      await this.discoverDevices();

      // First update
      await this.updateAllDevices();

      // Start polling
      const intervalMs = Math.max(15, Number(pollingInterval || 60)) * 1000;
      this.polling = setInterval(() => this.updateAllDevices().catch(e => this.log.error(String(e))), intervalMs);
      this.log.info(`Polling started (every ${intervalMs/1000}s).`);
    } catch (err) {
      this.log.error('Initialization failed: ' + (err.message || err));
    }
  }

  async discoverDevices() {
    this.log.info('Discovering devices...');
    this.devices = await this.api.getDevices();
    this.log.info(`Found ${this.devices.length} devices.`);

    for (const dev of this.devices) {
      const base = `devices.${dev.id}`;
      await this.setObjectNotExistsAsync(base, { type: 'device', common: { name: dev.name }, native: dev.raw || {} });

      // Common states
      const defs = {
        temperature: { role: 'value.temperature', type: 'number', unit: '°C', read: true, write: false },
        humidity:    { role: 'value.humidity',   type: 'number', unit: '%',  read: true, write: false },
        valve:       { role: 'value',            type: 'number', unit: '%',  read: true, write: false },
        battery:     { role: 'value.battery',    type: 'number', unit: '%',  read: true, write: false },
        // raw json snapshot
        raw:         { role: 'json',             type: 'string',             read: true, write: false }
      };

      for (const [id, common] of Object.entries(defs)) {
        await this.setObjectNotExistsAsync(`${base}.${id}`, { type: 'state', common: { name: id, ...common }, native: {} });
      }
    }
  }

  // Extract typical fields from the API response
  _extractStatusFields(data) {
    // Try common keys used in Danfoss responses
    const temp = Number(
      data.temperature ?? data.current_temperature ?? data.temp ??
      (typeof data.measuredTemperature === 'number' ? data.measuredTemperature : undefined)
    );
    const hum  = Number(
      data.humidity ?? data.current_humidity ??
      (typeof data.measuredHumidity === 'number' ? data.measuredHumidity : undefined)
    );
    const valve = Number(
      data.valve ?? data.valve_position ?? data.openingPercent ?? data.opening_percentage
    );
    const batt = Number(
      data.battery ?? data.battery_percent ?? data.batteryLevel ?? data.battery_percentage
    );
    return { temperature: temp, humidity: hum, valve, battery: batt };
  }

  async updateAllDevices() {
    if (!this.devices || this.devices.length === 0) {
      await this.discoverDevices();
      if (!this.devices || this.devices.length === 0) return;
    }

    for (const dev of this.devices) {
      const base = `devices.${dev.id}`;
      try {
        const status = await this.api.getDeviceStatus(dev.id);
        const { temperature, humidity, valve, battery } = this._extractStatusFields(status);
        if (Number.isFinite(temperature)) this.setState(`${base}.temperature`, { val: temperature, ack: true });
        if (Number.isFinite(humidity))    this.setState(`${base}.humidity`,    { val: humidity,    ack: true });
        if (Number.isFinite(valve))       this.setState(`${base}.valve`,       { val: valve,       ack: true });
        if (Number.isFinite(battery))     this.setState(`${base}.battery`,     { val: battery,     ack: true });

        // Store a trimmed JSON snapshot for debugging
        const snapshot = JSON.stringify(status);
        this.setState(`${base}.raw`, { val: snapshot, ack: true });
      } catch (err) {
        this.log.warn(`Update failed for ${dev.id}: ${(err.response && err.response.status) ? (err.response.status + ' ' + (err.response.data && JSON.stringify(err.response.data))) : err.message}`);
      }
    }
  }

  onUnload(callback) {
    try {
      if (this.polling) clearInterval(this.polling);
      callback();
    } catch (e) {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new DanfossAlly(options);
} else {
  new DanfossAlly();
}