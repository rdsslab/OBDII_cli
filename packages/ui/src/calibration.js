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
        const row = {
            t,
            ecuAgeMs: t - s.t,
            gpsKmh: c.speed == null ? null : c.speed * 3.6,
            gpsCalcKmh: calcKmh,
            accuracy: c.accuracy ?? null,
            heading: c.heading ?? null,
            ecuKmh: val(SPEED_FIELD),
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

    summary() {
        const v = this.validRows();
        const gps = v.map(r => SpeedCalibrator.gpsOf(r));
        const fit = linearFit(v.map(r => r.ecuRaw), gps);
        const decoded = v.filter(r => typeof r.ecuKmh === 'number' && r.ecuKmh > 0);
        const meanRatio = decoded.length ? decoded.reduce((s, r) => s + SpeedCalibrator.gpsOf(r) / r.ecuKmh, 0) / decoded.length : null;

        // Which raw byte (u8) or byte pair (le16) tracks GPS speed best?
        const candidates = [];
        if (v.length >= 10) {
            const bytes = v.map(r => r.raw.split(' ').map(h => parseInt(h, 16)));
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
            durationS: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
            fit,              // gps_kmh = a · raw + b
            meanRatio,        // gps / decoded ECU speed
            candidates: candidates.slice(0, 5),
        };
    }

    toCSV(meta = {}) {
        const s = this.summary();
        const head = [
            '# Calibración de velocidad: ECU vs GPS',
            `# generado: ${new Date().toISOString()}`,
            ...Object.entries(meta).map(([k, v]) => `# ${k}: ${v}`),
            `# puntos: ${s.points}, válidos (precisión <= 20 m, >= 5 km/h): ${s.valid}`,
            '# velocidad GPS: la del dispositivo (gps_kmh) o, si falta, la calculada entre posiciones (gps_calc_kmh)',
            s.fit ? `# ajuste: gps_kmh = ${s.fit.a.toFixed(4)} * byte${SPEED_BYTE} + ${s.fit.b.toFixed(2)}  (r² = ${s.fit.r2.toFixed(3)}, proporción por el origen = ${s.fit.ratio?.toFixed(4)})` : '# ajuste: datos insuficientes',
            s.meanRatio ? `# proporción media gps / velocidad ECU actual: ${s.meanRatio.toFixed(3)}` : '# proporción media: sin datos',
            ...s.candidates.map(c => `# candidato: ${c.kind} byte ${c.index}  r = ${c.r.toFixed(3)}`),
        ];
        const cols = ['time_iso', 'ecu_age_ms', 'gps_kmh', 'gps_calc_kmh', 'gps_accuracy_m', 'gps_heading', 'ecu_kmh', `ecu_raw_byte${SPEED_BYTE}`,
            'rpm', 'throttle_pct', 'engine_state', ...(this.includeCoords ? ['lat', 'lon'] : []), 'raw_2101_hex'];
        const q = (x) => x == null ? '' : typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(3)) : `"${String(x).replace(/"/g, '""')}"`;
        const lines = this.rows.map(r => [new Date(r.t).toISOString(), r.ecuAgeMs, r.gpsKmh, r.gpsCalcKmh, r.accuracy, r.heading, r.ecuKmh, r.ecuRaw,
            r.rpm, r.throttle, r.state, ...(this.includeCoords ? [r.lat, r.lon] : []), r.raw].map(q).join(','));
        return [...head, cols.join(','), ...lines].join('\n');
    }
}
