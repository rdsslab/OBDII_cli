/**
 * Speed calibration math: pairing, filtering, fit, candidate-byte search, CSV.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeedCalibrator, linearFit, haversineM, SPEED_BYTE } from '../src/calibration.js';

const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
/** 78-byte block where byte 18 = decodedSpeed and byte 40 = trueSpeed*2 (the "real" one). */
function sample(t, ecuSpeed, trueKmh) {
    const b = new Array(78).fill(0);
    b[SPEED_BYTE] = ecuSpeed;
    b[40] = Math.round(trueKmh * 2);
    b[3] = 180;
    return {
        t,
        raw: b.map(hex).join(' '),
        fields: [{ name: 'Vehicle Speed (ECU)', value: ecuSpeed }, { name: 'Engine RPM', value: 2000 }, { name: 'Engine State', value: 'carga parcial' }],
    };
}
const fix = (t, kmh, accuracy = 5, lat = 10.5, lon = 20.5) => ({ timestamp: t, coords: { speed: kmh / 3.6, accuracy, heading: 90, latitude: lat, longitude: lon } });

test('linearFit and haversine', () => {
    const f = linearFit([1, 2, 3, 4], [3, 5, 7, 9]);
    assert.ok(Math.abs(f.a - 2) < 1e-9 && Math.abs(f.b - 1) < 1e-9 && Math.abs(f.r2 - 1) < 1e-9);
    assert.ok(Math.abs(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }) - 111.2) < 1);
    assert.equal(linearFit([1], [1]), null);
});

test('pairs fixes with fresh samples only; filters bad GPS; finds the better byte', () => {
    const cal = new SpeedCalibrator();
    cal.start();
    let t = 1_000_000;
    // stale sample: no pairing
    cal.addSample(sample(t - 5000, 10, 10));
    assert.equal(cal.addFix(fix(t, 10)), null);
    // driving: ECU byte 18 reads ~70 % of true speed and is noisy; byte 40 = 2x true
    for (let i = 0; i < 40; i++) {
        t += 1000;
        const trueKmh = 10 + i * 1.5;
        const noisy = Math.max(0, Math.round(trueKmh * 0.7 + ((i % 5) - 2) * 3));
        cal.addSample(sample(t - 200, noisy, trueKmh));
        cal.addFix(fix(t, trueKmh, i === 7 ? 80 : 5));       // one fix with poor accuracy
    }
    const s = cal.summary();
    assert.equal(s.points, 40);
    assert.equal(s.valid, 39, 'poor-accuracy fix excluded');
    assert.ok(s.fit.a > 1.2 && s.fit.a < 1.6, `fit a=${s.fit.a}`);
    assert.ok(s.meanRatio > 1.2, `ratio ${s.meanRatio}`);
    assert.equal(s.candidates[0].index, 40, JSON.stringify(s.candidates[0]));
    assert.ok(Math.abs(s.candidates[0].r) > 0.99);

    const csv = cal.toCSV({ perfil: 'SIM2K-33' });
    assert.match(csv, /# ajuste \(estable, sin atípicos\): gps_kmh = /);
    assert.match(csv, /# candidato: u8 byte 40/);
    assert.ok(!/lat|lon/.test(csv.split('\n').find(l => l.startsWith('time_iso'))), 'no coordinates by default');
    assert.equal(csv.trim().split('\n').filter(l => /^"\d{4}-/.test(l)).length, 40);
});

test('coordinates only when enabled', () => {
    const cal = new SpeedCalibrator({ includeCoords: true });
    cal.start();
    cal.addSample(sample(1000, 20, 20));
    cal.addFix(fix(1100, 20));
    assert.match(cal.toCSV().split('\n').find(l => l.startsWith('time_iso')), /,lat,lon,/);
});

test('falls back to the speed computed from positions when the device reports none', () => {
    const cal = new SpeedCalibrator();
    cal.start();
    let t = 1_000_000, lon = 20.5;
    for (let i = 0; i < 12; i++) {
        t += 1000; lon += 0.0001;                       // ~40 km/h
        cal.addSample(sample(t - 100, 28, 40));
        cal.addFix({ timestamp: t, coords: { speed: null, accuracy: 5, heading: null, latitude: 10.5, longitude: lon } });
    }
    const s = cal.summary();
    assert.equal(s.valid, 11, 'first fix has no previous position');
    assert.ok(Math.abs(s.meanRatio - 40 / 28) < 0.05, `ratio ${s.meanRatio}`);
});

test('robust fit ignores speed spikes and acceleration lag (drive of 2026-11-20 pattern)', () => {
    const cal = new SpeedCalibrator();
    cal.start();
    let t = 2_000_000;
    // cruise around 15–40 km/h, ECU = GPS (scale 1), one upward spike every ~12 points
    const profile = [];
    for (let i = 0; i < 120; i++) profile.push(25 + 13 * Math.sin(i / 15));
    profile.forEach((g, i) => {
        t += 1000;
        let ecu = Math.round(g);
        if (i % 12 === 5) ecu = Math.round(g * 1.8);            // P0501 spike
        cal.addSample(sample(t - 300, ecu, g));
        cal.addFix(fix(t, g, 3));
    });
    const s = cal.summary();
    assert.ok(s.outliers >= 8, `outliers ${s.outliers}`);
    assert.ok(Math.abs(s.fit.a - 1) < 0.05, `robust a=${s.fit.a}`);
    assert.ok(s.fit.r2 > 0.98, `r2=${s.fit.r2}`);
    assert.ok(s.fitAll.a < 0.9, `naive fit is dragged down: ${s.fitAll.a}`);
    assert.ok(Math.abs(s.meanRatio - 1) < 0.05, `ratio ${s.meanRatio}`);
    const csv = cal.toCSV();
    assert.match(csv, /# ajuste \(estable, sin atípicos\): gps_kmh = 0\.9|# ajuste \(estable, sin atípicos\): gps_kmh = 1\.0/);
    assert.match(csv, /atípicos descartados: \d+/);
});

test('calibration CSV keeps the ECU speed as sent, with the spike flag', () => {
    const cal = new SpeedCalibrator();
    cal.start();
    const s = sample(1000, 33, 37);
    s.fields[0] = { name: 'Vehicle Speed (ECU)', value: 33, rawValue: 71 };   // spike held by the session filter
    cal.addSample(s);
    cal.addFix(fix(1100, 37));
    const csv = cal.toCSV();
    const header = csv.split('\n').find(l => l.startsWith('time_iso'));
    assert.match(header, /ecu_kmh,ecu_kmh_pantalla,pico_velocidad,ecu_raw_byte18/);
    const row = csv.split('\n').find(l => l.startsWith('"'));
    assert.match(row, /,71,33,1,/);
    assert.match(csv, /# picos de velocidad del sensor \(P0501\): 1/);
});
