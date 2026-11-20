/**
 * Diagnostics (high-level, JSON results) against the simulated SIM2K-33.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELM327, Diagnostics, describeDtc, getProfile } from '../src/index.js';
import { SimTransport } from '../src/sim-transport.js';

const silentLogger = { debug() {}, info() {}, warn() {} };

test('describeDtc splits code, status and database info', () => {
    const d = describeDtc('P1535 [presente ahora, MIL encendida, sobre el máximo; 0xE1]');
    assert.equal(d.code, 'P1535');
    assert.equal(d.present, true);
    assert.equal(d.milOn, true);
    assert.match(d.info.description, /Evaporator/);
    assert.equal(describeDtc('P9999 [x]').info, null);
    const stored = describeDtc('P0501 [memorizado (no presente ahora), señal inválida; 0x38]');
    assert.equal(stored.present, false);
    assert.equal(stored.milOn, false);
});

test('Diagnostics: voltage, DTCs, live data, ECU info (read-only)', async () => {
    const sim = new SimTransport();
    const elm = new ELM327({ logger: silentLogger });
    elm.debug = false;
    await elm.connect(sim);
    await elm.initialize(getProfile('SIM2K_33'));
    const diag = new Diagnostics(elm);

    assert.equal(await diag.readVoltage(), 12.3);

    const { dtcs, source } = await diag.readDtcs();
    assert.deepEqual(dtcs.map(d => d.code), ['P1535', 'P0501', 'P0335']);
    assert.match(source, /servicio 18/);
    assert.ok(dtcs[0].info && dtcs[0].milOn);

    const prep = await diag.prepareLive();
    assert.match(prep.source, /2101/);
    const snap = await diag.sampleLive();
    assert.equal(snap.fields.find(f => f.name === 'Engine RPM').value, 897);
    assert.equal(snap.raw.split(' ').length, 78);

    const ecu = await diag.readEcuInfo();
    assert.ok(ecu.entries.some(e => e.text === 'KMHDxxxDx1Uxxxxxx'), JSON.stringify(ecu.entries));
    assert.equal(ecu.profile.name, 'Siemens VDO SIM2K-33');

    // Nothing that writes to the ECU was sent
    assert.ok(!sim.log.some(c => /^(14|11|30|31|3B|3D|27|2E)/.test(c)), sim.log.join(','));
    await elm.disconnect();
});

test('engine-off cold capture decodes to the values seen on the car', async () => {
    const { elm, diag } = await session({ engineOff: true });
    const { fields } = await diag.sampleLive();
    const v = (n) => fields.find(f => f.name === n)?.value;
    assert.equal(v('Engine RPM'), 0);
    assert.equal(v('Engine State'), 'parado');
    assert.equal(v('Coolant Temp'), 19.5);
    assert.equal(v('Intake Air Temp'), 22.5);
    await elm.disconnect();
});

async function session(simOpts) {
    const sim = new SimTransport(simOpts);
    const elm = new ELM327({ logger: silentLogger });
    elm.debug = false;
    await elm.connect(sim);
    await elm.initialize(getProfile('SIM2K_33'));
    return { sim, elm, diag: new Diagnostics(elm) };
}

test('clearDtcs: engine off → 14FF00, then re-reads (empty, as on the car)', async () => {
    const { sim, elm, diag } = await session({ engineOff: true });
    const r = await diag.clearDtcs();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(sim.log.includes('14FF00'));
    assert.deepEqual(r.after.dtcs, []);
    await elm.disconnect();
});

test('clearDtcs: refuses with the engine running (nothing sent)', async () => {
    const { sim, elm, diag } = await session({ vary: true });   // vary → RPM > 0
    const r = await diag.clearDtcs();
    assert.equal(r.ok, false);
    assert.match(r.error, /motor está en marcha/);
    assert.ok(!sim.log.includes('14FF00'));
    await elm.disconnect();
});

test('clearDtcs: reports an ECU rejection (NRC)', async () => {
    const { elm, diag } = await session({ engineOff: true, responses: { '14FF00': '7F 14 22' } });
    const r = await diag.clearDtcs();
    assert.equal(r.ok, false);
    assert.match(r.error, /rechazó/);
    await elm.disconnect();
});
