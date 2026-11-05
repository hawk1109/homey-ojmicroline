'use strict';

const Homey = require('homey');
const Account = require('./lib/Account');

class OJMicrolineApp extends Homey.App {
  async onInit() {
    /** @type {Map<string, Account>} */
    this.accounts = new Map();
    this.log('OJ Microline app started');
  }

  /** Shared account per (app, username); credentials updated if they changed. */
  getAccount(creds) {
    const key = Account.keyOf(creds);
    let account = this.accounts.get(key);
    if (!account) {
      account = new Account(this.homey, creds);
      this.accounts.set(key, account);
    } else if (account.client.password !== creds.password) {
      account.client.password = creds.password;
      account.client._sessionId = null;
    }
    return account;
  }

  releaseAccount(account, device) {
    account.unregister(device);
    if (!account.devices.size) this.accounts.delete(account.key);
  }

  /** Debounced realtime push so a poll across N thermostats yields one widget refresh. */
  notifyWidgets() {
    if (this._notifyTimer) return;
    this._notifyTimer = this.homey.setTimeout(() => {
      this._notifyTimer = null;
      this.homey.api.realtime('oj:update', { at: Date.now() }).catch(() => {});
    }, 1500);
  }

  /**
   * Aggregated data for the energy dashboard widget.
   * @param {string[]} [ids] Homey device ids selected in the widget; empty = all thermostats
   */
  getWidgetData(ids = []) {
    const all = this.homey.drivers.getDriver('owd5').getDevices();
    let devices = all;
    if (ids.length) {
      const wanted = new Set(ids);
      const picked = all.filter((d) => wanted.has(d.getId()) || wanted.has(d.getAppId()));
      if (picked.length) devices = picked;
    }
    const thermostats = devices
      .map((d) => d.getWidgetSnapshot())
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      now: Date.now(),
      timezone: this.homey.clock.getTimezone(),
      language: this.homey.i18n.getLanguage(),
      thermostats,
    };
  }
}

module.exports = OJMicrolineApp;
