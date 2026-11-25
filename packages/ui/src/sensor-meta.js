/**
 * Orden, visibilidad, escalas y zonas de color de los sensores en tiempo real.
 *
 * `SENSOR_ORDER` es la prioridad de la pantalla (velocidad, RPM, temperatura,
 * batería, acelerador, estado del motor y, después, el resto). Los nombres son
 * los que emite @obdii/core; un mismo sensor lógico puede tener varios nombres
 * según el protocolo (KWP2000 vs OBD2 estándar).
 *
 * Las zonas se evalúan acumulando severidad: `warn` gana a `ok` y `bad` gana a
 * `warn`, tanto por encima de un umbral como por debajo (`lows`, p. ej. batería
 * o nivel de combustible). Los umbrales de «Ajustes → Alertas» se fusionan con
 * los del sensor, sin poder suavizar una alerta crítica activa.
 */
import { sensorLabel } from './labels.js';
import {
    SENSOR_ORDER, isVisible, loadDisplayConfig, prefsFor, rangeFor, sensorKey,
} from './display-config.js';

export { SENSOR_ORDER, isVisible, rangeFor, sensorKey };

const RANK = new Map();
SENSOR_ORDER.forEach((names, i) => names.forEach(n => RANK.set(n, i)));

/** Prioridad de un campo: 0 = primero. Los desconocidos van al final. */
export const sensorRank = (name) => RANK.has(name) ? RANK.get(name) : SENSOR_ORDER.length;

export const sortFields = (fields) => [...fields].sort((a, b) =>
    sensorRank(a.name) - sensorRank(b.name) || String(a.name).localeCompare(String(b.name)));

/** Alertas del core que también aportan umbrales al color de cada sensor. */
const ALERTS = {
    rpm: { warn: ['overRev', 'rpm'] },
    coolant: { warn: ['overheat', 'warn'], bad: ['overheat', 'crit'] },
    voltage: {
        warn: ['overVoltage', 'maxV'], bad: ['overVoltage', 'critV'],
        badLow: ['lowBattery', 'critV'], warnLow: [['lowBattery', 'warnV'], ['noCharge', 'minV']],
    },
};

const WEIGHT = { cool: 0, ok: 1, warn: 2, bad: 3 };
const cfgValue = (config, id, key) => Number(config?.[id]?.[key]);

/**
 * Zonas efectivas: preferencias del sensor + umbrales configurados en Alertas.
 * Devuelve `{ zones }` (por encima) y `{ lows }` (por debajo), ambos ordenados.
 */
export function sensorZones(name, config = {}, display = loadDisplayConfig()) {
    const p = prefsFor(name, display);
    if (!Number.isFinite(p.min) || !Number.isFinite(p.max)) return { zones: [], lows: [] };

    const zones = [{ at: p.min, color: 'cool' }];
    if (Number.isFinite(p.ok)) zones.push({ at: p.ok, color: 'ok' });
    if (Number.isFinite(p.warn)) zones.push({ at: p.warn, color: 'warn' });
    if (Number.isFinite(p.bad)) zones.push({ at: p.bad, color: 'bad' });
    const lows = [];
    if (Number.isFinite(p.lowWarn)) lows.push({ low: p.lowWarn, color: 'warn' });
    if (Number.isFinite(p.lowBad)) lows.push({ low: p.lowBad, color: 'bad' });

    const setZone = (arr, prop, value, color) => {
        if (!Number.isFinite(value)) return;
        const i = arr.findIndex(z => Math.abs(z[prop] - value) < 0.001);
        if (i < 0) arr.push({ [prop]: value, color });
        else if (WEIGHT[color] > WEIGHT[arr[i].color]) arr[i] = { [prop]: value, color };
    };
    const apply = (ref, prop, color) => {
        if (!ref) return;
        const arr = prop === 'at' ? zones : lows;
        if (Array.isArray(ref[0])) ref.forEach(([id, key]) => setZone(arr, prop, cfgValue(config, id, key), color));
        else setZone(arr, prop, cfgValue(config, ref[0], ref[1]), color);
    };
    const alerts = ALERTS[sensorKey(name)] || {};
    apply(alerts.warn, 'at', 'warn');
    apply(alerts.bad, 'at', 'bad');
    apply(alerts.warnLow, 'low', 'warn');
    apply(alerts.badLow, 'low', 'bad');

    zones.sort((a, b) => a.at - b.at);
    lows.sort((a, b) => WEIGHT[b.color] - WEIGHT[a.color]);   // primero el más grave
    return { zones, lows };
}

/**
 * Estado de color de un valor: 'cool' | 'ok' | 'warn' | 'bad'.
 * `alertSeverity` (de las alertas ya activas) puede empeorar el resultado.
 */
export function sensorZone(name, value, config = {}, displayOrSeverity = loadDisplayConfig(), severityArg) {
    // Compatible with the old signature sensorZone(name, value, config, severity).
    const legacySeverity = typeof displayOrSeverity === 'string';
    const display = legacySeverity || !displayOrSeverity ? loadDisplayConfig() : displayOrSeverity;
    const alertSeverity = legacySeverity ? displayOrSeverity : severityArg;
    let zone = sensorKey(name) && rangeFor(name, display) ? 'cool' : 'ok';
    if (typeof value === 'number' && Number.isFinite(value)) {
        const { zones, lows } = sensorZones(name, config, display);
        for (const z of lows) if (value < z.low && WEIGHT[z.color] > WEIGHT[zone]) zone = z.color;
        for (const z of zones) if (value >= z.at && WEIGHT[z.color] > WEIGHT[zone]) zone = z.color;
    }
    const byAlert = { info: 'ok', warning: 'warn', critical: 'bad' }[alertSeverity];
    return byAlert && WEIGHT[byAlert] > WEIGHT[zone] ? byAlert : zone;
}

/** ¿Debe dibujarse en la gráfica? El estado del motor es texto, no numérico. */
export const isGraphable = (field, display = loadDisplayConfig()) => {
    const name = typeof field === 'string' ? field : field?.name;
    return name !== 'Engine State' && !!rangeFor(name, display) && rangeFor(name, display).max > rangeFor(name, display).min;
};

/** Etiqueta corta para la leyenda de la gráfica, en el idioma activo. */
export const shortLabel = (name) => sensorLabel(name);
