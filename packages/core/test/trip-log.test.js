/**
 * Trip log: records, rate limiting, GPS attachment, events, CSV export.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    TripRecorder, tripToCSV, tripSummary, parseTripJsonl, attachTripRecorder, tripIdFor, AlertEngine,
} from '../src/index.js';

const sample = (t, coolant = 80, rpm = 900, extra = []) => ({
    t, raw: '61 01 AA BB', hz: 4,
    fields: [
        { name: 'Engine RPM', value: rpm, unit: 'rpm' },
        { name: 'Coolant Temp', value: coolant, unit: '°C' },
        { name: 'Engine State', value: 'ralentí', unit: '' },
        ...extra,
    ],
});
const fix = (t, kmh, extra = {}) => ({ timestamp: t, coords: { speed: kmh / 3.6, accuracy: 4, heading: 90, altitude: 2333, latitude: -1.5, longitude: -70.5, ...extra } });

test('records every sample, units once, events and stop summary', () => {
    const recs = [];
    const r = new TripRecorder({ sink: (x) => recs.push(x) });
    r.sample(sample(1));                       // not recording: ignored
    r.start({ perfil: 'SIM2K-33' }, 1000);
    for (let i = 0; i < 5; i++) r.sample(sample(1000 + i * 250));
    r.event('note', 'hola', null, 2500);
    const sum = r.stop(3000);
    assert.equal(sum.samples, 5);
    assert.equal(sum.events, 3);              // start, note, stop
    assert.equal(recs.filter(x => x.k === 'u').length, 1);
    assert.deepEqual(recs[0].meta, { perfil: 'SIM2K-33', rate: 'all', includeCoords: false });
    assert.equal(recs.at(-1).k, 'x');
    assert.equal(r.sample(sample(4000)), false, 'stopped');
});

test('1s rate keeps about one sample per second; new fields add units', () => {
    const recs = [];
    const r = new TripRecorder({ sink: (x) => recs.push(x), rate: '1s' });
    r.start({}, 0);
    let kept = 0;
    for (let t = 0; t <= 10_000; t += 260) kept += r.sample(sample(t)) ? 1 : 0;
    assert.ok(kept >= 9 && kept <= 11, `kept ${kept}`);
    r.sample(sample(12_000, 80, 900, [{ name: 'Battery Voltage (ELM327)', value: 12.4, unit: 'V' }]));
    const units = recs.filter(x => x.k === 'u');
    assert.equal(units.length, 2);
    assert.deepEqual(units[1].units, { 'Battery Voltage (ELM327)': 'V' });
});

test('GPS is attached only when fresh; coordinates only when enabled', () => {
    const recs = [];
    const r = new TripRecorder({ sink: (x) => recs.push(x) });
    r.start({}, 0);
    r.gps(fix(1000, 36));
    r.sample(sample(1500));
    r.sample(sample(9000));                    // GPS too old
    const s = recs.filter(x => x.k === 's');
    assert.deepEqual(s[0].g, { t: 1000, kmh: 36, acc: 4, hdg: 90, alt: 2333 });
    assert.equal(s[1].g, undefined);

    const recs2 = [];
    const r2 = new TripRecorder({ sink: (x) => recs2.push(x), includeCoords: true });
    r2.start({}, 0);
    r2.gps(fix(100, 10));
    r2.sample(sample(200));
    assert.equal(recs2.find(x => x.k === 's').g.lat, -1.5);
    assert.match(tripToCSV(recs2).split('\n').find(l => l.startsWith('"time_iso"')), /"lat","lon"/);
});

test('attach: session events, DTC changes only, alerts', () => {
    const recs = [];
    const r = new TripRecorder({ sink: (x) => recs.push(x) });
    const session = new EventEmitter();
    session.state = { status: 'connected' };
    const alerts = new AlertEngine();
    attachTripRecorder(r, { session, alerts });
    r.start({}, 0);
    session.emit('dtcs', { t: 10, dtcs: [{ code: 'P0501' }] });
    session.emit('dtcs', { t: 20, dtcs: [{ code: 'P0501' }] });           // same set: not logged again
    session.emit('dtcs', { t: 30, dtcs: [{ code: 'P0501' }, { code: 'P1535' }] });
    session.emit('ecu-link', { ok: false, t: 40 });
    session.emit('ecu-link', { ok: true, t: 50 });
    session.emit('state', { status: 'error', error: 'sin ECU' });
    session.emit('log', { level: 'info', msg: 'TX 2101', t: 60 });        // info logs are not events
    session.emit('log', { level: 'warn', msg: 'Recuperación', t: 61 });
    // overheat: warn ≥105 °C for 5 s with the engine running
    for (let t = 0; t <= 7000; t += 500) alerts.update(sample(t, 107, 900));
    session.emit('live', sample(8000));
    const ev = recs.filter(x => x.k === 'e').map(x => x.ev);
    assert.deepEqual(ev, ['start', 'dtcs', 'dtcs', 'link-lost', 'link-ok', 'state', 'warn', 'alert']);
    assert.match(recs.find(x => x.ev === 'alert').msg, /105|107|refrigerante|temperatura/i);
    assert.equal(recs.filter(x => x.k === 's').length, 1);
});

test('CSV export and summary of an interrupted JSONL log', () => {
    const lines = [];
    const r = new TripRecorder({ sink: (x) => lines.push(JSON.stringify(x)) });
    r.start({ perfil: 'X' }, Date.UTC(2026, 0, 1, 7, 0, 0));
    const t0 = Date.UTC(2026, 0, 1, 7, 0, 1);
    r.gps(fix(t0, 20));
    r.sample(sample(t0));
    r.sample(sample(t0 + 1000, 81, 950));
    r.event('alert', 'Sobrecalentamiento. "107 °C"', 'warning', t0 + 1500);
    const text = lines.join('\n') + '\n{"k":"s","t":12';       // crash mid-line, no 'x' record
    const recs = parseTripJsonl(text);
    const s = tripSummary(recs);
    assert.equal(s.samples, 2);
    assert.equal(s.complete, false);
    assert.equal(s.durationS, 3);              // 07:00:00 → 07:00:02.5
    const csv = tripToCSV(recs);
    assert.match(csv, /# perfil: X/);
    assert.match(csv, /interrumpida/);
    const header = csv.split('\n').find(l => l.startsWith('"time_iso"'));
    assert.match(header, /"Engine RPM \(rpm\)","Coolant Temp \(°C\)","Engine State"/);
    assert.ok(!/lat/.test(header), 'no coordinates by default');
    const rows = csv.split('\n').filter(l => /^"\d{4}-/.test(l));
    assert.equal(rows.length, 4);              // start event, 2 samples, alert
    assert.match(rows[1], /"muestra",,,900,80,"ralentí",20,4,90,2333,"61 01 AA BB"/);
    assert.match(rows[3], /"alerta \(warning\)","Sobrecalentamiento. ""107 °C"""/);
});

test('tripIdFor is file-name safe', () => {
    assert.match(tripIdFor(Date.now()), /^trip_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
});
