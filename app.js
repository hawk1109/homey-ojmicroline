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
}

module.exports = OJMicrolineApp;
