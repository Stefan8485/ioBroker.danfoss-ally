'use strict';
const utils = require('@iobroker/adapter-core');
const DanfossAPI = require('./lib/danfossApi');

/** ------------------- Write-Coordination / Constants ------------------- */
const WRITE_HOLD_MS = 60 * 1000; // 1 min: solange überschreibt der Poll lokale Writes nicht
const ANTI_RACE_PAUSE_MS = 5000; // 5 s: direkter kurzer Poll-Stopp nach lokalem Write
const LAG_SUPPRESS_MS = 15000; // 15 s: unterdrücke "alte" Poll-Werte nach lokalem Write
const TEMP_EPS = 0.05; // °C-Toleranz zum Abgleich mit Cloud

// Typ-/Einheits-Hints halten die Objekte stabil (kein Typflip bei wechselnden API-Rückgaben)
const TYPE_HINTS = new Map([
            // Zahlen (°C)
            ['temp_current', 'number'],
            ['temp_set', 'number'],
            ['upper_temp', 'number'],
            ['lower_temp', 'number'],
            ['at_home_setting', 'number'],
            ['leaving_home_setting', 'number'],
            ['pause_setting', 'number'],
            ['holiday_setting', 'number'],
            ['manual_mode_fast', 'number'],

            // Zahlen (%)
            ['humidity_value', 'number'],
            ['battery_percentage', 'number'],

            // Bool
            ['child_lock', 'boolean'],

            // Strings (Enums/Text)
            ['mode', 'string'],
            ['SetpointChangeSource', 'string'],
            ['work_state', 'string'],
            ['output_status', 'string'],
            ['fault', 'string'],

        ]);

const UNIT_HINTS = new Map([
            ['temp_current', '°C'],
            ['temp_set', '°C'],
            ['upper_temp', '°C'],
            ['lower_temp', '°C'],
            ['at_home_setting', '°C'],
            ['leaving_home_setting', '°C'],
            ['pause_setting', '°C'],
            ['holiday_setting', '°C'],
            ['humidity_value', '%'],
            ['battery_percentage', '%'],
            ['manual_mode_fast', '°C'],
        ]);

const TEMP_CODES = new Set([
            'temp_set',
            'at_home_setting',
            'leaving_home_setting',
            'pause_setting',
            'holiday_setting',
            'lower_temp',
            'upper_temp',
        ]);

// Beschreibbare States
const WRITEABLE_CODES = new Set([
            'temp_set', // manuelle Solltemperatur
            'manual_mode_fast', // UI-write erlaubt, wird auf temp_set gemappt
            'at_home_setting',
            'leaving_home_setting',
            'pause_setting',
            'holiday_setting',
            'mode',
            'child_lock',
            'SetpointChangeSource',
        ]);

/** ------- Alias-/Normalisierung ------- */
const CODE_ALIASES = new Map([
            ['pause_settings', 'pause_setting'],
            ['pause', 'pause_setting'], // falls jemand nur "pause" schreibt
            ['setpoint_change_source', 'SetpointChangeSource'],
            ['setpointchangesource', 'SetpointChangeSource'],
            ['setpoint_change', 'SetpointChangeSource'],
        ]);

const MODE_ALIASES = new Map([
            ['holiday_sat', 'holiday'], // Spezialfall → „holiday“
            ['manual', 'manual'],
            ['leaving_home', 'leaving_home'],
            ['pause', 'pause'],
            ['at_home', 'at_home'],
            ['holiday', 'holiday'],
            ['auto', 'auto'],
        ]);

function normalizeCode(codeRaw) {
    const c = String(codeRaw || '').trim();
    const lower = c.toLowerCase();
    if (CODE_ALIASES.has(lower))
        return CODE_ALIASES.get(lower);
    return c;
}

function normalizeMode(modeRaw) {
    const m = String(modeRaw || '').trim();
    const lower = m.toLowerCase();
    if (MODE_ALIASES.has(lower))
        return MODE_ALIASES.get(lower);
    return m;
}

/** ------- DEBUG HELPERS ------- */
function errDetails(err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    return status ? `HTTP ${status}${data ? ` body=${JSON.stringify(data)}` : ''}` : String(err);
}
function dval(v) {
    return typeof v === 'number' ? Number(v.toFixed(1)) : v;
}

function coerceTypeByHint(code, value) {
    const hint = TYPE_HINTS.get(code);
    if (!hint)
        return value;
    if (hint === 'number')
        return typeof value === 'number' ? value : Number(value);
    if (hint === 'boolean')
        return typeof value === 'boolean' ? value : (value === 'true' || value === true || value === 1);
    if (hint === 'string')
        return value != null ? String(value) : '';
    return value;
}

// Vergleich nur-auf-Änderung (mit EPS für Temp)
function isSameVal(code, a, b) {
    if (typeof a === 'number' && typeof b === 'number') {
        const tempish = [
            'temp_current', 'temp_set', 'upper_temp', 'lower_temp',
            'at_home_setting', 'leaving_home_setting', 'pause_setting', 'holiday_setting', 'manual_mode_fast'
        ];
        return tempish.includes(code) ? Math.abs(a - b) <= TEMP_EPS : a === b;
    }
    return a === b;
}

/** ----------------------------- Adapter ----------------------------- */
class DanfossAlly extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'danfoss-ally'
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        // Write-Coordination
        this._pending = new Map(); // key: `${deviceId}.${code}` -> { val, until }
        this._lastWriteAt = 0;
        this._recentWriteTs = new Map(); // key: `${deviceId}.${code}` -> ts (ms)
    }

    sanitizeId(raw) {
        const s = String(raw || '');
        const forbid = this.FORBIDDEN_CHARS || /[\][*"'`\\<>?~:;|#+\s.]/g; // Fallback, falls nicht vorhanden
        return s.replace(forbid, '_');
    }

    async onReady() {
        this._antiRacePauseMs = Number(this.config?.antiRacePauseMs) || ANTI_RACE_PAUSE_MS;
        this.log.info('Starting Danfoss Ally adapter...');

        const { apiKey, apiSecret, tokenUrl, apiBaseUrl, scope, pollingInterval } = this.config;
        if (!apiKey || !apiSecret || !tokenUrl || !apiBaseUrl) {
            this.log.warn('Missing configuration (API key, secret or URL).');
            return;
        }

        this.api = new DanfossAPI({
            apiKey,
            apiSecret,
            tokenUrl,
            apiBaseUrl,
            scope
        }, this.log);

        try {
            await this.api.ensureToken();
            await this.updateDevices();
            const MIN_POLL_SEC = 30;
            const MAX_POLL_SEC = 86400;

            let intervalSec = Number(pollingInterval || 60);
            if (!Number.isFinite(intervalSec))
                intervalSec = 60;
            if (intervalSec < MIN_POLL_SEC)
                intervalSec = MIN_POLL_SEC;
            if (intervalSec > MAX_POLL_SEC)
                intervalSec = MAX_POLL_SEC;

            this.pollInterval = this.setInterval(() => this.updateDevices(), intervalSec * 1000);
            this.log.info(`Polling interval set to ${intervalSec}s`);

            // Auf Schreib-States hören (inkl. Aliasse)
            [
                '*.temp_set',
                '*.manual_mode_fast',
                '*.mode',
                '*.child_lock',
                '*.at_home_setting',
                '*.leaving_home_setting',
                '*.pause_setting',
                '*.holiday_setting',
                '*.SetpointChangeSource',
                // Aliasse
                '*.pause_settings',
                '*.setpoint_change_source',
                '*.setpointchangesource',
                '*.setpoint_change',
            ].forEach(p => this.subscribeStates(p));

            this.log.debug(`Subscribed to write patterns for Danfoss Ally.`);
        } catch (err) {
            this.log.error(`Adapter startup failed: ${err.message}`);
        }
    }

    /**
     * Geräte abrufen und States aktualisieren
     * - Anti-Race: direkt nach lokalem Write kurz nicht pollen
     * - HOLD: schützt lokale Writes vor Poll-Überschreibung
     * - Lag-Suppress: ignoriert kurzzeitig evtl. „alte“ Cloud-Werte
     * - Only-if-changed: schreibt States nur bei Wertänderung
     */
    async updateDevices() {
        const pollStartedAt = Date.now();
        let changed = 0,
        skipped = 0,
        held = 0;

        try {
            // Anti-Race: direkt nach einem lokalen Write kurz nicht pollen
            if (pollStartedAt - this._lastWriteAt < this._antiRacePauseMs) {
                this.log.debug(`Skipping poll (anti-race pause ${this._antiRacePauseMs}ms)`);
                return;
            }

            const devices = await this.api.getDevices();
            if (!devices || !devices.length) {
                this.log.warn('No devices returned from Danfoss API.');
                return;
            }

            this.log.debug(`Found ${devices.length} devices, updating states...`);

            for (const dev of devices) {
                // IDs immer sanitizen
                const devId = this.sanitizeId(dev.id);
                const devPath = `${devId}`;

                // Channel/Ordner für Gerät
                await this.setObjectNotExistsAsync(devPath, {
                    type: 'device',
                    common: {
                        name: dev.name || 'Device'
                    },
                    native: dev.raw || {},
                });

                // Statusquelle (Array aus raw.status oder Key/Value aus dev.status)
                let pairs = [];
                if (Array.isArray(dev?.raw?.status)) {
                    pairs = dev.raw.status.map(s => [s.code, s.value]);
                } else {
                    const map = dev.status || {};
                    pairs = Object.entries(map);
                }

                for (const [codeRaw, rawValue] of pairs) {
                    if (typeof codeRaw !== 'string')
                        continue;

                    // Code normalisieren + sanitizen
                    const code = this.sanitizeId(normalizeCode(codeRaw));

                    // Skalierung in reale Einheiten
                    let value = rawValue;
                    const tempLike = [
                        'temp_current', 'temp_set', 'upper_temp', 'lower_temp',
                        'at_home_setting', 'leaving_home_setting', 'pause_setting', 'holiday_setting',
                        'manual_mode_fast'
                    ];
                    if (tempLike.includes(code) && typeof value === 'number')
                        value = value / 10;
                    if (code === 'humidity_value' && typeof value === 'number')
                        value = value / 10;

                    // Typ stabilisieren (verhindert Type-Flips)
                    value = coerceTypeByHint(code, value);

                    // Objekt anlegen/angleichen (stabile Metadaten)
                    const forcedType =
                        TYPE_HINTS.get(code) ||
                        (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string');
                    const unit = UNIT_HINTS.get(code) || this.mapUnit(code);

                    const id = `${devPath}.${code}`;
                    const existing = await this.getObjectAsync(id);
                    if (!existing) {
                        await this.setObjectAsync(id, {
                            type: 'state',
                            common: {
                                name: code,
                                type: forcedType,
                                role: this.mapRole(code),
                                unit,
                                read: true,
                                write: WRITEABLE_CODES.has(code),
                            },
                            native: {},
                        });
                    } else {
                        const c = existing.common || {};
                        const needExtend =
                            c.type !== forcedType ||
                            c.unit !== (unit || '') ||
                            c.read !== true ||
                            c.write !== WRITEABLE_CODES.has(code) ||
                            c.role !== this.mapRole(code) ||
                            c.name !== code;

                        if (needExtend) {
                            await this.extendObjectAsync(id, {
                                common: {
                                    ...c,
                                    name: code,
                                    type: forcedType,
                                    role: this.mapRole(code),
                                    unit,
                                    read: true,
                                    write: WRITEABLE_CODES.has(code),
                                },
                            });
                        }
                    }

                    // Pending-Write-Hold: Poll soll lokale Writes nicht direkt überschreiben
                    const key = `${devId}.${code}`;
                    const pending = this._pending.get(key);
                    if (pending && pollStartedAt < pending.until) {
                        const same =
                            (typeof value === 'number' && Math.abs(value - Number(pending.val)) <= TEMP_EPS) ||
                        (value === pending.val);

                        if (same) {
                            // Cloud hat den lokalen Wert erreicht -> Hold auflösen
                            this.log.debug(`MATCH ${key}: cloud≈local -> drop hold`);
                            this._pending.delete(key);
                        } else {
                            // Lokalen Wert weiterhin schützen
                            held++;
                            this.log.debug(`HOLD ${key}: keep local=${dval(pending.val)} vs cloud=${dval(value)} (until ${new Date(pending.until).toISOString()})`);
                            continue; // cloud nicht anwenden
                        }
                    }

                    // Lag-Suppress: kurz nach lokalem Write evtl. alten Cloud-Wert ignorieren
                    const lastWriteTs = this._recentWriteTs.get(key) || 0;
                    if (lastWriteTs && pollStartedAt - lastWriteTs < LAG_SUPPRESS_MS) {
                        const cur = await this.getStateAsync(id);
                        const same = cur && cur.val !== undefined && isSameVal(code, cur.val, value);
                        if (!same) {
                            this.log.debug(`SUPPRESS ${key}: skip cloud=${dval(value)} for ${LAG_SUPPRESS_MS - (pollStartedAt - lastWriteTs)}ms (recent local write)`);
                            continue;
                        }
                    }

                    // Only-if-changed schreiben
                    const cur = await this.getStateAsync(id);
                    if (cur && cur.val !== undefined && isSameVal(code, cur.val, value)) {
                        skipped++;
                    } else {
                        changed++;
                        this.log.debug(`SET ${devId}.${code}=${dval(value)} (ack)`);
                        await this.setStateAsync(id, {
                            val: value,
                            ack: true
                        });
                    }
                }
            }

            this.log.info(`Updated ${devices.length} devices. Changed=${changed}, Skipped=${skipped}, Held=${held}`);
        } catch (err) {
            this.log.error(`Error updating devices: ${err.message}`);
        }
    }

    /** HOLD + Zeitstempel nach erfolgreichem Write setzen */
    _noteWrite(deviceId, code, localVal) {
        const key = `${deviceId}.${code}`;
        const now = Date.now();
        this._pending.set(key, {
            val: localVal,
            until: now + WRITE_HOLD_MS
        });
        this._recentWriteTs.set(key, now);
        this._lastWriteAt = now;
        this.log.debug(`HOLD  ${key} = ${dval(localVal)} for ${Math.round(WRITE_HOLD_MS / 1000)}s`);
    }

    /** Soft-Refresh: nur ausgewählte Codes eines Geräts nachladen */
    async _softRefreshOne(deviceId, onlyCodes = null) {
        try {
            const raw = await this.api.getDeviceStatus(deviceId);
            const statusArray = Array.isArray(raw?.result) ? raw.result
                 : Array.isArray(raw?.status) ? raw.status
                 : Array.isArray(raw) ? raw
                 : [];

            const devPath = `${devId}`;
            for (const entry of statusArray) {
                let code = normalizeCode(entry.code);
                if (!code)
                    continue;
              
                code = this.sanitizeId(code);
                if (onlyCodes && !onlyCodes.has(code))
                    continue;

                let value = entry.value;
                const tempLike = [
                    'temp_current', 'temp_set', 'upper_temp', 'lower_temp',
                    'at_home_setting', 'leaving_home_setting', 'pause_setting',
                    'holiday_setting', 'manual_mode_fast'
                ];
                if (tempLike.includes(code) && typeof value === 'number')
                    value = value / 10;
                if (code === 'humidity_value' && typeof value === 'number')
                    value = value / 10;
                value = coerceTypeByHint(code, value);

                const id = `${devPath}.${code}`;
                const key = `${deviceId}.${code}`;

                // HOLD-Logik
                const pending = this._pending.get(key);
                if (pending && Date.now() < pending.until) {
                    const same =
                        (typeof value === 'number' && Math.abs(value - Number(pending.val)) <= TEMP_EPS) ||
                    (value === pending.val);
                    if (same) {
                        this.log.debug(`MATCH ${key}: cloud≈local → drop hold`);
                        this._pending.delete(key);
                    } else {
                        this.log.debug(`HOLD  ${key} (soft): keep local=${dval(pending.val)} vs cloud=${dval(value)}`);
                        continue;
                    }
                }

                // Lag-Suppress im Soft-Refresh ebenfalls respektieren
                const lastWriteTs = this._recentWriteTs.get(key) || 0;
                if (lastWriteTs && Date.now() - lastWriteTs < LAG_SUPPRESS_MS) {
                    const cur = await this.getStateAsync(id);
                    const same = cur && cur.val !== undefined && isSameVal(code, cur.val, value);
                    if (!same) {
                        this.log.debug(`SUPPRESS ${key} (soft): skip cloud=${dval(value)} for ${LAG_SUPPRESS_MS - (Date.now() - lastWriteTs)}ms`);
                        continue;
                    }
                }

                const cur = await this.getStateAsync(id);
                if (!(cur && cur.val !== undefined && isSameVal(code, cur.val, value))) {
                    this.log.debug(`SET   ${deviceId}.${code} = ${dval(value)} (ack, soft refresh)`);
                    await this.setStateAsync(id, {
                        val: value,
                        ack: true
                    });
                }
            }
        } catch (e) {
            this.log.debug(`(soft refresh) failed for ${deviceId}: ${e.message}`);
        }
    }

    _softRefreshSoon(deviceId, code) {
        // Nach Write: nur den betroffenen Code + temp_current schnell nachziehen
        const codes = new Set([code, 'temp_current']);
        setTimeout(() => this._softRefreshOne(deviceId, codes), 1500);
    }

    /** Hilfsfunktion: einen einzelnen Befehl senden (mit Debug + Retry) */
    async sendOne(deviceId, codeRaw, value) {
        const code = normalizeCode(codeRaw);
        this.log.debug(`SEND ${deviceId}: ${code}=${dval(value)}`);
        try {
            await this.api.sendCommand(deviceId, {
                commands: [{
                        code,
                        value
                    }
                ]
            });
            this.log.debug(`OK   ${deviceId}: ${code}`);
        } catch (err) {
            const status = err?.response?.status;
            const title = err?.response?.data?.title || '';
            const headerMissing = status === 400 && /header/i.test(title);
            const retryable = status === 401 || headerMissing;

            this.log.debug(`ERR  ${deviceId}: ${code} => ${errDetails(err)}${retryable ? ' ⇒ retrying once…' : ''}`);

            if (retryable) {
                try {
                    await this.api.ensureToken();
                    await this.api.sendCommand(deviceId, {
                        commands: [{
                                code,
                                value
                            }
                        ]
                    });
                    this.log.debug(`OK   ${deviceId}: ${code} (after retry)`);
                    return;
                } catch (e2) {
                    this.log.debug(`ERR  ${deviceId}: ${code} retry failed => ${errDetails(e2)}`);
                    throw e2;
                }
            }
            throw err;
        }
    }

    /**
     * Writes aus ioBroker entgegennehmen und an die Cloud senden
     * – ohne automatische Sequenzen (volle Kontrolle pro Code)
     */
    async onStateChange(id, state) {
        // 1) Safety
        if (!state)
            return;

        // 2) ack=true: nur Debug (kein Write auslösen)
        if (state.ack) {
            this.log.debug(`ack=true update ignored: ${id}`);
            return;
        }

        // 3) reguläres Debug + Ablauf
        this.log.debug(`WRITE ${id} val=${dval(state.val)}`);

        try {
            // id-Form: "danfoss-ally.0.<deviceId>.<code>"
            const nsPrefix = this.namespace + '.'; // z.B. "danfoss-ally.0."
            if (!id.startsWith(nsPrefix))
                return;

            const rel = id.slice(nsPrefix.length); // => "<deviceId>.<code>[.<sub>...]"
            const [deviceIdRaw, rawCode] = rel.split('.');
            if (!deviceIdRaw || !rawCode)
                return;

            const deviceId = this.sanitizeId(deviceIdRaw);
            const code = this.sanitizeId(normalizeCode(rawCode));
            let val = state.val;

            if (code !== rawCode) {
                this.log.debug(`Normalized code '${rawCode}' → '${code}' for ${deviceId}`);
            }

            // Helper: Temp vorbereiten (Clamp an lower/upper + ×10)
            const prepareTempValue10 = async(v) => {
                let target = Number(v);
                if (!Number.isFinite(target))
                    return null;

                const lower = await this.getStateAsync(`${deviceId}.lower_temp`);
                const upper = await this.getStateAsync(`${deviceId}.upper_temp`);

                const before = target;
                if (lower && typeof lower.val === 'number')
                    target = Math.max(target, lower.val);
                if (upper && typeof upper.val === 'number')
                    target = Math.min(target, upper.val);

                const v10 = Math.round(target * 10);
                this.log.debug(
                    `PREP ${deviceId}: input=${dval(v)}${before !== target ? ` clamped→${dval(target)}` : ''} send×10=${v10}` + 
                    `${lower && typeof lower.val === 'number' ? ` (lower=${dval(lower.val)})` : ''}` + 
`${upper && typeof upper.val === 'number' ? ` (upper=${dval(upper.val)})` : ''}`);
                return v10;
            };

            // ==== Schreiblogik (einzeln, ohne Auto-Sequenzen) ====

            // manual_mode_fast -> temp_set (Shortcut, kein Moduswechsel)
            if (code === 'manual_mode_fast') {
                const v10 = await prepareTempValue10(val);
                if (v10 == null) {
                    this.log.warn(`Ignoring invalid temperature for ${deviceId}.${code}: ${val}`);
                    return;
                }

                await this.sendOne(deviceId, 'temp_set', v10);
                await this.setStateAsync(`${deviceId}.temp_set`, {
                    val: Number(val),
                    ack: true
                });
                await this.setStateAsync(`${deviceId}.manual_mode_fast`, {
                    val: Number(val),
                    ack: true
                });
                this._noteWrite(deviceId, 'temp_set', Number(val));

                this._softRefreshSoon(deviceId, 'temp_set');
                this.log.info(`Set temp_set via manual_mode_fast for ${deviceId}`);
                return;
            }

            // temp_set (kein Moduswechsel)
            if (code === 'temp_set') {
                const v10 = await prepareTempValue10(val);
                if (v10 == null) {
                    this.log.warn(`Ignoring invalid temperature for ${deviceId}.${code}: ${val}`);
                    return;
                }

                await this.sendOne(deviceId, 'temp_set', v10);
                await this.setStateAsync(`${deviceId}.temp_set`, {
                    val: Number(val),
                    ack: true
                });
                this._noteWrite(deviceId, 'temp_set', Number(val));

                this._softRefreshSoon(deviceId, 'temp_set');
                this.log.info(`Set temp_set for ${deviceId}`);
                return;
            }

            // Preset-Setpoints (keine Sequenzen)
            if (['at_home_setting', 'leaving_home_setting', 'pause_setting', 'holiday_setting'].includes(code)) {
                const v10 = await prepareTempValue10(val);
                if (v10 == null) {
                    this.log.warn(`Ignoring invalid temperature for ${deviceId}.${code}: ${val}`);
                    return;
                }

                await this.sendOne(deviceId, code, v10);
                await this.setStateAsync(`${deviceId}.${code}`, {
                    val: Number(val),
                    ack: true
                });
                this._noteWrite(deviceId, code, Number(val));

                this._softRefreshSoon(deviceId, code);
                this.log.info(`Set ${code} for ${deviceId}`);
                return;
            }

            // Kindersicherung
            if (code === 'child_lock') {
                const boolVal = (val === true || val === 'true' || val === 1);
                try {
                    await this.sendOne(deviceId, 'child_lock', boolVal ? 1 : 0);
                } catch {
                    await this.sendOne(deviceId, 'child_lock', !!boolVal);
                }
                await this.setStateAsync(`${deviceId}.child_lock`, {
                    val: !!boolVal,
                    ack: true
                });
                this._noteWrite(deviceId, 'child_lock', !!boolVal);

                this._softRefreshSoon(deviceId, 'child_lock');
                this.log.info(`Set child_lock=${!!boolVal} for ${deviceId}`);
                return;
            }

            // Mode
            if (code === 'mode') {
                const next = normalizeMode(String(val));
                await this.sendOne(deviceId, 'mode', next);
                await this.setStateAsync(`${deviceId}.mode`, {
                    val: next,
                    ack: true
                });
                this._noteWrite(deviceId, 'mode', next);

                this._softRefreshSoon(deviceId, 'mode');
                this.log.info(`Set mode=${next} for ${deviceId}`);
                return;
            }

            // SetpointChangeSource
            if (code === 'SetpointChangeSource') {
                const v = String(val).trim();
                const allowed = new Set(['schedule', 'Externally']);
                const src = allowed.has(v) ? v : 'Externally';

                await this.sendOne(deviceId, 'SetpointChangeSource', src);
                await this.setStateAsync(`${deviceId}.SetpointChangeSource`, {
                    val: src,
                    ack: true
                });
                this._noteWrite(deviceId, 'SetpointChangeSource', src);

                this._softRefreshSoon(deviceId, 'SetpointChangeSource');
                this.log.info(`Set SetpointChangeSource=${src} for ${deviceId}`);
                return;
            }

            // Unbekannter/Read-Only-Code → Hinweis
            if (!WRITEABLE_CODES.has(code)) {
                this.log.warn(`Ignoring write to read-only or unknown code: ${deviceId}.${code} (from '${rawCode}')`);
            }
        } catch (e) {
            this.log.error(`onStateChange error for ${id}: ${e.message}`);
        }
    }

    mapRole(code) {
        const writeableTemp = new Set([
                    'temp_set',
                    'manual_mode_fast',
                    'at_home_setting',
                    'leaving_home_setting',
                    'pause_setting',
                    'holiday_setting',
                ]);

        const roTemp = new Set([
                    'temp_current',
                    'lower_temp',
                    'upper_temp',
                ]);

        if (writeableTemp.has(code))
            return 'level.temperature';
        if (roTemp.has(code))
            return 'value.temperature';

        if (code === 'humidity_value')
            return 'value.humidity';
        if (code === 'battery_percentage')
            return 'value.battery';
        if (code === 'child_lock')
            return 'switch';
        if (code === 'mode')
            return 'text';
        if (code === 'work_state' || code === 'output_status' || code === 'fault')
            return 'text';

        return 'state';
    }

    mapUnit(code) {
        const units = {
            temp_current: '°C',
            temp_set: '°C',
            manual_mode_fast: '°C',
            at_home_setting: '°C',
            leaving_home_setting: '°C',
            pause_setting: '°C',
            holiday_setting: '°C',
            lower_temp: '°C',
            upper_temp: '°C',
            humidity_value: '%',
            battery_percentage: '%',
        };
        return units[code] || '';
    }

    onUnload(callback) {
        try {
            if (this.pollInterval)
                clearInterval(this.pollInterval);
            this.log.info('Adapter stopped');
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new DanfossAlly(options);
} else {
    new DanfossAlly();
}