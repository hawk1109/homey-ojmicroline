'use strict';

/**
 * Client for the OJ Microline WD5-series cloud API (OWD5 / MWD5 WiFi thermostats).
 *
 * Protocol reverse-engineered by the python-ojmicroline-thermostat project
 * (https://github.com/robbinjanssen/python-ojmicroline-thermostat, MIT).
 *
 * All temperatures on the wire are in 1/100 °C. Date-times are thermostat-local,
 * formatted "YYYY-MM-DDTHH:mm:ss" without offset.
 */

const DEFAULT_API_KEY = 'f219aab4-9ac0-4343-8422-b72203e2fac9';
const DEFAULT_HOST = 'ocd5.azurewebsites.net';
const CLIENT_SW_VERSION = 1060;
const REQUEST_TIMEOUT_MS = 30000;
const SESSION_MAX_CALLS = 300;

/** Known white-label apps sharing the WD5 backend. */
const APP_PROFILES = {
  ojmicroline: { host: DEFAULT_HOST, customerId: 1 },
  swatt: { host: DEFAULT_HOST, customerId: 99 },
  schluter: { host: 'owd5-sl003-app.ojelectronics.com', customerId: 3 },
  microtemp: { host: 'owd5-mh015-app.ojelectronics.com', customerId: 111 },
};

const MODE = Object.freeze({
  SCHEDULE: 1,
  COMFORT: 2,
  MANUAL: 3,
  VACATION: 4,
  FROST_PROTECTION: 6,
  BOOST: 8,
  ECO: 9,
});

const MODE_IDS = Object.freeze({
  1: 'schedule',
  2: 'comfort',
  3: 'manual',
  4: 'vacation',
  6: 'frost_protection',
  8: 'boost',
  9: 'eco',
});

const SENSOR = Object.freeze({ ROOM_FLOOR: 1, FLOOR: 3, ROOM: 4 });

class OJError extends Error {
  constructor(message, { auth = false, cause } = {}) {
    super(message);
    this.name = 'OJError';
    this.auth = auth;
    if (cause) this.cause = cause;
  }
}

class OJClient {
  /**
   * @param {object} opts
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {string} [opts.app] key of APP_PROFILES
   * @param {string} [opts.host]
   * @param {number} [opts.customerId]
   * @param {string} [opts.apiKey]
   * @param {(msg: string, ...args: any[]) => void} [opts.log]
   */
  constructor({ username, password, app = 'ojmicroline', host, customerId, apiKey, log }) {
    const profile = APP_PROFILES[app] || APP_PROFILES.ojmicroline;
    this.username = username;
    this.password = password;
    this.host = host || profile.host;
    this.customerId = Number(customerId ?? profile.customerId);
    this.apiKey = apiKey || DEFAULT_API_KEY;
    this.log = log || (() => {});
    this._sessionId = null;
    this._callsLeft = 0;
    this._loginPromise = null;
  }

  // ---------------------------------------------------------------- transport

  async _request(path, { method = 'GET', params = {}, body } = {}) {
    const url = new URL(`https://${this.host}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new OJError(`Cannot reach OJ Microline cloud (${err.name}: ${err.message})`, { cause: err });
    }

    if (res.status === 401) throw new OJError('Session rejected (HTTP 401)', { auth: true });
    if (!res.ok) throw new OJError(`OJ Microline cloud responded HTTP ${res.status}`);

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new OJError(`Unexpected non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  async login(force = false) {
    if (!force && this._sessionId && this._callsLeft > 0) return;
    if (this._loginPromise) return this._loginPromise;

    this._loginPromise = (async () => {
      const data = await this._request('api/UserProfile/SignIn', {
        method: 'POST',
        body: {
          APIKEY: this.apiKey,
          UserName: this.username,
          Password: this.password,
          ClientSWVersion: CLIENT_SW_VERSION,
          CustomerId: this.customerId,
        },
      });
      if (data.ErrorCode !== 0 || !data.SessionId) {
        throw new OJError('Login failed: wrong username, password or app selection', { auth: true });
      }
      this._sessionId = data.SessionId;
      this._callsLeft = SESSION_MAX_CALLS;
    })();

    try {
      await this._loginPromise;
    } finally {
      this._loginPromise = null;
    }
  }

  /** Run an authenticated call, re-logging in once if the session went stale. */
  async _authed(fn) {
    await this.login();
    this._callsLeft -= 1;
    try {
      return await fn(this._sessionId);
    } catch (err) {
      if (!(err instanceof OJError) || !err.auth) throw err;
      this.log('Session expired, logging in again');
      await this.login(true);
      return fn(this._sessionId);
    }
  }

  _assertOk(data, what) {
    if (data && data.ErrorCode === 0) return data;
    // ErrorCode 1 is what the API returns for an invalid/expired session too.
    throw new OJError(`${what} failed (ErrorCode ${data && data.ErrorCode})`, { auth: data && data.ErrorCode === 1 });
  }

  // ---------------------------------------------------------------- API calls

  /** @returns {Promise<{groups: object[], thermostats: object[]}>} raw API objects */
  async getGroups() {
    const data = await this._authed(async (sessionid) => this._assertOk(
      await this._request('api/Group/GroupContents', { params: { sessionid, APIKEY: this.apiKey } }),
      'Fetching thermostats',
    ));
    const groups = data.GroupContents || [];
    const thermostats = [];
    for (const g of groups) {
      for (const t of g.Thermostats || []) {
        if (t && Object.keys(t).length) thermostats.push(t);
      }
    }
    return { groups, thermostats };
  }

  /** Daily kWh, most recent day first (index 0 = today). */
  async getEnergyUsage(serialNumber) {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const data = await this._authed(async (sessionid) => this._assertOk(
      await this._request('api/EnergyUsage/GetEnergyUsage', {
        method: 'POST',
        params: { sessionid },
        body: {
          APIKEY: this.apiKey,
          ThermostatID: serialNumber,
          ViewType: 2,
          DateTime: tomorrow,
          History: 0,
        },
      }),
      'Fetching energy usage',
    ));
    const usage = (data.EnergyUsage && data.EnergyUsage[0] && data.EnergyUsage[0].Usage) || [];
    return usage.map((u) => Number(u.EnergyKWattHour) || 0);
  }

  /**
   * Change regulation mode for the zone (group) the thermostat belongs to.
   * @param {object} t raw thermostat object from getGroups()
   * @param {number} mode MODE.*
   * @param {object} [opts]
   * @param {number} [opts.temperature] °C, for COMFORT / MANUAL
   * @param {number} [opts.durationMinutes] for COMFORT (default 240)
   */
  async setRegulationMode(t, mode, { temperature, durationMinutes = 240 } = {}) {
    const centi = temperature == null ? null : Math.round(temperature * 100);
    const now = Date.now();

    const body = {
      APIKEY: this.apiKey,
      SetGroup: {
        ExcludeVacationData: false,
        GroupId: t.GroupId,
        GroupName: t.GroupName,
        BoostEndTime: mode === MODE.BOOST ? formatLocal(now + 3600e3, t) : t.BoostEndTime,
        ComfortEndTime: mode === MODE.COMFORT ? formatLocal(now + durationMinutes * 60e3, t) : t.ComfortEndTime,
        ComfortSetpoint: mode === MODE.COMFORT && centi != null ? centi : t.ComfortSetpoint,
        LastPrimaryModeIsAuto: t.RegulationMode === MODE.SCHEDULE,
        ManualModeSetpoint: mode === MODE.MANUAL && centi != null ? centi : t.ManualModeSetpoint,
        RegulationMode: mode,
        Schedule: t.Schedule,
        VacationEnabled: t.VacationEnabled,
        VacationBeginDay: t.VacationBeginDay,
        VacationEndDay: t.VacationEndDay,
        VacationTemperature: t.VacationTemperature,
      },
    };

    await this._authed(async (sessionid) => this._assertOk(
      await this._request('api/Group/UpdateGroup', { method: 'POST', params: { sessionid }, body }),
      'Updating regulation mode',
    ));
  }
}

// ------------------------------------------------------------------ helpers

/** Offset of the thermostat's local clock from UTC, in ms. */
function localOffsetMs(t) {
  return ((Number(t.TimeZone) || 0) + (t.DaylightSavingActive ? 3600 : 0)) * 1000;
}

function formatLocal(epochMs, t) {
  return new Date(epochMs + localOffsetMs(t)).toISOString().slice(0, 19);
}

/** Active schedule setpoint (1/100 °C) at the thermostat's local time. */
function scheduleSetpoint(t, nowMs = Date.now()) {
  const days = t.Schedule && t.Schedule.Days;
  if (!Array.isArray(days) || !days.length) return null;

  const local = new Date(nowMs + localOffsetMs(t));
  const weekday = local.getUTCDay(); // JS: 0 = Sunday … 6 = Saturday
  const seconds = local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds();

  // WeekDayGrpNo: 1 = Monday … 7 = Sunday (some firmware uses 0 for Sunday).
  const eventsFor = (wd) => {
    const day = days.find((d) => d.WeekDayGrpNo === wd || (wd === 0 && d.WeekDayGrpNo === 7));
    return ((day && day.Events) || [])
      .filter((e) => e.Active)
      .map((e) => {
        const [h, m, s] = String(e.Clock).split(':').map(Number);
        return { at: h * 3600 + m * 60 + (s || 0), temp: e.Temperature };
      })
      .sort((a, b) => a.at - b.at);
  };

  const today = eventsFor(weekday).filter((e) => e.at <= seconds);
  if (today.length) return today[today.length - 1].temp;

  // Before today's first event: walk back to the last event of a previous day.
  for (let back = 1; back <= 7; back++) {
    const ev = eventsFor((weekday - back + 7) % 7);
    if (ev.length) return ev[ev.length - 1].temp;
  }
  return null;
}

function lowestScheduleSetpoint(t) {
  const days = (t.Schedule && t.Schedule.Days) || [];
  let min = null;
  for (const d of days) {
    for (const e of d.Events || []) {
      if (e.Active && (min === null || e.Temperature < min)) min = e.Temperature;
    }
  }
  return min;
}

/** Effective target setpoint in °C, derived from mode (the API does not report it directly). */
function targetTemperature(t) {
  let c;
  switch (t.RegulationMode) {
    case MODE.SCHEDULE: c = scheduleSetpoint(t); break;
    case MODE.COMFORT: c = t.ComfortSetpoint; break;
    case MODE.MANUAL: c = t.ManualModeSetpoint; break;
    case MODE.VACATION: c = t.VacationTemperature; break;
    case MODE.FROST_PROTECTION: c = t.FrostProtectionTemperature; break;
    case MODE.BOOST: c = t.MaxSetpoint; break;
    case MODE.ECO: c = lowestScheduleSetpoint(t); break;
    default: c = null;
  }
  return c == null ? null : c / 100;
}

/** Regulated temperature in °C according to the sensor application. */
function currentTemperature(t) {
  const floor = t.FloorTemperature;
  const room = t.RoomTemperature;
  switch (t.SensorAppl) {
    case SENSOR.ROOM: return room / 100;
    case SENSOR.FLOOR: return floor / 100;
    // Room regulation with floor min/max limits: the regulated value is the room temperature.
    case SENSOR.ROOM_FLOOR: return room / 100;
    default: return (room ?? floor) / 100;
  }
}

module.exports = {
  OJClient,
  OJError,
  MODE,
  MODE_IDS,
  SENSOR,
  APP_PROFILES,
  targetTemperature,
  currentTemperature,
  scheduleSetpoint,
};
