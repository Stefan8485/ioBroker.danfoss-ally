# Older changes

## 0.2.19

- Prevented cloud polling from writing values back into `control.*` states
- Added write source information to debug logs and a direct status fallback for devices without status values
- Reduced repeated poll output to actual changes after startup

## 0.2.18

- Sent `manual_mode_fast` with Ally TRV setpoint writes when available
- Added warnings when the Danfoss Cloud does not confirm a requested setpoint
- Improved relay device detection and naming

## 0.2.17

- Tried `SetpointChangeSource=Externally` with `temp_set` for Ally TRVs, with a fallback to `temp_set`
- Fixed `control.switch` subscriptions for Icon2 and Boiler Relay
- Added `Occupied_Setpoint` alias handling and fixed jsonConfig header validation

## 0.2.16

- Fixed Ally TRV `temp_set` writes, temperature clamping, and `OccupiedSetpoint` scaling
- Added types for 16 data points and made the Icon2 switch writable
- Fixed jsonConfig admin validation and added Boiler Relay support
