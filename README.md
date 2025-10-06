# ioBroker.danfoss-ally (v0.1.0)

**Cloud adapter for Danfoss Ally** using API Key + Secret (OAuth2 Client Credentials).
Reads temperature, humidity, valve position, and battery for all devices in your Ally account.

> ⚠️ You must configure the **Token URL** (OAuth2) and **API Base URL** in the instance settings.
> These values differ depending on Danfoss' environment/region and your developer app settings.

## Settings
- **API Key / API Secret** — your Danfoss developer app credentials
- **Token URL** — OAuth2 token endpoint (e.g. `https://api.danfoss.com/oauth2/token`)
- **API Base URL** — e.g. `https://api.danfoss.com/ally`
- **Scope** — optional OAuth2 scope string
- **Polling Interval** — seconds (default 60)

## States
For each discovered device, the adapter creates:
```
danfoss-ally.0.devices.<device_id>.temperature (°C)
danfoss-ally.0.devices.<device_id>.humidity    (%)
danfoss-ally.0.devices.<device_id>.valve       (%)
danfoss-ally.0.devices.<device_id>.battery     (%)
danfoss-ally.0.devices.<device_id>.raw         (JSON string snapshot)
```

## Notes
- The adapter implements **token refresh**. On HTTP 401 it retries once with a fresh token automatically.
- Endpoints used:
  - `GET /devices`
  - `GET /devices/{id}/status` (fallback to `GET /devices/{id}` if not available)
  - `POST /devices/{id}/commands` (not used in v0.1 for control)
- Depending on the exact API variant, the `status` keys may differ; the adapter tries to map common ones.

## Development
```
npm i
node main.js
```
or install via ioBroker dev tooling.

## License
GPL-3.0