'use strict';

const Homey = require('homey');
const { OJClient } = require('../../lib/OJClient');

class OWD5Driver extends Homey.Driver {
  async onInit() {
    this._registerFlows();
  }

  _registerFlows() {
    const flows = this.homey.flow;

    this.heatingStarted = flows.getDeviceTriggerCard('heating_started');
    this.heatingStopped = flows.getDeviceTriggerCard('heating_stopped');
    this.modeChanged = flows.getDeviceTriggerCard('mode_changed');

    flows.getConditionCard('is_heating')
      .registerRunListener(({ device }) => device.getCapabilityValue('oj_heating') === true);
    flows.getConditionCard('mode_is')
      .registerRunListener(({ device, mode }) => device.getCapabilityValue('oj_regulation_mode') === mode);

    flows.getActionCard('set_mode')
      .registerRunListener(({ device, mode }) => device.setMode(mode));
    flows.getActionCard('resume_schedule')
      .registerRunListener(({ device }) => device.setMode('schedule'));
    flows.getActionCard('set_comfort')
      .registerRunListener(({ device, temperature, minutes }) => device.setMode('comfort', {
        temperature,
        durationMinutes: Math.round(minutes),
      }));
    flows.getActionCard('set_manual')
      .registerRunListener(({ device, temperature }) => device.setMode('manual', { temperature }));
    flows.getActionCard('boost')
      .registerRunListener(({ device }) => device.setMode('boost'));
    flows.getActionCard('setback_start')
      .registerRunListener(({ device, percent }) => device.startSetback(percent));
    flows.getActionCard('setback_end')
      .registerRunListener(({ device }) => device.endSetback());
    flows.getConditionCard('setback_active')
      .registerRunListener(({ device }) => device.getStoreValue('setback_from') != null);
  }

  _clientFrom(creds) {
    return new OJClient({ ...creds, log: (...a) => this.log(...a) });
  }

  async onPair(session) {
    let creds = null;
    let client = null;

    session.setHandler('login', async (data) => {
      creds = {
        username: String(data.username || '').trim(),
        password: String(data.password || ''),
        app: data.app || 'ojmicroline',
      };
      client = this._clientFrom(creds);
      await client.login(true); // throws a readable OJError on bad credentials
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!client) throw new Error(this.homey.__('pair.not_logged_in'));
      const { thermostats } = await client.getGroups();
      return thermostats.map((t) => ({
        name: t.ThermostatName || t.GroupName || `OWD5 ${t.SerialNumber}`,
        data: { id: `owd5-${t.SerialNumber}`, serial: String(t.SerialNumber) },
        store: { ...creds },
        settings: { zone: t.GroupName || '', serial: String(t.SerialNumber), firmware: t.SWversion || '' },
      }));
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async (data) => {
      const creds = {
        username: String(data.username || '').trim(),
        password: String(data.password || ''),
        app: data.app || 'ojmicroline',
      };
      await this._clientFrom(creds).login(true);
      await device.updateCredentials(creds);
      return true;
    });
  }
}

module.exports = OWD5Driver;
