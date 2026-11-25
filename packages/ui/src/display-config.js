/**
 * Per-sensor display preferences shared by "Tiempo real" and "Gráficas":
 * visibility, scale (min/max) and colour-zone thresholds. Stored per device.
 *
 * Groups are logical sensors: a KWP2000 field and its standard OBD2
 * equivalent share one preference (e.g. Vehicle Speed (ECU) / Vehicle Speed).
 */
import { meta } from './labels.js';

export const DISPLAY_KEY = 'obd.display';

export const SENSOR_GROUPS = [
    { id: 'speed', names: ['Vehicle Speed (ECU)', 'Vehicle Speed'], defaults: { min: 0, max: 150, ok: 20, warn: 130, bad: 145 } },
    { id: 'rpm', names: ['Engine RPM'], defaults: { min: 0, max: 7000, ok: 3500, warn: 5000, bad: 5500 } },
    { id: 'coolant', names: ['Coolant Temp', 'Coolant Temperature'], defaults: { min: 0, max: 120, ok: 60, warn: 95, bad: 105 } },
    { id: 'voltage', names: ['Battery Voltage (ECU)', 'Battery Voltage (ELM327)'], defaults: { min: 10, max: 16, ok: 12.8, warn: 14.8, bad: 15, lowWarn: 12, lowBad: 11.6 } },
    { id: 'throttle', names: ['Throttle Position', 'Engine Load'], defaults: { min: 0, max: 100, ok: 50, warn: 80, bad: 90 } },
    { id: 'engineState', names: ['Engine State'], defaults: {} },
    { id: 'map', names: ['Intake Manifold Pressure (MAP)', 'Intake Manifold Pressure'], defaults: { min: 0, max: 105, ok: 60, warn: 85, bad: 95 } },
    { id: 'iat', names: ['Intake Air Temp', 'Intake Air Temperature'], defaults: { min: -10, max: 90, ok: 40, warn: 50, bad: 60 } },
    { id: 'idleRpm', names: ['Target Idle RPM'], defaults: { min: 0, max: 2000, ok: 900, warn: 1200, bad: 1500 } },
    { id: 'o2', names: ['O2 Sensor B1S1'], defaults: { min: 0, max: 1000, ok: 600, warn: 800, bad: 900 } },
    { id: 'trim', names: ['Short-Term Fuel Trim (lambda ctrl)'], defaults: { min: -25, max: 25, ok: 10, warn: 15, bad: 20, lowWarn: -15, lowBad: -20 } },
    { id: 'injection', names: ['Injection Pulse'], defaults: { min: 0, max: 10, ok: 5, warn: 7, bad: 9 } },
    { id: 'injectionCyl', names: ['Injection per cyl. (×4µs)'], defaults: {} },
    { id: 'fuel', names: ['Fuel Tank Level'], defaults: { min: 0, max: 100, ok: 25, lowWarn: 15, lowBad: 8 } },
    { id: 'maf', names: ['MAF Air Flow Rate'], defaults: { min: 0, max: 100, ok: 60, warn: 80, bad: 90 } },
    { id: 'timing', names: ['Timing Advance'], defaults: { min: -10, max: 50, ok: 20, warn: 30, bad: 40 } },
    { id: 'runtime', names: ['Engine Run Time'], defaults: {} },
    { id: 'loadRaw', names: ['Engine Load / air charge (raw)'], defaults: {} },
    { id: 'ignitionRaw', names: ['Ignition-related (raw)'], defaults: {} },
    { id: 'cylRaw', names: ['Per-cylinder value (raw)'], defaults: {} },
    { id: 'idleRaw', names: ['Idle control? (raw)'], defaults: {} },
];

export const SENSOR_ORDER = SENSOR_GROUPS.map(g => g.names);

const NAME_TO_GROUP = new Map();
const NAME_TO_ID = new Map();
SENSOR_GROUPS.forEach(g => g.names.forEach(n => { NAME_TO_GROUP.set(n, g); NAME_TO_ID.set(n, g.id); }));

export const sensorGroup = (name) => NAME_TO_GROUP.get(name);
export const sensorKey = (name) => NAME_TO_ID.get(name) || name;

const FIELDS = ['min', 'max', 'ok', 'warn', 'bad', 'lowWarn', 'lowBad'];

export function defaultDisplayConfig() {
    const out = {};
    for (const g of SENSOR_GROUPS) out[g.id] = { visible: true, ...g.defaults };
    return out;
}

const numberOr = (v, fallback) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** Merge saved values with defaults; bad values in storage are ignored. */
export function loadDisplayConfig() {
    const out = defaultDisplayConfig();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(DISPLAY_KEY) || 'null'); } catch { /* ignore */ }
    if (!saved || typeof saved !== 'object') return out;
    for (const g of SENSOR_GROUPS) {
        const s = saved[g.id];
        if (!s || typeof s !== 'object') continue;
        if (typeof s.visible === 'boolean') out[g.id].visible = s.visible;
        for (const key of FIELDS) if (key in s) out[g.id][key] = numberOr(s[key], out[g.id][key]);
    }
    return out;
}

export function saveDisplayConfig(config) {
    const out = {};
    for (const g of SENSOR_GROUPS) {
        const p = config?.[g.id];
        if (!p) continue;
        out[g.id] = { visible: p.visible !== false };
        for (const key of FIELDS) if (p[key] != null) out[g.id][key] = numberOr(p[key], g.defaults[key]);
    }
    try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(out)); } catch { /* ignore */ }
    return out;
}

export const resetDisplayConfig = () => { try { localStorage.removeItem(DISPLAY_KEY); } catch { /* ignore */ } return defaultDisplayConfig(); };

/** Effective preferences of one field (groups share them). */
export function prefsFor(name, config = loadDisplayConfig()) {
    const p = config[sensorKey(name)] || {};
    const d = sensorGroup(name)?.defaults || {};
    const out = { visible: p.visible !== false };
    for (const key of FIELDS) {
        const v = numberOr(p[key], numberOr(d[key], meta(name)[key]));
        if (v != null) out[key] = v;
    }
    return out;
}

export const isVisible = (name, config = loadDisplayConfig()) => prefsFor(name, config).visible !== false;

export function rangeFor(name, config = loadDisplayConfig()) {
    const p = prefsFor(name, config);
    const m = meta(name);
    if (!Number.isFinite(p.min) && !Number.isFinite(p.max) && !Number.isFinite(m.min) && !Number.isFinite(m.max)) return null;
    return { min: numberOr(p.min, m.min ?? 0), max: numberOr(p.max, m.max ?? p.min ?? 1) };
}

/** Groups that can be drawn in a Cartesian chart (text/raw fields excluded). */
export function graphableGroups(config = loadDisplayConfig()) {
    return SENSOR_GROUPS.filter(g => g.names.some(n => {
        const r = rangeFor(n, config);
        return r && r.max > r.min && n !== 'Engine State';
    }));
}
