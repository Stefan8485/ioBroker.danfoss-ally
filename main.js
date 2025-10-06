'use strict';
const utils = require('@iobroker/adapter-core');
const DanfossAPI = require('./lib/danfossApi');

class DanfossAlly extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: 'danfoss-ally',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    this.log.info('🔄 Starting Danfoss Ally adapter...');

    const { apiKey, apiSecret, tokenUrl, apiBaseUrl, scope, pollingInterval } = this.config;

    if (!apiKey || !apiSecret || !tokenUrl || !apiBaseUrl) {
      this.log.warn('⚠️ Missing configuration (API key, secret or URL).');
      return;
    }

    // API initialisieren
    this.api = new DanfossAPI(
      { apiKey, apiSecret, tokenUrl, apiBaseUrl, scope },
      this.log
    );

    try {
      // Token & erster Datenabruf
      await this.api.ensureToken();
      await this.updateDevices();

      // Polling-Intervall starten
      const interval = (pollingInterval || 60) * 1000;
      this.pollInterval = this.setInterval(() => this.updateDevices(), interval);
      this.log.info(`⏱ Polling interval set to ${pollingInterval}s`);
    } catch (err) {
      this.log.error(`❌ Adapter startup failed: ${err.message}`);
    }
  }

  /**
   * Geräte abrufen und States aktualisieren
   */
  async updateDevices() {
    try {
      const devices = await this.api.getDevices();
      if (!devices || !devices.length) {
        this.log.warn('⚠️ No devices found from Danfoss API.');
        return;
      }

      this.log.info(`📡 Found ${devices.length} devices, updating states...`);

      for (const dev of devices) {
        const devId = dev.id;
        const devPath = `devices.${devId}`;

        await this.setObjectNotExistsAsync(devPath, {
          type: 'channel',
          common: { name: dev.name },
          native: dev.raw,
        });

        // Alle Statuswerte anlegen
        const status = dev.status || {};
        for (const [code, value] of Object.entries(status)) {
          const type = typeof value === 'number' ? 'number' :
                       typeof value === 'boolean' ? 'boolean' : 'string';

          await this.setObjectNotExistsAsync(`${devPath}.${code}`, {
            type: 'state',
            common: {
              name: code,
              type,
              role: this.mapRole(code),
              unit: this.mapUnit(code),
              read: true,
              write: false,
            },
            native: {},
          });

          await this.setStateAsync(`${devPath}.${code}`, { val: value, ack: true });
        }

        // Wichtige Standardwerte (Temperatur, Feuchte, Batterie, Mode)
        if (dev.temperature !== null)
          await this.setStateAsync(`${devPath}.temperature`, { val: dev.temperature, ack: true });
        if (dev.humidity !== null)
          await this.setStateAsync(`${devPath}.humidity`, { val: dev.humidity, ack: true });
        if (dev.battery !== null)
          await this.setStateAsync(`${devPath}.battery`, { val: dev.battery, ack: true });
        if (dev.mode)
          await this.setStateAsync(`${devPath}.mode`, { val: dev.mode, ack: true });
      }

      this.log.info(`✅ Updated ${devices.length} devices from Danfoss Ally Cloud.`);
    } catch (err) {
      this.log.error(`❌ Error updating devices: ${err.message}`);
    }
  }

  /**
   * Mappt API-Code → ioBroker-Rolle
   */
  mapRole(code) {
    const map = {
      temp_current: 'value.temperature',
      temp_set: 'level.temperature',
      humidity_value: 'value.humidity',
      battery_percentage: 'value.battery',
      switch: 'switch',
      mode: 'text',
      work_state: 'indicator.working',
      fault: 'indicator.error',
      output_status: 'indicator',
    };
    return map[code] || 'state';
  }

  /**
   * Mappt API-Code → Einheit
   */
  mapUnit(code) {
    const units = {
      temp_current: '°C',
      temp_set: '°C',
      humidity_value: '%',
      battery_percentage: '%',
    };
    return units[code] || '';
  }

  onUnload(callback) {
    try {
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.log.info('🛑 Adapter stopped');
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
