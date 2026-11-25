/**
 * GPS fallback for vehicle speed.
 *
 * Rule agreed for this project: use GPS only when the ECU field is missing or
 * reports 0 and the phone has a fresh fix (>= 5 km/h). The returned fields
 * carry `source: 'gps' | 'ecu'` so the tile and the chart can show a different
 * label/colour. GPS needs a secure context (published PWA/HTTPS or localhost).
 */
export const SPEED_FIELDS = ['Vehicle Speed (ECU)', 'Vehicle Speed'];
export const GPS_MAX_AGE_MS = 3000;
export const GPS_MIN_KMH = 5;

const numberOrNull = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Pure helper. Returns { fields, value, source }: `fields` is a new array with
 * the speed field's value replaced (or added) when GPS must be shown.
 */
export function resolveGpsSpeed(fields = [], fix = null, now = Date.now()) {
    const list = Array.isArray(fields) ? fields : [];
    const index = list.findIndex(f => SPEED_FIELDS.includes(f?.name));
    const ecu = index < 0 ? null : numberOrNull(list[index].value);
    const fresh = fix && now - (fix.t || 0) <= GPS_MAX_AGE_MS;
    const gps = fresh ? numberOrNull(fix.kmh) : null;
    const useGps = gps != null && gps >= GPS_MIN_KMH && (ecu == null || ecu <= 0);

    if (!useGps) return { fields: list, value: ecu, source: 'ecu' };
    const out = list.map(f => ({ ...f }));
    const speed = { name: out[index]?.name || SPEED_FIELDS[0], value: gps, unit: out[index]?.unit || 'km/h', source: 'gps' };
    if (index < 0) out.unshift(speed); else out[index] = speed;
    out.forEach((f, i) => { if (f.source !== 'gps') f.source = 'ecu'; });
    return { fields: out, value: gps, source: 'gps' };
}

/** Browser watcher: listens only while live data runs, to save battery. */
export function startGpsSpeed({ onChange } = {}) {
    const available = typeof window !== 'undefined' && window.isSecureContext && 'geolocation' in navigator;
    let fix = null;
    let watchId = null;

    const stop = () => {
        if (watchId != null) navigator.geolocation.clearWatch(watchId);
        watchId = null;
    };
    const start = () => {
        if (!available || watchId != null) return;
        watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const c = pos.coords || {};
                fix = {
                    t: Date.now(),
                    kmh: c.speed == null || Number.isNaN(c.speed) ? null : Math.round(c.speed * 3.6 * 10) / 10,
                    acc: c.accuracy,
                };
                onChange?.(fix);
            },
            () => { /* no fix: keep the ECU speed */ },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
        );
    };
    return {
        available,
        get fix() { return fix; },
        setRunning(running) { running ? start() : stop(); },
        resolve(sample = {}) { return resolveGpsSpeed(sample.fields || [], fix); },
        stop,
    };
}
