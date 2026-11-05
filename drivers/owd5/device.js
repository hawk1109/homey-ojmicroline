'use strict';

const Homey = require('homey');
const {
  MODE, MODE_IDS, targetTemperature, currentTemperature,
} = require('../../lib/OJClient');

const MODE_BY_ID = Object.fromEntries(Object.entries(MODE_IDS).map(([k, v]) => [v, Number(k)]));
const REFRESH_AFTER_SET_MS = 4000;
const HEAT_LOG_WINDOW_MS = 24 * 3600 * 1000;

class OWD5Device extends Homey.Device {
  async onInit() {
    await this._migrateCapabilities();
    this.raw = null;

    this.registerCapabilityListener('target_temperature', (v) => this._onTargetTemperature(v));
    this.registerCapabilityListener('oj_regulation_mode', (v) => this.setMode(v));

    this._attach();
  }

  async _migrateCapabilities() {
    const wanted = [
      'target_temperature', 'measure_temperature', 'measure_temperature.floor',
      'measure_temperature.room', 'oj_regulation_mode', 'oj_heating',
      'measure_power', 'meter_power', 'oj_energy_today',
    ];
    for (const c of wanted) {
      if (!this.hasCapability(c)) await this.addCapability(c).catch(this.error);
    }
  }

  _attach() {
    const creds = this.getStore();
    if (!creds.username) {
      this.setUnavailable(this.homey.__('device.no_credentials')).catch(this.error);
      return;
    }
    this.account = this.homey.app.getAccount(creds);
    this.account.register(this);
  }

  async updateCredentials(creds) {
    for (const [k, v] of Object.entries(creds)) await this.setStoreValue(k, v);
    if (this.account) this.homey.app.releaseAccount(this.account, this);
    this._attach();
  }

  onDeleted() {
    if (this.account) this.homey.app.releaseAccount(this.account, this);
  }

  onUninit() {
    if (this.account) this.homey.app.releaseAccount(this.account, this);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval') && this.account) {
      this.homey.setTimeout(() => this.account.reschedule(), 0);
    }
    if (changedKeys.includes('load_watts') && this.raw) {
      this.homey.setTimeout(() => this._updatePower(this.raw.Heating), 0);
    }
  }

  // ----------------------------------------------------------- data from poll

  async onThermostatData(t) {
    const prev = this.raw;
    this.raw = t;

    if (!t.Online) {
      await this.setUnavailable(this.homey.__('device.offline')).catch(this.error);
    } else if (!this.getAvailable()) {
      await this.setAvailable().catch(this.error);
    }

    if (!prev || prev.MinSetpoint !== t.MinSetpoint || prev.MaxSetpoint !== t.MaxSetpoint) {
      await this.setCapabilityOptions('target_temperature', {
        min: t.MinSetpoint / 100, max: t.MaxSetpoint / 100, step: 0.5,
      }).catch(this.error);
    }

    const target = targetTemperature(t);
    const modeId = MODE_IDS[t.RegulationMode] || 'schedule';
    const heating = !!t.Heating;

    await Promise.all([
      this._set('measure_temperature', currentTemperature(t)),
      this._set('measure_temperature.floor', t.FloorTemperature / 100),
      this._set('measure_temperature.room', t.RoomTemperature / 100),
      target != null ? this._set('target_temperature', target) : null,
      this._set('oj_regulation_mode', modeId),
      this._set('oj_heating', heating),
      this._updatePower(heating),
    ]);

    const settings = {};
    if (this.getSetting('zone') !== t.GroupName) settings.zone = t.GroupName || '';
    if (this.getSetting('firmware') !== t.SWversion) settings.firmware = t.SWversion || '';
    const sensorKey = { 1: 'room_floor', 3: 'floor', 4: 'room' }[t.SensorAppl] || 'unknown';
    const diag = {
      sensor_mode: this.homey.__(`sensor.${sensorKey}`),
      adaptive: this.homey.__(t.AdaptiveMode ? 'onoff.on' : 'onoff.off'),
      open_window: this.homey.__(t.OpenWindow ? 'onoff.on' : 'onoff.off'),
    };
    for (const [k, v] of Object.entries(diag)) if (this.getSetting(k) !== v) settings[k] = v;
    if (Object.keys(settings).length) await this.setSettings(settings).catch(this.error);

    if (prev) this._fireTriggers(prev, t, modeId);
    await this._logHeating(heating);
    this.homey.app.notifyWidgets();
  }

  /**
   * Keeps a compact on/off transition log covering the last 24h (+ the state
   * at the window start) for the dashboard widget's timeline.
   */
  async _logHeating(heating) {
    const log = this.getStoreValue('heat_log') || [];
    const now = Date.now();
    const last = log[log.length - 1];
    if (last && last[1] === (heating ? 1 : 0)) return;

    log.push([now, heating ? 1 : 0]);
    const cutoff = now - HEAT_LOG_WINDOW_MS;
    // Drop entries older than the window, but keep the last one before it so the state at the window start is known.
    while (log.length > 1 && log[1][0] <= cutoff) log.shift();
    await this.setStoreValue('heat_log', log).catch(this.error);
  }

  /** Data for the dashboard widget. */
  getWidgetSnapshot() {
    const t = this.raw;
    return {
      id: this.getId(),
      name: this.getName(),
      zone: this.getSetting('zone') || '',
      available: this.getAvailable(),
      heating: this.getCapabilityValue('oj_heating') === true,
      mode: this.getCapabilityValue('oj_regulation_mode'),
      modeLabel: this.homey.__(`mode.${this.getCapabilityValue('oj_regulation_mode') || 'schedule'}`),
      temperature: this.getCapabilityValue('measure_temperature'),
      floor: this.getCapabilityValue('measure_temperature.floor'),
      room: this.getCapabilityValue('measure_temperature.room'),
      target: this.getCapabilityValue('target_temperature'),
      power: this.getCapabilityValue('measure_power'),
      loadWatts: Number(this.getSetting('load_watts')) || 0,
      todayKWh: this.getCapabilityValue('oj_energy_today'),
      weekKWh: this.getStoreValue('energy_week') || [],
      heatLog: this.getStoreValue('heat_log') || [],
      online: t ? !!t.Online : null,
    };
  }

  _fireTriggers(prev, t, modeId) {
    const drv = this.driver;
    if (!prev.Heating && t.Heating) drv.heatingStarted.trigger(this, {}, {}).catch(this.error);
    if (prev.Heating && !t.Heating) drv.heatingStopped.trigger(this, {}, {}).catch(this.error);
    if (prev.RegulationMode !== t.RegulationMode) {
      const prevId = MODE_IDS[prev.RegulationMode] || 'schedule';
      drv.modeChanged.trigger(this, {
        mode: this.homey.__(`mode.${modeId}`),
        previous_mode: this.homey.__(`mode.${prevId}`),
      }, {}).catch(this.error);
    }
  }

  async _updatePower(heating) {
    const load = Number(this.getSetting('load_watts')) || 0;
    await this._set('measure_power', load > 0 ? (heating ? load : 0) : null);
  }

  /**
   * usage[0] = today, usage[1] = yesterday … (kWh per day).
   * meter_power is kept cumulative: when the day rolls over, yesterday's final
   * value is added to a persisted base.
   */
  async onEnergyData(usage) {
    if (!usage.length) return;
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: this.homey.clock.getTimezone() });
    let base = Number(this.getStoreValue('energy_base')) || 0;
    const day = this.getStoreValue('energy_day');

    if (day && day !== today && usage.length > 1) {
      base += usage[1];
      await this.setStoreValue('energy_base', base);
    }
    if (day !== today) await this.setStoreValue('energy_day', today);

    await this._set('oj_energy_today', Math.round(usage[0] * 1000) / 1000);
    await this._set('meter_power', Math.round((base + usage[0]) * 1000) / 1000);
    await this.setStoreValue('energy_week', usage.slice(0, 7).map((v) => Math.round(v * 1000) / 1000));
    this.homey.app.notifyWidgets();
  }

  onPollError(err) {
    if (err && err.auth) {
      this.setUnavailable(this.homey.__('device.auth_failed')).catch(this.error);
    } else {
      // Transient cloud hiccups: keep last values, just log.
      this.log('Poll error:', err && err.message);
    }
  }

  // ------------------------------------------------------------------ control

  async _onTargetTemperature(value) {
    const current = this.getCapabilityValue('oj_regulation_mode');
    const behaviour = this.getSetting('setpoint_behaviour') || 'comfort';
    if (current === 'manual' || behaviour === 'manual') {
      return this.setMode('manual', { temperature: value });
    }
    return this.setMode('comfort', {
      temperature: value,
      durationMinutes: Number(this.getSetting('comfort_minutes')) || 240,
    });
  }

  /**
   * @param {string} modeId schedule|comfort|manual|frost_protection|boost|eco
   * @param {{temperature?: number, durationMinutes?: number}} [opts]
   */
  async setMode(modeId, opts = {}) {
    if (!this.raw) await this.account.poll();
    if (!this.raw) throw new Error(this.homey.__('device.no_data'));

    const mode = MODE_BY_ID[modeId];
    if (mode == null) throw new Error(`Unknown mode ${modeId}`);
    if (mode === MODE.VACATION) throw new Error(this.homey.__('device.vacation_readonly'));

    const durationMinutes = opts.durationMinutes ?? (Number(this.getSetting('comfort_minutes')) || 240);
    await this.account.client.setRegulationMode(this.raw, mode, { ...opts, durationMinutes });

    // Optimistic UI update, then confirm from the cloud.
    await this._set('oj_regulation_mode', modeId);
    if (opts.temperature != null) await this._set('target_temperature', opts.temperature);
    this.homey.setTimeout(() => this.account.poll().catch(() => {}), REFRESH_AFTER_SET_MS);
  }

  async _set(cap, value) {
    if (!this.hasCapability(cap)) return;
    if (this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch(this.error);
  }
}

module.exports = OWD5Device;
