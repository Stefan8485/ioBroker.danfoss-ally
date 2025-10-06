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

    this.api = new DanfossAPI({ apiKey, apiSecret, tokenUrl, apiBaseUrl, scope });
    await this.api.init();

    await this.updateDevices();
    this.pollInterval = this.setInterval(() => this.updateDevices(), (pollingInterval || 60) * 1000);
  }

  async updateDevices() {
    try {
      const devices = await this.api.getDevices();
      if (!devices || !Object.keys(devices).length) {
        this.log.warn('No devices found from Danfoss API.');
        return;
      }

      for (const [id, dev] of Object.entries(devices)) {
        await this.setObjectNotExistsAsync(`devices.${id}`, {
          type: 'channel',
          common: { name: dev.name || id },
          native: dev,
        });

        const states = {
          temperature: dev.temperature,
          humidity: dev.humidity,
          valve: dev.valve,
          battery: dev.battery,
        };

        for (const [key, value] of Object.entries(states)) {
          if (value !== undefined) {
            await this.setObjectNotExistsAsync(`devices.${id}.${key}`, {
              type: 'state',
              common: { name: key, type: 'number', role: 'value', read: true, write: false },
              native: {},
            });
            await this.setStateAsync(`devices.${id}.${key}`, value, true);
          }
        }
      }

      this.log.info(`✅ Updated ${Object.keys(devices).length} devices from Danfoss Ally Cloud.`);
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
