import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGpsSpeed } from '../src/gps-speed.js';

const field = (name, value) => ({ name, value, unit: 'km/h' });
const now = 1_000_000;

test('a healthy ECU speed wins even when GPS is available', () => {
    const fields = [field('Vehicle Speed (ECU)', 42)];
    const r = resolveGpsSpeed(fields, { t: now, kmh: 50 }, now);
    assert.equal(r.source, 'ecu');
    assert.equal(r.value, 42);
    assert.equal(r.fields[0].value, 42);
});

test('ECU 0 plus a fast fresh GPS fix shows GPS with its own source', () => {
    const r = resolveGpsSpeed([field('Vehicle Speed (ECU)', 0)], { t: now - 1000, kmh: 33 }, now);
    assert.equal(r.source, 'gps');
    assert.equal(r.value, 33);
    assert.equal(r.fields[0].source, 'gps');
});

test('stale or stationary GPS cannot replace the ECU, even a missing one', () => {
    assert.equal(resolveGpsSpeed([field('Vehicle Speed', 0)], { t: now - 10_000, kmh: 60 }, now).source, 'ecu');
    assert.equal(resolveGpsSpeed([field('Vehicle Speed', 0)], { t: now, kmh: 2 }, now).source, 'ecu');
    assert.equal(resolveGpsSpeed([], null, now).fields.length, 0);
});

test('when the ECU field is absent a fresh fix adds a GPS speed field', () => {
    const r = resolveGpsSpeed([field('Engine RPM', 2000)], { t: now, kmh: 12 }, now);
    assert.equal(r.source, 'gps');
    assert.equal(r.fields[0].name, 'Vehicle Speed (ECU)');
    assert.equal(r.fields[0].value, 12);
});
