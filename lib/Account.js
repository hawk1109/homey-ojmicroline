'use strict';

const { OJClient } = require('./OJClient');

const ENERGY_INTERVAL_MS = 15 * 60 * 1000;
const MIN_POLL_S = 30;

/**
 * One OJ cloud login shared by all thermostats of that account.
 * Does a single GroupContents poll per interval and fans results out to devices.
 */
class Account {
  constructor(homey, creds) {
    this.homey = homey;
    this.key = Account.keyOf(creds);
    this.client = new OJClient({ ...creds, log: (...a) => homey.log(`[${creds.username}]`, ...a) });
    this.devices = new Set();
    this.timer = null;
    this.polling = null;
    this.lastEnergyAt = new Map();
  }

  static keyOf({ app = 'ojmicroline', username }) {
    return `${app}|${String(username).toLowerCase()}`;
  }

  register(device) {
    this.devices.add(device);
    this.reschedule();
    this.poll().catch(() => {});
  }

  unregister(device) {
    this.devices.delete(device);
    if (!this.devices.size) this.stop();
    else this.reschedule();
  }

  intervalMs() {
    let s = 60;
    for (const d of this.devices) s = Math.min(s, Number(d.getSetting('poll_interval')) || 60);
    return Math.max(MIN_POLL_S, s) * 1000;
  }

  reschedule() {
    if (this.timer) this.homey.clearInterval(this.timer);
    this.timer = this.homey.setInterval(() => this.poll().catch(() => {}), this.intervalMs());
  }

  stop() {
    if (this.timer) this.homey.clearInterval(this.timer);
    this.timer = null;
  }

  /** Coalesces concurrent poll requests into one API round-trip. */
  poll() {
    if (!this.polling) {
      this.polling = this._poll().finally(() => { this.polling = null; });
    }
    return this.polling;
  }

  async _poll() {
    let thermostats;
    try {
      ({ thermostats } = await this.client.getGroups());
    } catch (err) {
      this.homey.error(`Poll failed for ${this.key}:`, err.message);
      for (const d of this.devices) d.onPollError(err);
      throw err;
    }

    const bySerial = new Map(thermostats.map((t) => [String(t.SerialNumber), t]));
    for (const d of this.devices) {
      const t = bySerial.get(String(d.getData().serial));
      if (!t) {
        d.onPollError(new Error('Thermostat no longer present in OJ account'));
        continue;
      }
      await d.onThermostatData(t);
      await this._maybeEnergy(d, t);
    }
  }

  async _maybeEnergy(device, t) {
    const serial = String(t.SerialNumber);
    const last = this.lastEnergyAt.get(serial) || 0;
    if (Date.now() - last < ENERGY_INTERVAL_MS) return;
    try {
      const usage = await this.client.getEnergyUsage(serial);
      this.lastEnergyAt.set(serial, Date.now());
      await device.onEnergyData(usage);
    } catch (err) {
      this.homey.error(`Energy fetch failed for ${serial}:`, err.message);
    }
  }
}

module.exports = Account;
