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
      this.log.warn('Missing configuration (API key, secret or URL).');
      return;
    }

    // Danfoss API initialisieren
    this.api = new DanfossAPI(
      { apiKey, apiSecret, tokenUrl, apiBaseUrl, scope },
      this.log
    );

    try {
      // Erstmalig Token prüfen
      await this.api.ensureToken();
      await this.updateDevices();

      // Polling starten
      const interval = (pollingInterval || 60) * 1000;
      this.pollInterval = this.setInterval(() => this.updateDevices(), interval);
      this.log.info(`⏱ Polling interval set to ${pollingInterval}s`);
    } catch (err) {
      this.log.error(`❌ Adapter startup failed: ${err.message}`);
    }
  }

  async updateDevices() {
    try {
      const devices = await this.api.getDevices();
      if (!devices.length) {
        this.log.warn('No devices found from Danfoss API.');
        return;
      }

      for (const dev of devices) {
        const devId = dev.id;
        await this.setObjectNotExistsAsync(`devices.${devId}`, {
          type: 'channel',
          common: { name: dev.name },
          native: dev.raw,
        });

        const status = await this.api.getDeviceStatus(devId);
        if (status) {
          for (const [key, value] of Object.entries(status)) {
            if (typeof value === 'object') continue;
            await this.setObjectNotExistsAsync(`devices.${devId}.${key}`, {
              type: 'state',
              common: { name: key, type: typeof value, role: 'value', read: true, write: false },
              native: {},
            });
            await this.setStateAsync(`devices.${devId}.${key}`, { val: value, ack: true });
          }
        }
      }

      this.log.info(`✅ Updated ${devices.length} devices from Danfoss Ally Cloud.`);
    } catch (err) {
      this.log.error(`❌ Error updating devices: ${err.message}`);
    }
  }

  onUnload(callback) {
    try {
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.log.info('Adapter stopped');
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
