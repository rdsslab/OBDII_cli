/**
 * End-to-end test of @obdii/core against the simulated ELM327 + SIM2K-33.
 * Run: npm test (from the repo root or packages/core)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELM327, getProfile, KWP_DATA_BLOCKS, KWP_COMMANDS } from '../src/index.js';
import { SimTransport, kwpFrame, CAPTURE_2101 } from '../src/sim-transport.js';

const silentLogger = { debug() {}, info() {}, warn() {} };

test('decodeKwpFrames: validates checksum and strips headers', () => {
    assert.deepEqual(ELM327.decodeKwpFrames(kwpFrame('50 81')), ['50 81']);
    assert.deepEqual(ELM327.decodeKwpFrames(kwpFrame(CAPTURE_2101)), [CAPTURE_2101]);
    const bad = kwpFrame('50 81').replace(/\w\w$/, '00');
    assert.equal(ELM327.decodeKwpFrames(bad), null);
});

test('connect() rejects a non-transport argument', async () => {
    const elm = new ELM327({ logger: silentLogger });
    await assert.rejects(() => elm.connect('COM6'), /transport/);
});

test('full session: init SIM2K-33, live data, DTCs, disconnect', async () => {
    const sim = new SimTransport();
    const elm = new ELM327({ logger: silentLogger });
    elm.debug = false;

    await elm.connect(sim);
    const info = await elm.initialize(getProfile('SIM2K_33'));
    assert.equal(elm.mode, 'kwp2000', JSON.stringify(info));
    assert.match(elm.version, /v1\.5/);
    assert.ok(sim.log.includes('ATH1'), 'KWP framing (ATH1) enabled');
    assert.ok(sim.log.some(c => /^AT ?WM/i.test(c)), 'ELM keep-alive (ATWM) configured');

    const fields = await elm.readKWPParsedBlock(KWP_DATA_BLOCKS.BLOCK_01);
    const val = (name) => fields.find(f => f.name === name)?.value;
    assert.equal(val('Engine RPM'), 897);
    assert.equal(val('Target Idle RPM'), 850);
    assert.equal(val('Battery Voltage (ECU)'), 14);
    assert.equal(val('Coolant Temp'), 87);
    assert.equal(val('Intake Air Temp'), 74.3);   // byte 5, 0.75·x − 48

    const dtcResp = await elm.sendCommand('1800FF00');
    assert.ok(dtcResp.success, JSON.stringify(dtcResp));
    const dtcs = KWP_COMMANDS.parseDTC18(dtcResp.data);
    assert.deepEqual(dtcs.map(d => d.slice(0, 5)), ['P1535', 'P0501', 'P0335']);
    assert.match(dtcs[0], /MIL encendida/);

    await elm.disconnect();
    assert.equal(sim.isOpen, false);
    assert.ok(sim.log.includes('82'), 'stopCommunication sent on exit');
});

test('recovery: session re-open fails on a hung adapter, full reinitialize() works', async () => {
    const sim = new SimTransport({ hangAfter: 3 })   // init's own 2101 test is read 1;
    const elm = new ELM327({ logger: silentLogger });
    elm.debug = false;
    await elm.connect(sim);
    await elm.initialize(getProfile('SIM2K_33'));
    assert.ok((await elm.readKWPParsedBlock(KWP_DATA_BLOCKS.BLOCK_01)).length > 0);   // read 1 OK
    assert.deepEqual(await elm.readKWPParsedBlock(KWP_DATA_BLOCKS.BLOCK_01), []);      // read 2: hangs

    assert.equal(await elm.recoverSession(), false, 'light recovery cannot fix a hung adapter');
    assert.equal(await elm.reinitialize(), true, 'ATZ + full init recovers');
    assert.equal(elm.mode, 'kwp2000');
    assert.ok((await elm.readKWPParsedBlock(KWP_DATA_BLOCKS.BLOCK_01)).length > 0);
    await elm.disconnect();
});

test('a silent port (no ELM327) is rejected instead of "detecting" OBD2', { timeout: 60000 }, async () => {
    const silent = { isOpen: false, async open() { this.isOpen = true; }, async close() { this.isOpen = false; }, write() {}, onData() {}, offData() {} };
    const elm = new ELM327({ logger: silentLogger });
    elm.debug = false;
    await elm.connect(silent);
    await assert.rejects(() => elm.initialize(getProfile('SIM2K_33')), /no responde como un ELM327/);
    assert.equal(elm.mode, 'unknown');
    assert.equal(elm._isError('TIMEOUT'), true);
});
