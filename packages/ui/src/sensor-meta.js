/**
 * Orden, escalas y zonas de color de los sensores en tiempo real.
 *
 * `SENSOR_ORDER` es la prioridad de la pantalla (velocidad, RPM, temperatura,
 * batería, acelerador, estado del motor y, después, el resto). Los nombres son
 * los que emite @obdii/core; un mismo sensor lógico puede tener varios nombres
 * según el protocolo (KWP2000 vs OBD2 estándar).
 *
 * Las zonas se evalúan de abajo arriba: `zones[0]` es el color "frío/normal"
 * y el último el de peligro. Cada zona tiene un `at` (valor desde el cual se
 * aplica) y un color. `lows` permite marcar también los valores bajos
 * (batería), ordenados de más grave a menos grave.
 */
import { meta } from './labels.js';

export const SENSOR_ORDER = [
    ['Vehicle Speed (ECU)', 'Vehicle Speed'],
    ['Engine RPM'],
    ['Coolant Temp', 'Coolant Temperature'],
    ['Battery Voltage (ECU)', 'Battery Voltage (ELM327)'],
    ['Throttle Position', 'Engine Load'],
    ['Engine State'],
    ['Intake Manifold Pressure (MAP)', 'Intake Manifold Pressure'],
    ['Intake Air Temp', 'Intake Air Temperature'],
    ['Target Idle RPM'],
    ['O2 Sensor B1S1'],
    ['Short-Term Fuel Trim (lambda ctrl)'],
    ['Injection Pulse'],
    ['Injection per cyl. (×4µs)'],
    ['Fuel Tank Level'],
    ['MAF Air Flow Rate'],
    ['Timing Advance'],
    ['Engine Run Time'],
    ['Engine Load / air charge (raw)'],
    ['Ignition-related (raw)'],
    ['Per-cylinder value (raw)'],
    ['Idle control? (raw)'],
];

const RANK = new Map();
SENSOR_ORDER.forEach((names, i) => names.forEach(n => RANK.set(n, i)));

/** Prioridad de un campo: 0 = primero. Los desconocidos van al final. */
export const sensorRank = (name) => RANK.has(name) ? RANK.get(name) : SENSOR_ORDER.length;

export const sortFields = (fields) => [...fields].sort((a, b) =>
    sensorRank(a.name) - sensorRank(b.name) || String(a.name).localeCompare(String(b.name)));

const COOLANT = { zones: [{ at: 0, color: 'cool' }, { at: 60, color: 'ok' }, { at: 95, color: 'warn' }, { at: 105, color: 'bad' }],
    alerts: { warn: ['overheat', 'warn'], bad: ['overheat', 'crit'] } };
const VOLTAGE = { lows: [{ low: 11.6, color: 'bad' }, { low: 12.0, color: 'warn' }],
    zones: [{ at: 0, color: 'cool' }, { at: 12.8, color: 'ok' }, { at: 14.8, color: 'warn' }, { at: 15.0, color: 'bad' }],
    alerts: { warn: ['overVoltage', 'maxV'], badLow: ['lowBattery', 'critV'], warnLow: [['lowBattery', 'warnV'], ['noCharge', 'minV']] } };

/** Definición base por nombre de campo emitido por el core. */
const BASE = {
    'Engine RPM': { zones: [{ at: 0, color: 'cool' }, { at: 3500, color: 'ok' }, { at: 5000, color: 'warn' }, { at: 5500, color: 'bad' }],
        alerts: { warn: ['overRev', 'rpm'] } },
    'Coolant Temp': COOLANT,
    'Coolant Temperature': COOLANT,
    'Battery Voltage (ECU)': VOLTAGE,
    'Battery Voltage (ELM327)': VOLTAGE,
    'Throttle Position': { zones: [{ at: 0, color: 'cool' }, { at: 50, color: 'ok' }, { at: 80, color: 'warn' }, { at: 90, color: 'bad' }] },
    'Engine Load': { zones: [{ at: 0, color: 'cool' }, { at: 50, color: 'ok' }, { at: 80, color: 'warn' }, { at: 90, color: 'bad' }] },
};

const WEIGHT = { cool: 0, ok: 1, warn: 2, bad: 3 };
const cfgValue = (config, id, key) => Number(config?.[id]?.[key]);

/**
 * Zonas efectivas de un sensor: las propias más los umbrales que el usuario
 * haya configurado en «Ajustes → Alertas». Si dos zonas coinciden, gana la más
 * severa.
 */
export function sensorZones(name, config = {}) {
    const def = BASE[name];
    if (!def) return { zones: [], lows: [] };
    const zones = (def.zones || []).map(z => ({ ...z }));
    const lows = (def.lows || []).map(z => ({ ...z }));
    const alerts = def.alerts || {};
    const setZone = (arr, prop, value, color) => {
        if (!Number.isFinite(value)) return;
        const at = { at: value, color };
        const low = { low: value, color };
        const i = arr.findIndex(z => Math.abs(z[prop] - value) < 0.001);
        if (i < 0) arr.push(prop === 'at' ? at : low);
        else if (WEIGHT[color] > WEIGHT[arr[i].color]) arr[i] = prop === 'at' ? at : low;
    };
    const apply = (ref, prop, color) => {
        if (!ref) return;
        if (Array.isArray(ref[0])) ref.forEach(([id, key]) => setZone(prop === 'at' ? zones : lows, prop, cfgValue(config, id, key), color));
        else setZone(prop === 'at' ? zones : lows, prop, cfgValue(config, ref[0], ref[1]), color);
    };
    apply(alerts.warn, 'at', 'warn');
    apply(alerts.bad, 'at', 'bad');
    apply(alerts.warnLow, 'low', 'warn');
    apply(alerts.badLow, 'low', 'bad');
    zones.sort((a, b) => a.at - b.at);
    lows.sort((a, b) => WEIGHT[a.color] - WEIGHT[b.color]);   // de menos a más grave
    // La zona base en `at: 0` no debe borrar una alerta de batería baja.
    if (lows.length) zones.shift();
    if (!zones.length || zones[0].at !== 0) zones.unshift({ at: -Infinity, color: 'cool' });
    return { zones, lows };
}

/**
 * Estado de color de un valor: 'cool' | 'ok' | 'warn' | 'bad'.
 * `alertSeverity` (de las alertas ya activas) puede empeorar el resultado.
 */
export function sensorZone(name, value, config = {}, alertSeverity) {
    let zone = BASE[name] ? 'ok' : 'cool';
    if (typeof value === 'number' && Number.isFinite(value) && BASE[name]) {
        const { zones, lows } = sensorZones(name, config);
        for (const z of lows) {
            if (value < z.low) zone = z.color;    // la última que coincida es la más grave
        }
        if (zone === 'ok' || zone === 'cool') {
            zone = 'cool';
            for (const z of zones) if (value >= z.at) zone = z.color;
        }
    }
    const byAlert = { info: 'ok', warning: 'warn', critical: 'bad' }[alertSeverity];
    return byAlert && WEIGHT[byAlert] > WEIGHT[zone] ? byAlert : zone;
}

/** ¿Debe dibujarse en la gráfica? El estado del motor es texto, no numérico. */
export const isGraphable = (field) => field.name !== 'Engine State' && meta(field.name).max != null;

/** Etiqueta corta para la leyenda de la gráfica. */
export const shortLabel = (name) => meta(name).label || name;
