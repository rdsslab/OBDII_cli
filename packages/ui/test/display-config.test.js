import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDisplayConfig, graphableGroups, isVisible, rangeFor, sensorKey } from '../src/display-config.js';
import { sensorZone, sensorZones } from '../src/sensor-meta.js';

test('speed defaults to 150 and protocol variants share one configuration', () => {
    const cfg = defaultDisplayConfig();
    assert.deepEqual(rangeFor('Vehicle Speed (ECU)', cfg), { min: 0, max: 150 });
    assert.equal(sensorKey('Vehicle Speed'), 'speed');
    cfg.speed.max = 120;
    assert.deepEqual(rangeFor('Vehicle Speed', cfg), { min: 0, max: 120 });
});

test('visibility and thresholds can be overridden per sensor', () => {
    const cfg = defaultDisplayConfig();
    cfg.rpm.visible = false;
    cfg.rpm.warn = 4000;
    cfg.rpm.bad = 4500;
    assert.equal(isVisible('Engine RPM', cfg), false);
    assert.deepEqual(sensorZones('Engine RPM', {}, cfg).zones.map(z => [z.at, z.color]), [
        [0, 'cool'], [3500, 'ok'], [4000, 'warn'], [4500, 'bad'],
    ]);
    assert.equal(sensorZone('Engine RPM', 4200, {}, cfg), 'warn');
    assert.equal(sensorZone('Engine RPM', 4600, {}, cfg), 'bad');
});

test('graphable groups exclude text/raw fields and text sensors can be hidden', () => {
    const cfg = defaultDisplayConfig();
    const ids = graphableGroups(cfg).map(g => g.id);
    assert.ok(ids.includes('speed') && ids.includes('coolant'));
    assert.ok(!ids.includes('engineState') && !ids.includes('ignitionRaw'));
    cfg.engineState.visible = false;
    assert.equal(isVisible('Engine State', cfg), false);
});
