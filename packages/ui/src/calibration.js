/**
 * Speed calibration: ECU vehicle speed vs GPS speed (phone PWA).
 *
 * Each GPS fix is paired with the most recent live sample (if fresh), and
 * every pair keeps the full raw 2101 block, so the file can later be used to
 * (a) fit the scale of the current speed byte and (b) look for a better
 * byte, since the current speed reading is suspect (P0501, erratic).
 *
 * Coordinates are NOT recorded unless explicitly enabled (privacy): speed,
 * accuracy and heading are enough for calibration.
 */

export const SPEED_FIELD = 'Vehicle Speed (ECU)';
export const SPEED_BYTE = 18;             // data index in block 2101 (ecu-profiles.js)
const MAX_PAIR_AGE_MS = 1500;

const R_EARTH = 6371000;
const toRad = (d) => d * Math.PI / 180;
export function haversineM(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/** Least squares y = a·x + b, plus through-origin ratio and r². */
export function linearFit(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let sxx = 0, sxy = 0, syy = 0, sxo = 0, sxyo = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = ys[i] - my;
        sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
        sxo += xs[i] * xs[i]; sxyo += xs[i] * ys[i];
    }
    if (sxx === 0) return null;
    const a = sxy / sxx;
    const b = my - a * mx;
    const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
    return { a, b, r2, ratio: sxo ? sxyo / sxo : null, n };
}

const pearson = (xs, ys) => {
    const f = linearFit(xs, ys);
    return f ? Math.sign(f.a) * Math.sqrt(f.r2) : 0;
};

const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Fit that ignores outliers such as the P0501 speed spikes. A plain
 * least-squares start would be dragged by the spikes themselves, so it
 * starts from the median of y/x (spikes barely move a median), drops points
 * whose residual is far from the rest (median absolute deviation) and
 * refits on what is left, twice.
 * @returns {{fit, keep: boolean[], outliers: number} | null}
 */
export function robustFit(xs, ys, { minResidual = 3, k = 3, rounds = 2 } = {}) {
    if (!linearFit(xs, ys)) return null;
    const ratios = xs.map((x, i) => (x > 0 ? ys[i] / x : null)).filter(r => r != null);
    let model = { a: ratios.length ? median(ratios) : 1, b: 0 };
    let keep = xs.map(() => true);
    for (let round = 0; round < rounds; round++) {
        const res = xs.map((x, i) => ys[i] - (model.a * x + model.b));
        const mad = median(res.map(r => Math.abs(r - median(res))));
        const limit = Math.max(minResidual, k * 1.4826 * mad);
        keep = res.map(r => Math.abs(r) <= limit);
        const f = linearFit(xs.filter((_, i) => keep[i]), ys.filter((_, i) => keep[i]));
        if (!f) break;
        model = f;
    }
    const fit = model.r2 != null ? model : linearFit(xs, ys);
    return { fit, keep, outliers: keep.filter(k2 => !k2).length };
}

const MAX_GPS_ACCEL = 2.5;      // km/h per second: above this the ECU lag (~0.5–1 s) dominates

export class SpeedCalibrator {
    constructor({ includeCoords = false } = {}) {
        this.includeCoords = includeCoords;
        this.rows = [];
        this.lastSample = null;
        this.lastFix = null;
        this.startedAt = null;
    }

    start() { this.startedAt = Date.now(); this.rows = []; this.lastFix = null; }

    /** Keep the latest live sample ({t, fields, raw}). */
    addSample(sample) { if (sample?.raw) this.lastSample = sample; }

    /**
     * Add a GPS fix (GeolocationPosition-like). Returns the stored row or null.
     */
    addFix(pos) {
        const c = pos.coords;
        const t = pos.timestamp ?? Date.now();
        const fix = { t, lat: c.latitude, lon: c.longitude };
        let calcKmh = null;
        if (this.lastFix && t > this.lastFix.t) {
            calcKmh = haversineM(this.lastFix, fix) / ((t - this.lastFix.t) / 1000) * 3.6;
        }
        this.lastFix = fix;
        const s = this.lastSample;
        if (!s || Math.abs(t - s.t) > MAX_PAIR_AGE_MS) return null;
        const bytes = s.raw.split(' ').map(h => parseInt(h, 16));
        const val = (n) => s.fields.find(f => f.name === n)?.value ?? null;
        const speedField = s.fields.find(f => f.name === SPEED_FIELD);
        const spike = speedField?.rawValue != null;
        const row = {
            t,
            ecuAgeMs: t - s.t,
            gpsKmh: c.speed == null ? null : c.speed * 3.6,
            gpsCalcKmh: calcKmh,
            accuracy: c.accuracy ?? null,
            heading: c.heading ?? null,
            ecuKmh: spike ? speedField.rawValue : val(SPEED_FIELD),   // as sent by the ECU (spikes kept)
            ecuShownKmh: val(SPEED_FIELD),
            spike: spike ? 1 : 0,
            ecuRaw: bytes[SPEED_BYTE] ?? null,
            rpm: val('Engine RPM'),
            throttle: val('Throttle Position'),
            state: val('Engine State'),
            raw: s.raw,
        };
        if (this.includeCoords) { row.lat = c.latitude; row.lon = c.longitude; }
        this.rows.push(row);
        return row;
    }

    /** GPS speed reported by the device, or computed from positions if missing. */
    static gpsOf(r) { return r.gpsKmh ?? r.gpsCalcKmh; }

    /** Rows usable for fitting: good GPS, moving. */
    validRows({ maxAccuracy = 20, minKmh = 5 } = {}) {
        return this.rows.filter(r => {
            const g = SpeedCalibrator.gpsOf(r);
            return g != null && r.ecuRaw != null && (r.accuracy ?? 99) <= maxAccuracy && g >= minKmh;
        });
    }

    /**
     * Valid rows at steady speed: GPS speed changes less than MAX_GPS_ACCEL
     * against the previous fix (within 2.5 s). While accelerating or braking
     * the ECU's ~0.5–1 s lag would look like a scale error.
     */
    steadyRows() {
        const all = this.rows;
        const valid = new Set(this.validRows());
        return all.filter((r, i) => {
            if (!valid.has(r)) return false;
            const p = all[i - 1];
            if (!p || r.t - p.t > 2500 || r.t <= p.t) return true;
            const g0 = SpeedCalibrator.gpsOf(p), g1 = SpeedCalibrator.gpsOf(r);
            if (g0 == null || g1 == null) return true;
            return Math.abs(g1 - g0) / ((r.t - p.t) / 1000) <= MAX_GPS_ACCEL;
        });
    }

    summary() {
        const v = this.validRows();
        const steady = this.steadyRows();
        const gps = steady.map(r => SpeedCalibrator.gpsOf(r));
        // naive fit over every valid point (what earlier versions reported)
        const fitAll = linearFit(v.map(r => r.ecuRaw), v.map(r => SpeedCalibrator.gpsOf(r)));
        // robust fit: steady speed only, spikes / bad points removed
        const rf = robustFit(steady.map(r => r.ecuRaw), gps);
        const fit = rf?.fit ?? null;
        const clean = rf ? steady.filter((_, i) => rf.keep[i]) : steady;
        const decoded = clean.filter(r => typeof r.ecuKmh === 'number' && r.ecuKmh > 0);
        const meanRatio = decoded.length ? decoded.reduce((s, r) => s + SpeedCalibrator.gpsOf(r) / r.ecuKmh, 0) / decoded.length : null;

        // Which raw byte (u8) or byte pair (le16) tracks GPS speed best?
        // (steady rows, spikes included: they count against a candidate)
        const candidates = [];
        if (steady.length >= 10) {
            const bytes = steady.map(r => r.raw.split(' ').map(h => parseInt(h, 16)));
            const len = Math.min(...bytes.map(b => b.length));
            for (let i = 0; i < len; i++) {
                const xs = bytes.map(b => b[i]);
                if (new Set(xs).size > 2) candidates.push({ kind: 'u8', index: i, r: pearson(xs, gps) });
                // le16 only if its low byte varies; otherwise it is just byte i+1 scaled
                if (i + 1 < len && new Set(xs).size > 1) {
                    const xw = bytes.map(b => b[i] | (b[i + 1] << 8));
                    if (new Set(xw).size > 2) candidates.push({ kind: 'le16', index: i, r: pearson(xw, gps) });
                }
            }
            candidates.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
        }
        return {
            points: this.rows.length,
            valid: v.length,
            steady: steady.length,
            outliers: rf?.outliers ?? 0,
            used: clean.length,
            durationS: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
            fit,              // robust: gps_kmh = a · raw + b
            fitAll,           // every valid point, no filtering
            meanRatio,        // gps / decoded ECU speed (clean points)
            candidates: candidates.slice(0, 5),
        };
    }

    toCSV(meta = {}) {
        const s = this.summary();
        const head = [
            '# Calibración de velocidad: ECU vs GPS',
            `# generado: ${new Date().toISOString()}`,
            ...Object.entries(meta).map(([k, v]) => `# ${k}: ${v}`),
            `# puntos: ${s.points}, válidos (precisión <= 20 m, >= 5 km/h): ${s.valid}, a velocidad estable (< ${MAX_GPS_ACCEL} km/h/s): ${s.steady}, atípicos descartados: ${s.outliers}, usados: ${s.used}`,
            '# velocidad GPS: la del dispositivo (gps_kmh) o, si falta, la calculada entre posiciones (gps_calc_kmh)',
            s.fit ? `# ajuste (estable, sin atípicos): gps_kmh = ${s.fit.a.toFixed(4)} * byte${SPEED_BYTE} + ${s.fit.b.toFixed(2)}  (r² = ${s.fit.r2.toFixed(3)}, proporción por el origen = ${s.fit.ratio?.toFixed(4)})` : '# ajuste: datos insuficientes',
            s.fitAll ? `# ajuste sin filtrar (todos los válidos): gps_kmh = ${s.fitAll.a.toFixed(4)} * byte${SPEED_BYTE} + ${s.fitAll.b.toFixed(2)}  (r² = ${s.fitAll.r2.toFixed(3)})` : '# ajuste sin filtrar: datos insuficientes',
            s.meanRatio ? `# proporción media gps / velocidad ECU (puntos usados): ${s.meanRatio.toFixed(3)}` : '# proporción media: sin datos',
            `# picos de velocidad del sensor (P0501): ${this.rows.filter(r => r.spike).length}. ecu_kmh = lo que envió la ECU (con picos); ecu_kmh_pantalla = lo que se vio en pantalla`,
            ...s.candidates.map(c => `# candidato: ${c.kind} byte ${c.index}  r = ${c.r.toFixed(3)}`),
        ];
        const cols = ['time_iso', 'ecu_age_ms', 'gps_kmh', 'gps_calc_kmh', 'gps_accuracy_m', 'gps_heading', 'ecu_kmh', 'ecu_kmh_pantalla', 'pico_velocidad', `ecu_raw_byte${SPEED_BYTE}`,
            'rpm', 'throttle_pct', 'engine_state', ...(this.includeCoords ? ['lat', 'lon'] : []), 'raw_2101_hex'];
        const q = (x) => x == null ? '' : typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(3)) : `"${String(x).replace(/"/g, '""')}"`;
        const lines = this.rows.map(r => [new Date(r.t).toISOString(), r.ecuAgeMs, r.gpsKmh, r.gpsCalcKmh, r.accuracy, r.heading, r.ecuKmh, r.ecuShownKmh, r.spike, r.ecuRaw,
            r.rpm, r.throttle, r.state, ...(this.includeCoords ? [r.lat, r.lon] : []), r.raw].map(q).join(','));
        return [...head, cols.join(','), ...lines].join('\n');
    }
}
