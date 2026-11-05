# OJ Microline for Homey

Homey (SDK v3) app for OJ Microline **OWD5 / MWD5** WiFi floor-heating thermostats, via the OJ WD5 cloud API.
Also covers white-label variants on the same backend: SWATT, Schlüter DITRA-HEAT-E-WiFi, Microtemp.

## Features

| Capability | Source |
|---|---|
| `target_temperature` | derived from regulation mode (the API does not report the active setpoint; schedule is evaluated in thermostat-local time) |
| `measure_temperature` | floor, room or average, per the thermostat's sensor application |
| `measure_temperature.floor` / `.room` | raw sensors |
| `oj_regulation_mode` | Schedule, Comfort, Manual, Boost, Eco, Frost protection (Vacation is read-only) |
| `oj_heating` | relay state |
| `measure_power` | `heating ? load_watts : 0` (set the element wattage in device settings) |
| `oj_energy_today` / `meter_power` | daily kWh from the cloud; `meter_power` is made cumulative by carrying yesterday's final value into a persisted base at day rollover |

Flow cards: heating on/off, mode changed · is heating, mode is · resume schedule, temporary temperature for N minutes, hold temperature, boost 1 h, set mode.

Setting a temperature from Homey defaults to **Comfort** (temporary override, then back to schedule); switch to **Manual** per device in settings.

## Architecture

```
app.js                    Account registry: one OJClient + poller per (app, username)
lib/OJClient.js           WD5 cloud API: SignIn → GroupContents / GetEnergyUsage / UpdateGroup
lib/Account.js            single GroupContents poll per interval, fans out to devices; energy every 15 min
drivers/owd5/driver.js    pairing (custom login view → list_devices), repair, flow card wiring
drivers/owd5/device.js    capability mapping, setpoint/mode control, triggers
```

- Session id is reused for up to 300 calls; HTTP 401 or `ErrorCode 1` triggers one re-login.
- Mode changes are applied to the thermostat's **group** (zone) — that is how the WD5 API works.
- Wire format: temperatures in 1/100 °C; date-times thermostat-local (`TimeZone` + DST), no offset.

Protocol credit: [python-ojmicroline-thermostat](https://github.com/robbinjanssen/python-ojmicroline-thermostat) (MIT).

## Develop

```bash
npm i -g homey
npm test                              # API client unit tests (node:test, no deps)
homey login && homey select           # pick your Homey (Pro or Self-Hosted Server)
homey app run                         # live-run with logs
homey app install                     # install permanently
homey app validate --level publish
homey app publish                     # then finish the submission at tools.developer.homey.app
```

## Known assumptions

- `GetEnergyUsage` with `ViewType 2` is treated as daily totals, index 0 = today (as in the Python library). Verify against the OJ app after the first day.
- Vacation mode needs begin/end dates; it is shown but cannot be set from Homey.

Not affiliated with or endorsed by OJ Electronics A/S.
