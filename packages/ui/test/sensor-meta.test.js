import test from 'node:test';
import assert from 'node:assert/strict';
import { sortFields, sensorZone } from '../src/sensor-meta.js';

test('the live panel and the charts share the same sensor priority', () => {
    const fields = [
        { name: 'O2 Sensor B1S1' },
        { name: 'Engine State' },
        { name: 'Throttle Position' },
        { name: 'Battery Voltage (ECU)' },
        { name: 'Coolant Temp' },
        { name: 'Engine RPM' },
        { name: 'Vehicle Speed (ECU)' },
    ];
    assert.deepEqual(sortFields(fields).map(f => f.name), [
        'Vehicle Speed (ECU)', 'Engine RPM', 'Coolant Temp',
        'Battery Voltage (ECU)', 'Throttle Position', 'Engine State', 'O2 Sensor B1S1',
    ]);
    // Protocol variants sit next to their KWP2000 counterpart.
    assert.deepEqual(sortFields([
        { name: 'Fuel Tank Level' }, { name: 'Vehicle Speed' }, { name: 'Engine RPM' },
    ]).map(f => f.name), ['Vehicle Speed', 'Engine RPM', 'Fuel Tank Level']);
});

test('temperature goes from blue to red as it approaches the maximum', () => {
    assert.equal(sensorZone('Coolant Temp', 30, {}), 'cool');
    assert.equal(sensorZone('Coolant Temp', 75, {}), 'ok');
    assert.equal(sensorZone('Coolant Temp', 98, {}), 'warn');
    assert.equal(sensorZone('Coolant Temp', 108, {}), 'bad');
    // A lower threshold configured in Alert Settings moves the red zone.
    assert.equal(sensorZone('Coolant Temp', 90, { overheat: { warn: 80, crit: 85 } }), 'bad');
});

test('RPM, throttle and voltage use their own danger thresholds', () => {
    assert.deepEqual([0, 3600, 5100, 5600].map(v => sensorZone('Engine RPM', v, {})), ['cool', 'ok', 'warn', 'bad']);
    assert.deepEqual([10, 60, 85, 95].map(v => sensorZone('Throttle Position', v, {})), ['cool', 'ok', 'warn', 'bad']);
    assert.deepEqual([11, 11.8, 12.2, 13.5, 14.9, 15.2].map(v => sensorZone('Battery Voltage (ECU)', v, {})),
        ['bad', 'warn', 'cool', 'ok', 'warn', 'bad']);
    // Configured low-battery alert wins over the built-in zone.
    assert.equal(sensorZone('Battery Voltage (ECU)', 12.2, { lowBattery: { warnV: 12.5, critV: 12 } }), 'warn');
});

test('an active critical alert cannot be shown as normal', () => {
    assert.equal(sensorZone('Coolant Temp', 40, {}, 'critical'), 'bad');
    assert.equal(sensorZone('Engine RPM', 1000, {}, 'warning'), 'warn');
});
