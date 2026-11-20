/**
 * Speed spike filter with the real ECU sequence from the GPS calibration
 * drive of 2026-11-20 (1 s apart; GPS speed in the comments).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeedSpikeFilter } from '../src/index.js';

const run = (values, stepMs = 1000) => {
    const f = new SpeedSpikeFilter();
    return values.map((v, i) => f.filter(v, i * stepMs));
};

test('spikes from the drive are held, real speed passes', () => {
    // GPS: 33.2 37.5 38.3 39.2 40.2 39.5 38.9 38.1 36.4 34.9 33.2
    const ecu = [33, 71, 35, 38, 43, 43, 54, 41, 52, 68, 32];
    const out = run(ecu);
    assert.deepEqual(out.map(o => o.value), [33, 33, 35, 38, 43, 43, 43, 41, 41, 41, 32]);
    assert.deepEqual(out.map((o, i) => (o.spike ? i : null)).filter(i => i != null), [1, 6, 8, 9]);
});

test('real acceleration and braking are not touched', () => {
    // pulling away (GPS 2.8 10.9 15.8 13.8 15.1 16.4) and braking hard
    const ecu = [3, 9, 13, 14, 14, 15, 16, 18, 23, 24, 20, 16, 8, 5, 0];
    assert.ok(run(ecu).every(o => !o.spike));
    assert.deepEqual(run(ecu).map(o => o.value), ecu);
});

test('at 4 samples/s a 1 s spike is held for its whole length', () => {
    const ecu = [25, 25, 25, 25, 41, 41, 40, 41, 25, 26, 26];
    const out = run(ecu, 250);
    assert.deepEqual(out.map(o => o.value), [25, 25, 25, 25, 25, 25, 25, 25, 25, 26, 26]);
});

test('a rise that persists beyond 3 s is accepted (not stuck forever)', () => {
    const ecu = [20, 60, 60, 60, 60, 60];
    const out = run(ecu);
    assert.equal(out.at(-1).value, 60);
    assert.equal(out.at(-1).spike, false);
});

test('apply() keeps the ECU value as rawValue', () => {
    const f = new SpeedSpikeFilter();
    const s1 = { fields: [{ name: 'Vehicle Speed (ECU)', value: 30 }] };
    const s2 = { fields: [{ name: 'Vehicle Speed (ECU)', value: 62 }] };
    assert.equal(f.apply(s1, 0), null);
    assert.deepEqual(f.apply(s2, 1000), { raw: 62, shown: 30 });
    assert.equal(s2.fields[0].value, 30);
    assert.equal(s2.fields[0].rawValue, 62);
});
