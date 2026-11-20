/**
 * AlertEngine: thresholds, delays, hysteresis, escalation, repeats, config.
 * Uses a simulated clock (sample.t) so delays are deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine, defaultAlertConfig, mergeAlertConfig, ALERT_IDS } from '../src/alerts.js';

const S = (t, v) => ({
    t: t * 1000,
    fields: Object.entries(v).map(([name, value]) => ({ name, value })),
});
const ecu = (t, { rpm = 850, coolant = 88, volt = 13.4 } = {}) =>
    S(t, { 'Engine RPM': rpm, 'Coolant Temp': coolant, 'Battery Voltage (ECU)': volt });

function engine(config) {
    const e = new AlertEngine({ config });
    const ev = [];
    e.on(x => ev.push(x));
    return { e, ev, raised: (id) => ev.filter(x => x.id === id && x.type === 'raise'), last: () => ev.at(-1) };
}

test('defaults cover every alert and every threshold is a parameter', () => {
    const cfg = defaultAlertConfig();
    assert.deepEqual(Object.keys(cfg), ALERT_IDS);
    assert.equal(cfg.overheat.warn, 105);
    assert.equal(cfg.overheat.crit, 110);
    assert.equal(cfg.noCharge.minV, 12.8);
    const merged = mergeAlertConfig({ overheat: { warn: '100', bogus: 1 }, lowBattery: { enabled: false } });
    assert.equal(merged.overheat.warn, 100);
    assert.equal(merged.overheat.bogus, undefined);
    assert.equal(merged.lowBattery.enabled, false);
});

test('overheat: delay, escalation to critical, hysteresis, clear', () => {
    const { e, ev, raised } = engine();
    e.update(ecu(0, { coolant: 104 }));
    e.update(ecu(1, { coolant: 106 }));
    e.update(ecu(4, { coolant: 106 }));
    assert.equal(raised('overheat').length, 0, 'not before 5 s');
    e.update(ecu(6.5, { coolant: 106 }));
    assert.equal(raised('overheat')[0].severity, 'warning');
    assert.match(raised('overheat')[0].message, /106 °C/);
    e.update(ecu(8, { coolant: 111 }));
    assert.equal(raised('overheat')[1].severity, 'critical', 'escalates');
    e.update(ecu(9, { coolant: 102 }));             // below warn, above clear: stays active
    assert.ok(e.active.has('overheat'));
    e.update(ecu(10, { coolant: 99 }));
    assert.equal(ev.at(-1).type, 'clear');
    assert.ok(!e.active.has('overheat'));
});

test('critical alerts repeat every 30 s until acknowledged', () => {
    const { e, ev } = engine();
    for (let t = 0; t <= 10; t++) e.update(ecu(t, { coolant: 112 }));
    for (let t = 11; t <= 45; t++) e.update(ecu(t, { coolant: 112 }));
    assert.equal(ev.filter(x => x.type === 'repeat').length, 1);
    e.acknowledge('overheat');
    for (let t = 46; t <= 120; t++) e.update(ecu(t, { coolant: 112 }));
    assert.equal(ev.filter(x => x.type === 'repeat').length, 1, 'no repeats after ack');
});

test('noCharge only with the engine running for a while; overVoltage', () => {
    const { e, raised } = engine();
    for (let t = 0; t <= 25; t++) e.update(ecu(t, { volt: 12.4 }));      // running < 30 s
    assert.equal(raised('noCharge').length, 0);
    for (let t = 26; t <= 60; t++) e.update(ecu(t, { volt: 12.4 }));
    assert.equal(raised('noCharge').length, 1);
    assert.equal(raised('noCharge')[0].severity, 'critical');
    const b = engine();
    for (let t = 0; t <= 15; t++) b.e.update(ecu(t, { volt: 15.3 }));
    assert.equal(b.raised('overVoltage').length, 1);
});

test('lowBattery with the engine off (and from battery-watch samples without RPM)', () => {
    const { e, raised } = engine();
    for (let t = 0; t <= 12; t++) e.update(ecu(t, { rpm: 0, coolant: 20, volt: 11.9 }));
    assert.equal(raised('lowBattery')[0].severity, 'warning');
    const w = engine();
    for (let t = 0; t <= 12; t++) w.e.update(S(t, { 'Battery Voltage (ELM327)': 11.4 }));
    assert.equal(w.raised('lowBattery')[0].severity, 'critical');
    assert.equal(w.raised('ignitionOn').length, 0, 'no ECU data: ignition unknown');
});

test('ignitionOn after N minutes with the engine off; cleared by starting', () => {
    const { e, ev, raised } = engine({ ignitionOn: { minutes: 10 } });
    for (let t = 0; t <= 9 * 60; t += 10) e.update(ecu(t, { rpm: 0, coolant: 20, volt: 12.3 }));
    assert.equal(raised('ignitionOn').length, 0);
    for (let t = 9 * 60; t <= 10 * 60 + 10; t += 10) e.update(ecu(t, { rpm: 0, coolant: 20, volt: 12.3 }));
    assert.equal(raised('ignitionOn').length, 1);
    assert.match(raised('ignitionOn')[0].message, /10 minutos/);
    e.update(ecu(700, { rpm: 900, coolant: 20, volt: 14 }));
    assert.ok(ev.some(x => x.type === 'clear' && x.id === 'ignitionOn'));
});

test('coldRev, overRev, noWarmup, fastHeat', () => {
    const a = engine();
    for (let t = 0; t <= 3; t++) a.e.update(ecu(t, { rpm: 4000, coolant: 30 }));
    assert.equal(a.raised('coldRev')[0].severity, 'info');
    const b = engine();
    for (let t = 0; t <= 2; t++) b.e.update(ecu(t, { rpm: 6000, coolant: 90 }));
    assert.equal(b.raised('overRev').length, 1);
    const c = engine();
    for (let t = 0; t <= 16 * 60; t += 10) c.e.update(ecu(t, { rpm: 900, coolant: 55 }));
    assert.equal(c.raised('noWarmup').length, 1);
    const d = engine();
    for (let t = 0; t <= 70; t += 5) d.e.update(ecu(t, { rpm: 900, coolant: 75 + t * 0.15 }));   // 9 °C/min
    assert.equal(d.raised('fastHeat').length, 1);
});

test('linkLost via notify; newDtc ignores P1535 and only fires once per code', () => {
    const { e, ev, raised } = engine();
    e.notify('link-lost', null, 0);
    assert.equal(raised('linkLost').length, 1);
    e.notify('link-ok', null, 1000);
    assert.ok(ev.some(x => x.type === 'clear' && x.id === 'linkLost'));
    e.notify('dtcs', [{ code: 'P1535' }], 2000);
    assert.equal(raised('newDtc').length, 0, 'P1535 ignored by default');
    e.notify('dtcs', [{ code: 'P1535' }, { code: 'P0335' }], 3000);
    assert.match(raised('newDtc')[0].message, /P0335/);
    e.notify('dtcs', [{ code: 'P0335' }], 4000);
    assert.equal(raised('newDtc').length, 1, 'same code not repeated');
});

test('disabled alerts never fire; English texts', () => {
    const { e, raised } = engine({ overheat: { enabled: false } });
    for (let t = 0; t <= 10; t++) e.update(ecu(t, { coolant: 120 }));
    assert.equal(raised('overheat').length, 0);
    const en = new AlertEngine({ lang: 'en' });
    assert.equal(en.text('overheat', 107).title, 'Engine overheating');
    assert.match(en.text('overheat', 107).message, /107 °C/);
});
