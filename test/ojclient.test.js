'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  OJClient, MODE, targetTemperature, currentTemperature, scheduleSetpoint,
} = require('../lib/OJClient');

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));
const group = load('wd5_group.json');
const energy = load('energy.json');
const thermostat = () => structuredClone(group.GroupContents[0].Thermostats[0]);

// Fixture thermostat: TimeZone 3600, DST inactive -> local = UTC+1.
const utc = (iso) => Date.parse(`${iso}Z`);

test('schedule setpoint follows thermostat-local time', () => {
  const t = thermostat();
  // Monday 2026-11-02 07:00 local (06:00Z) -> 06:30 event = 2350
  assert.equal(scheduleSetpoint(t, utc('2026-11-02T06:00:00')), 2350);
  assert.equal(scheduleSetpoint(t, utc('2026-11-02T10:00:00')), 2350); // 11:00 local
  // Monday 12:00Z = 13:00 local -> 1800
  assert.equal(scheduleSetpoint(t, utc('2026-11-02T12:00:00')), 1800);
  // Monday 23:30 local -> 1500
  assert.equal(scheduleSetpoint(t, utc('2026-11-02T22:30:00')), 1500);
});

test('before first event falls back to previous day, including Sunday=7', () => {
  const t = thermostat();
  // Monday 05:00 local (04:00Z) -> Sunday's last event 22:00 = 1500
  assert.equal(scheduleSetpoint(t, utc('2026-11-02T04:00:00')), 1500);
  // Sunday 2026-11-08 07:00 local -> Sunday (grp 7) 06:30 = 2350
  assert.equal(scheduleSetpoint(t, utc('2026-11-08T06:00:00')), 2350);
});

test('DST shifts local time by an extra hour', () => {
  const t = thermostat();
  t.DaylightSavingActive = true; // UTC+2
  // Monday 11:00Z = 13:00 local -> 1800 (would be 2350 at UTC+1)
  assert.equal(scheduleSetpoint(t, utc('2026-11-02T11:00:00')), 1800);
});

test('target temperature per regulation mode', () => {
  const t = thermostat();
  t.RegulationMode = MODE.MANUAL; assert.equal(targetTemperature(t), 23.5);
  t.RegulationMode = MODE.COMFORT; assert.equal(targetTemperature(t), 20);
  t.RegulationMode = MODE.FROST_PROTECTION; assert.equal(targetTemperature(t), 5);
  t.RegulationMode = MODE.BOOST; assert.equal(targetTemperature(t), 40);
  t.RegulationMode = MODE.ECO; assert.equal(targetTemperature(t), 15);
  t.RegulationMode = MODE.VACATION; assert.equal(targetTemperature(t), 5);
});

test('current temperature honours sensor application', () => {
  const t = thermostat(); // room 1820, floor 1968
  t.SensorAppl = 3; assert.equal(currentTemperature(t), 19.68);
  t.SensorAppl = 4; assert.equal(currentTemperature(t), 18.2);
  t.SensorAppl = 1; assert.equal(currentTemperature(t), 18.2);
});

// ------------------------------------------------------------- HTTP flow

function mockFetch(handler) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), method: init.method, body });
    const { status = 200, json } = await handler(u.pathname, body, calls.length);
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, restore: () => { global.fetch = orig; } };
}

test('login, fetch thermostats and energy', async () => {
  const m = mockFetch((p) => {
    if (p.endsWith('/SignIn')) return { json: { ErrorCode: 0, SessionId: 'S1' } };
    if (p.endsWith('/GroupContents')) return { json: group };
    if (p.endsWith('/GetEnergyUsage')) return { json: energy };
    return { status: 404, json: {} };
  });
  try {
    const c = new OJClient({ username: 'u', password: 'p' });
    const { thermostats } = await c.getGroups();
    assert.equal(thermostats.length, 2, 'empty entries skipped');
    assert.equal(thermostats[0].SerialNumber, '800747');
    const usage = await c.getEnergyUsage('800747');
    assert.equal(usage[0], 3.8763);

    assert.equal(m.calls[0].body.CustomerId, 1);
    assert.equal(m.calls[0].body.APIKEY, 'f219aab4-9ac0-4343-8422-b72203e2fac9');
    assert.equal(m.calls[1].params.sessionid, 'S1');
    assert.equal(m.calls.filter((x) => x.path.endsWith('/SignIn')).length, 1, 'session reused');
  } finally { m.restore(); }
});

test('app profile selects host and customer id', async () => {
  const m = mockFetch(() => ({ json: { ErrorCode: 0, SessionId: 'S' } }));
  try {
    await new OJClient({ username: 'u', password: 'p', app: 'schluter' }).login();
    assert.equal(m.calls[0].body.CustomerId, 3);
  } finally { m.restore(); }
});

test('bad credentials raise an auth error', async () => {
  const m = mockFetch(() => ({ json: { ErrorCode: 1 } }));
  try {
    await assert.rejects(new OJClient({ username: 'u', password: 'x' }).login(), (e) => e.auth === true);
  } finally { m.restore(); }
});

test('expired session triggers one re-login', async () => {
  let n = 0;
  const m = mockFetch((p) => {
    if (p.endsWith('/SignIn')) { n += 1; return { json: { ErrorCode: 0, SessionId: `S${n}` } }; }
    if (p.endsWith('/GroupContents')) return n === 1 ? { status: 401, json: {} } : { json: group };
    return { status: 404, json: {} };
  });
  try {
    const { thermostats } = await new OJClient({ username: 'u', password: 'p' }).getGroups();
    assert.equal(thermostats.length, 2, 'empty entries skipped');
    assert.equal(n, 2);
    assert.equal(m.calls.at(-1).params.sessionid, 'S2');
  } finally { m.restore(); }
});

test('comfort update sends temperature, local end time and preserves vacation data', async () => {
  const m = mockFetch((p) => (p.endsWith('/SignIn')
    ? { json: { ErrorCode: 0, SessionId: 'S' } }
    : { json: { ErrorCode: 0 } }));
  try {
    const t = thermostat();
    const before = Date.now();
    await new OJClient({ username: 'u', password: 'p' }).setRegulationMode(t, MODE.COMFORT, { temperature: 22.5, durationMinutes: 60 });
    const sg = m.calls.at(-1).body.SetGroup;
    assert.equal(sg.RegulationMode, 2);
    assert.equal(sg.ComfortSetpoint, 2250);
    assert.equal(sg.ManualModeSetpoint, 2350);
    assert.equal(sg.GroupId, 50369);
    assert.equal(sg.VacationBeginDay, '2022-12-21T00:00:00');
    assert.match(sg.ComfortEndTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    // end = now + 60 min, expressed in UTC+1 local time
    const endUtc = Date.parse(`${sg.ComfortEndTime}Z`) - 3600e3;
    assert.ok(Math.abs(endUtc - (before + 3600e3)) < 5000);
  } finally { m.restore(); }
});

test('temporary modes keep the primary mode the thermostat returns to', async () => {
  const m = mockFetch((p) => (p.endsWith('/SignIn')
    ? { json: { ErrorCode: 0, SessionId: 'S' } }
    : { json: { ErrorCode: 0 } }));
  try {
    const c = new OJClient({ username: 'u', password: 'p' });
    const sent = async (t, mode) => { await c.setRegulationMode(t, mode, { temperature: 21 }); return m.calls.at(-1).body.SetGroup.LastPrimaryModeIsAuto; };

    // In Comfort that came from Schedule: changing comfort temp must keep "return to schedule"
    let t = thermostat(); t.RegulationMode = MODE.COMFORT; t.LastPrimaryModeIsAuto = true;
    assert.equal(await sent(t, MODE.COMFORT), true);
    // From Manual, Boost must return to Manual
    t = thermostat(); t.RegulationMode = MODE.MANUAL; t.LastPrimaryModeIsAuto = false;
    assert.equal(await sent(t, MODE.BOOST), false);
    // Explicit switches set it
    assert.equal(await sent(t, MODE.SCHEDULE), true);
    t.LastPrimaryModeIsAuto = true;
    assert.equal(await sent(t, MODE.MANUAL), false);
  } finally { m.restore(); }
});
