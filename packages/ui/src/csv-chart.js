/**
 * Read a trip CSV (the format exported by "Grabar") into chart samples.
 * Pure module: no DOM, no fetch; also used by the unit tests.
 *
 * Comments (#) and event rows are ignored. Sensor columns keep the names used
 * by @obdii/core (with an optional " (unit)" suffix), so values land on the
 * same tiles/charts as live data.
 */
import { SENSOR_GROUPS } from './display-config.js';
import { SPEED_FIELDS, GPS_MIN_KMH } from './gps-speed.js';

const KNOWN = SENSOR_GROUPS.flatMap(g => g.names).sort((a, b) => b.length - a.length);
const SHOWN_SPEED = 'Vehicle Speed (pantalla, filtrada)';
const TIME_COLS = ['time_iso', 'time', 'timestamp', 't_ms'];

/** CSV line with quoted fields (doubled quotes) -> array of strings. */
export function splitCsvLine(line) {
    const out = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
            else quoted = !quoted;
        } else if (ch === ',' && !quoted) {
            out.push(cell);
            cell = '';
        } else cell += ch;
    }
    out.push(cell);
    return out.map(s => s.trim());
}

/** Header cell -> { name, unit } if it belongs to a known sensor. */
export function sensorColumn(header) {
    const text = header.replace(/^\ufeff/, '').trim();
    // The trip CSV keeps both the raw ECU speed and the filtered "shown" one.
    // Plot the filtered value: it is what the driver actually saw on screen.
    if (text.startsWith(SHOWN_SPEED)) {
        const i = text.lastIndexOf(' (');
        return { name: SPEED_FIELDS[0], unit: i > 0 && text.endsWith(')') ? text.slice(i + 2, -1) : '', shown: true };
    }
    for (const name of KNOWN) {
        if (text === name) return { name, unit: '' };
        if (text.startsWith(`${name} (`) && text.endsWith(')')) return { name, unit: text.slice(name.length + 2, -1) };
    }
    return null;
}

/**
 * @returns {{samples: Array<{t:number, fields:Array<{name:string,value:number,unit:string}>}>, count:number, start:number|null, end:number|null}}
 */
export function parseTripCsv(text) {
    const lines = String(text || '').replace(/^\ufeff/, '').split(/\r?\n/);
    const rows = lines.filter(l => l.trim() && !l.trimStart().startsWith('#'));
    if (!rows.length) return { samples: [], count: 0, start: null, end: null };

    const head = splitCsvLine(rows[0]);
    const timeCol = head.findIndex(h => TIME_COLS.includes(h));
    const relativeTime = timeCol >= 0 && head[timeCol] === 't_ms';
    const baseT = Date.now();
    const typeCol = head.findIndex(h => h === 'tipo' || h === 'type');
    const gpsCol = head.findIndex(h => h === 'gps_kmh' || h === 'gps_kph');
    const cols = head.map((h, i) => ({ ...(sensorColumn(h) || {}), i })).filter(c => c.name);
    if (!cols.length) return { samples: [], count: 0, start: null, end: null };

    const samples = [];
    let fallbackT = 0;
    for (const line of rows.slice(1)) {
        const cells = splitCsvLine(line);
        if (typeCol >= 0 && cells[typeCol] && cells[typeCol] !== 'muestra' && cells[typeCol] !== 'sample') continue;
        const byName = new Map();
        for (const c of cols) {
            const raw = cells[c.i];
            if (raw == null || raw === '') continue;
            const value = Number(raw);
            if (!Number.isFinite(value)) continue;
            const prev = byName.get(c.name);
            if (!prev || c.shown) byName.set(c.name, { name: c.name, value, unit: c.unit });
        }
        const fields = [...byName.values()];
        // Same rule as in live data: 0/missing ECU speed + a fast GPS fix -> GPS.
        const speed = fields.find(f => SPEED_FIELDS.includes(f.name));
        if (!speed || speed.value <= 0) {
            const gps = gpsCol >= 0 ? Number(cells[gpsCol]) : NaN;
            if (Number.isFinite(gps) && gps >= GPS_MIN_KMH) {
                if (speed) speed.value = gps;
                else fields.push({ name: SPEED_FIELDS[0], value: gps, unit: 'km/h' });
                (speed || fields[fields.length - 1]).source = 'gps';
            }
        }
        if (!fields.length) continue;
        const parsed = timeCol >= 0 ? Date.parse(cells[timeCol]) : NaN;
        const rel = relativeTime ? Number(cells[timeCol]) : NaN;
        const t = Number.isFinite(rel) ? baseT + rel : Number.isFinite(parsed) ? parsed : (fallbackT += 1000);
        samples.push({ t, fields });
    }
    return {
        samples,
        count: samples.length,
        start: samples.length ? samples[0].t : null,
        end: samples.length ? samples[samples.length - 1].t : null,
    };
}
