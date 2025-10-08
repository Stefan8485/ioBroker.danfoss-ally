# ioBroker.danfoss-ally  ![version](https://img.shields.io/badge/version-0.2.8-blue)


Cloud adapter for **Danfoss Ally™** – using **OAuth2 (Client Credentials)**.  
Reads temperature, humidity, valve position, and battery data for all devices in your Ally account.

---

## Features

- Connects ioBroker directly to the **Danfoss Ally Cloud API**  
- Automatic **OAuth2 token refresh**  
- Discovers all registered devices  
- Reads all available sensor data (temperature, humidity, battery, valve, etc.)  
- Converts raw values (×0.1) into real units (°C, %)  
- Fully automatic polling  

---

## Supported Devices

- Danfoss Icon2 RT (Room thermostats)  
- Danfoss Icon2 Controller  
- Danfoss Ally™ Gateway  
  *(Additional devices are automatically detected)*  

---

## Configuration

Configure under **Instances → danfoss-ally → Settings**

| Field | Description |
|--------|-------------|
| **API Key / Secret** | Your Danfoss Developer App credentials |
| **Token URL** | OAuth2 token endpoint (e.g. `https://api.danfoss.com/oauth2/token`) |
| **API Base URL** | Base API endpoint (e.g. `https://api.danfoss.com/ally`) |
| **Scope** | Optional (e.g. `read write`) |
| **Polling Interval** | Interval in seconds (default: `60`) |

### Example Configuration

```
API Key:      mxqNgoRTnWYSWMG01Oo4wpTxwjS6SyXyMcY1ih
API Secret:   [your secret]
Token URL:    https://api.danfoss.com/oauth2/token
API Base URL: https://api.danfoss.com/ally
Polling:      600
```

---

## States

For each discovered device, the adapter creates a channel:  
`danfoss-ally.0.devices.<device_id>`

| State | Description | Unit |
|--------|--------------|------|
| `temp_current` | Current room temperature | °C |
| `temp_set` | Target temperature | °C |
| `humidity_value` | Relative humidity | % |
| `battery_percentage` | Battery level | % |
| `mode` | Current mode (auto, holiday, manual, etc.) | – |
| `work_state` | Heating state | – |
| `fault` | Error code | – |
| `output_status` | Valve or output status | – |
| `upper_temp` / `lower_temp` | Limit settings | °C |
| ... | Additional fields depending on Danfoss API | – |

**Note:**  
All temperature and humidity values are automatically converted from tenths to real units (°C / %).

---

## Token Handling

- Adapter uses **OAuth2 Client Credentials Flow**  
- Automatically requests token on startup  
- Refreshes automatically before expiration  
- If an API call returns 401, it retries once with a new token  

---

## API Endpoints

Used Danfoss Ally endpoints:

- `POST /oauth2/token` → Retrieve OAuth2 access token  
- `GET /devices` → List devices  
- `GET /devices/{id}/status` → Device status  
- `GET /devices/{id}` → Fallback for status  
- `POST /devices/{id}/commands` → *(Reserved for future write support)*  

---

## Polling

- Data is refreshed from the cloud periodically  
- Default: every 60 seconds  
- Configurable via adapter settings  

---

## Changelog

### v0.2.8
- fixed io-package.json file

### v0.2.6
- Added Adpater in IoBroker

### v0.2.6
- fixed io-package.json file

### v0.2.5
- Added Adpater in IoBroker Dev portal

### v0.2.4
- Added ioBroker update support and improved release metadata

### v0.2.3
- Improved token handling and fixed login configuration issues

### v0.2.2
- Fixed sensors datas and states
- Verified device state updates

### v0.2.1
- Fixed sensor scaling (°C / % values)
- Improved stability and logging
- Verified device state updates for all devices

### v0.2.0
- Added automatic token refresh
- Added scaling for °C / % values
- Improved logging and state creation
- Expanded unit & role mapping
- Device discovery and sensor updates verified

### v0.1.0
- Initial release with basic device detection and token handling

---

## Example Log Output

```
🔄 Starting Danfoss Ally adapter...
🔑 Refreshing OAuth2 token...
✅ Token acquired. Expires in ~3599 s
📡 Found 13 devices, updating states...
✅ Updated 13 devices from Danfoss Ally Cloud.
⏱ Polling interval set to 600 s
```

---

## Development

```
npm i
node main.js
```

or install via ioBroker development tooling.

---

## License

**GPL-3.0-or-later**  ![license](https://img.shields.io/badge/license-GPL--3.0-green)
Maintained by community contributors.
