/**
 * Vehicle speed spike filter.
 *
 * The SIM2K-33 speed byte (2101 data 18) is right in scale (GPS check
 * 2026-11-20: ratio ≈ 1.00 between 15 and 40 km/h) but sometimes jumps UP
 * to 1.4–2× the real speed for about a second (e.g. 37 → 71 → 35 km/h),
 * consistent with the stored DTC P0501 (extra VSS pulses). No car gains
 * 30 km/h in one second, so a rise faster than the plausible acceleration
 * is held at the last good value until it either goes away or persists.
 *
 * Drops are always accepted (hard braking is real); only rises are checked.
 */

export const SPEED_FIELD = 'Vehicle Speed (ECU)';

export class SpeedSpikeFilter {
    /**
     * @param {object} [o]
     * @param {number} [o.maxRiseKmhPerS=5] - plausible acceleration (this van: ~0–40 km/h in 8 s)
     * @param {number} [o.marginKmh=3] - allowance for 1 km/h resolution and read jitter
     * @param {number} [o.holdMaxMs=3000] - a rise that lasts longer than this is real
     */
    constructor({ maxRiseKmhPerS = 5, marginKmh = 3, holdMaxMs = 3000 } = {}) {
        this.maxRise = maxRiseKmhPerS;
        this.margin = marginKmh;
        this.holdMaxMs = holdMaxMs;
        this.reset();
    }

    reset() {
        this.good = null;        // {v, t} last accepted value
        this.spikes = 0;
    }

    /**
     * @returns {{value:number, spike:boolean}} value to show (held during a spike)
     */
    filter(v, t) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return { value: v, spike: false };
        const g = this.good;
        if (!g || t < g.t || v <= g.v) {
            this.good = { v, t };
            return { value: v, spike: false };
        }
        const dt = (t - g.t) / 1000;
        const limit = this.maxRise * dt + this.margin;
        if (v - g.v <= limit || t - g.t > this.holdMaxMs) {
            this.good = { v, t };
            return { value: v, spike: false };
        }
        this.spikes++;
        return { value: g.v, spike: true };
    }

    /**
     * Apply to a live sample in place: the speed field gets the filtered
     * value and, on a spike, `rawValue` with what the ECU sent (the raw 2101
     * hex in the sample keeps the original byte as well).
     * @returns {null | {raw:number, shown:number}} the spike, if any
     */
    apply(sample, t = Date.now()) {
        const f = sample?.fields?.find(x => x.name === SPEED_FIELD);
        if (!f) return null;
        const r = this.filter(f.value, t);
        if (!r.spike) return null;
        const raw = f.value;
        f.rawValue = raw;
        f.value = r.value;
        return { raw, shown: r.value };
    }
}
