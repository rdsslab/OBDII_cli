/**
 * Trip log ("Registro de viaje"): records every live sample, the GPS fix
 * (when the platform has one) and session events (alerts, DTCs, link
 * lost/back, connection changes) as compact records, and exports them to CSV.
 *
 * Storage is up to each app (a JSONL file on the server, IndexedDB in the
 * PWA): TripRecorder only produces records through `sink(record)`.
 *
 * Records:
 *   {k:'m', t, v:1, meta}                         start (meta: rate, profile, …)
 *   {k:'u', t, units:{name: unit}}                newly seen fields, appended to the column list
 *   {k:'s', t, v:[values], raw, g?}               live sample (+ GPS fix); v follows the column
 *                                                 list built from the 'u' records (compact)
 *   {k:'e', t, ev, sev?, msg}                     event
 *   {k:'x', t, summary}                           stop (missing if interrupted)
 *
 * Coordinates are stored only when includeCoords is set (privacy).
 */

export const TRIP_RATES = { all: 0, '1s': 1000 };
const GPS_MAX_AGE_MS = 3000;
const RATE_JITTER_MS = 50;

export const EVENT_TEXT = {
    start: 'inicio', stop: 'fin', alert: 'alerta', 'alert-clear': 'alerta despejada',
    dtcs: 'códigos', 'link-lost': 'comunicación perdida', 'link-ok': 'comunicación recuperada',
    state: 'estado', warn: 'aviso', gps: 'gps', note: 'nota',
};

export class TripRecorder {
    /**
     * @param {object} o
     * @param {(record:object)=>void} o.sink
     * @param {'all'|'1s'} [o.rate]
     * @param {boolean} [o.includeCoords]
     */
    constructor({ sink, rate = 'all', includeCoords = false } = {}) {
        if (typeof sink !== 'function') throw new Error('TripRecorder needs a sink');
        this.sink = sink;
        this.rate = TRIP_RATES[rate] != null ? rate : 'all';
        this.includeCoords = !!includeCoords;
        this.recording = false;
        this._reset();
    }

    _reset() {
        this.startedAt = null;
        this.samples = 0;
        this.events = 0;
        this.gpsSamples = 0;
        this._cols = new Map();      // name -> column index
        this._lastKept = -Infinity;
        this._gps = null;
        this._dtcKey = null;
    }

    _emit(rec) { this.sink(rec); }

    start(meta = {}, t = Date.now()) {
        if (this.recording) return;
        this._reset();
        this.recording = true;
        this.startedAt = t;
        this._emit({ k: 'm', t, v: 1, meta: { ...meta, rate: this.rate, includeCoords: this.includeCoords } });
        this.event('start', `Grabación iniciada (${this.rate === 'all' ? 'todas las muestras' : '1 muestra por segundo'})`, null, t);
    }

    stop(t = Date.now()) {
        if (!this.recording) return null;
        this.event('stop', 'Grabación detenida', null, t);
        const summary = this.status(t);
        this._emit({ k: 'x', t, summary });
        this.recording = false;
        return summary;
    }

    status(t = Date.now()) {
        return {
            recording: this.recording,
            startedAt: this.startedAt,
            durationS: this.startedAt ? Math.round((t - this.startedAt) / 1000) : 0,
            samples: this.samples,
            events: this.events,
            gpsSamples: this.gpsSamples,
            rate: this.rate,
        };
    }

    /** Latest GPS fix (GeolocationPosition-like). Attached to the next samples. */
    gps(pos) {
        if (!pos?.coords) return;
        const c = pos.coords;
        const g = {
            t: pos.timestamp ?? Date.now(),
            kmh: c.speed == null || Number.isNaN(c.speed) ? null : Math.round(c.speed * 3.6 * 10) / 10,
            acc: c.accuracy == null ? null : Math.round(c.accuracy * 10) / 10,
            hdg: c.heading == null || Number.isNaN(c.heading) ? null : Math.round(c.heading),
            alt: c.altitude == null ? null : Math.round(c.altitude * 10) / 10,
        };
        if (this.includeCoords) { g.lat = c.latitude; g.lon = c.longitude; }
        this._gps = g;
    }

    /** A live sample {t, fields:[{name, value, unit}], raw}. */
    sample(s) {
        if (!this.recording || !s?.fields?.length) return false;
        const t = s.t ?? Date.now();
        const minGap = TRIP_RATES[this.rate];
        if (minGap && t - this._lastKept < minGap - RATE_JITTER_MS) return false;
        this._lastKept = t;

        const fresh = {};
        for (const f of s.fields) {
            if (!this._cols.has(f.name)) { this._cols.set(f.name, this._cols.size); fresh[f.name] = f.unit || ''; }
        }
        if (Object.keys(fresh).length) this._emit({ k: 'u', t, units: fresh });

        const v = new Array(this._cols.size).fill(null);
        for (const f of s.fields) v[this._cols.get(f.name)] = f.value ?? null;
        const rec = { k: 's', t, v };
        if (s.raw) rec.raw = s.raw;
        if (this._gps && Math.abs(t - this._gps.t) <= GPS_MAX_AGE_MS) { rec.g = this._gps; this.gpsSamples++; }
        this._emit(rec);
        this.samples++;
        return true;
    }

    event(ev, msg, sev = null, t = Date.now()) {
        if (!this.recording) return;
        const rec = { k: 'e', t, ev, msg: String(msg ?? '') };
        if (sev) rec.sev = sev;
        this._emit(rec);
        this.events++;
    }

    /** DTC read result: logged only when the set of codes changes. */
    dtcs(result, t = Date.now()) {
        const codes = (result?.dtcs || []).map(d => d.code || d);
        const key = codes.slice().sort().join(',');
        if (key === this._dtcKey) return;
        this._dtcKey = key;
        this.event('dtcs', codes.length ? codes.join(', ') : 'sin códigos', null, result?.t ?? t);
    }
}

/** Parse JSONL text, skipping a truncated/corrupt line (e.g. after a crash). */
export function parseTripJsonl(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* ignore */ }
    }
    return out;
}

/** Summary from records (works for interrupted logs without a 'x' record). */
export function tripSummary(records) {
    const meta = records.find(r => r.k === 'm');
    const end = records.find(r => r.k === 'x');
    const ts = records.map(r => r.t).filter(Number.isFinite);
    const startedAt = meta?.t ?? (ts.length ? Math.min(...ts) : null);
    const endedAt = ts.length ? Math.max(...ts) : null;
    return {
        meta: meta?.meta || {},
        startedAt,
        endedAt,
        durationS: startedAt != null && endedAt != null ? Math.round((endedAt - startedAt) / 1000) : 0,
        samples: records.filter(r => r.k === 's').length,
        events: records.filter(r => r.k === 'e').length,
        gpsSamples: records.filter(r => r.k === 's' && r.g).length,
        complete: !!end,
    };
}

/**
 * CSV: one row per sample or event. Sensor columns are the union of every
 * field seen, in order of appearance, with units.
 */
export function tripToCSV(records, extraMeta = {}) {
    const s = tripSummary(records);
    const units = {};
    const names = [];
    for (const r of records) {
        if (r.k === 'u') for (const [n, u] of Object.entries(r.units)) if (!(n in units)) { units[n] = u; names.push(n); }
        if (r.k === 's' && r.f) for (const n of Object.keys(r.f)) if (!(n in units)) { units[n] = ''; names.push(n); }
    }
    // sample values by name: 'v' arrays follow the order of the 'u' records
    const colIdx = new Map(names.map((n, i) => [n, i]));
    const valueOf = (r, n) => (r.f ? r.f[n] : r.v?.[colIdx.get(n)]);
    const coords = !!s.meta.includeCoords || records.some(r => r.g && r.g.lat != null);
    const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : '');
    const head = [
        '# Registro de viaje OBD2',
        `# generado: ${new Date().toISOString()}`,
        ...Object.entries({ ...s.meta, ...extraMeta })
            .filter(([k, v]) => v != null && v !== '' && k !== 'includeCoords' && k !== 'rate')
            .map(([k, v]) => `# ${k}: ${v}`),
        `# muestreo: ${s.meta.rate === '1s' ? '1 muestra por segundo' : 'todas las muestras'}`,
        `# inicio: ${iso(s.startedAt)}  fin: ${iso(s.endedAt)}  duración: ${s.durationS} s${s.complete ? '' : '  (interrumpida: sin cierre)'}`,
        `# muestras: ${s.samples}  con GPS: ${s.gpsSamples}  eventos: ${s.events}`,
        '# tipo: muestra = lectura de sensores; evento = alerta, códigos, conexión, inicio/fin',
    ];
    const cols = ['time_iso', 'tipo', 'evento', 'detalle',
        ...names.map(n => (units[n] && units[n] !== 'raw' ? `${n} (${units[n]})` : n)),
        'gps_kmh', 'gps_precision_m', 'gps_rumbo', 'gps_altitud_m', ...(coords ? ['lat', 'lon'] : []), 'raw_hex'];
    const q = (x) => (x == null || x === '' ? '' : typeof x === 'number' ? String(x) : `"${String(x).replace(/"/g, '""')}"`);
    const lines = [];
    for (const r of records) {
        if (r.k === 's') {
            const g = r.g || {};
            lines.push([iso(r.t), 'muestra', '', '', ...names.map(n => valueOf(r, n)),
                g.kmh, g.acc, g.hdg, g.alt, ...(coords ? [g.lat, g.lon] : []), r.raw].map(q).join(','));
        } else if (r.k === 'e') {
            const label = EVENT_TEXT[r.ev] || r.ev;
            lines.push([iso(r.t), 'evento', r.sev ? `${label} (${r.sev})` : label, r.msg,
                ...names.map(() => ''), '', '', '', '', ...(coords ? ['', ''] : []), ''].map(q).join(','));
        }
    }
    return [...head, cols.map(q).join(','), ...lines].join('\n');
}

/** File-name friendly id from a timestamp: trip_2026-11-20_07-15-03 */
export function tripIdFor(t = Date.now()) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `trip_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * Wire a recorder to an ObdSession-like emitter ('live', 'dtcs', 'ecu-link',
 * 'state', 'log') and optionally an AlertEngine. Returns an unsubscribe-less
 * handle (the listeners just do nothing while not recording).
 */
export function attachTripRecorder(recorder, { session, alerts } = {}) {
    let lastStatus = session?.state?.status ?? null;
    session?.on('live', (s) => recorder.sample(s));
    session?.on('dtcs', (d) => recorder.dtcs(d));
    session?.on('ecu-link', (l) => recorder.event(l.ok ? 'link-ok' : 'link-lost', l.ok ? 'Comunicación con la ECU recuperada' : 'Sin respuesta de la ECU', l.ok ? null : 'warning', l.t));
    session?.on('state', (st) => {
        const status = st?.status;
        if (status && status !== lastStatus) {
            recorder.event('state', `${status}${st.error ? `: ${st.error}` : ''}`);
            lastStatus = status;
        }
    });
    session?.on('log', (e) => { if (e.level === 'warn' || e.level === 'error') recorder.event('warn', e.msg, null, e.t); });
    alerts?.on((ev) => {
        if (ev.type === 'raise') recorder.event('alert', `${ev.title}. ${ev.message}`, ev.severity);
        else if (ev.type === 'clear') recorder.event('alert-clear', ev.title, ev.severity);
    });
}
