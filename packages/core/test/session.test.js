/**
 * ObdSession (shared by the server and the PWA) against the simulator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObdSession } from '../src/index.js';
import { SimTransport } from '../src/sim-transport.js';

const until = async (cond, ms = 20000) => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
        await new Promise(r => setTimeout(r, 50));
    }
};

test('session: connect, live samples, DTCs, ECU info, clear, disconnect', async () => {
    const session = new ObdSession({ makeTransport: () => new SimTransport({ engineOff: true }) });
    const events = { state: 0, live: [], dtcs: 0, log: [] };
    session.on('state', () => events.state++).on('live', s => events.live.push(s))
        .on('dtcs', () => events.dtcs++).on('log', e => events.log.push(e));

    await session.connect('SIM-OFF', 'SIM2K_33');
    assert.equal(session.state.status, 'connected');
    assert.equal(session.state.mode, 'kwp2000');

    await session.startLive();
    await until(() => events.live.length >= 3);
    assert.equal(events.live[0].fields.find(f => f.name === 'Coolant Temp').value, 19.5);
    await session.stopLive();
    assert.equal(session.state.live.running, false);

    const d = await session.readDtcs();
    assert.equal(d.dtcs.length, 3);
    const ecu = await session.readEcuInfo();
    assert.ok(ecu.entries.length > 0);

    const c = await session.clearDtcs('test');
    assert.equal(c.ok, true);
    assert.deepEqual(session.lastDtcs.dtcs, []);
    assert.ok(events.dtcs >= 2);

    await session.disconnect();
    assert.equal(session.state.status, 'disconnected');
    assert.ok(events.log.some(e => /Conectado/.test(e.msg)));
});

test('session: hung adapter during live data recovers by escalating to ATZ', { timeout: 60000 }, async () => {
    const session = new ObdSession({ makeTransport: () => new SimTransport({ hangAfter: 6 }) });
    const logs = [];
    let samples = 0;
    session.on('log', e => logs.push(e)).on('live', () => samples++);
    await session.connect('SIM', 'SIM2K_33');
    await session.startLive();
    await until(() => logs.some(e => e.msg === 'Sesión recuperada'), 45000);
    const before = samples;
    await until(() => samples > before + 2);
    assert.ok(logs.some(e => /reabriendo la sesión KWP/.test(e.msg)));
    assert.ok(logs.some(e => /reinicializando el ELM327/.test(e.msg)));
    assert.ok(logs.some(e => e.level === 'debug'), 'TX/RX traced during recovery');
    await session.disconnect();
});

test('session: linkLost() puts the session in error and stops live data', async () => {
    const session = new ObdSession({ makeTransport: () => new SimTransport() });
    await session.connect('SIM', 'SIM2K_33');
    await session.startLive();
    await session.linkLost('Adaptador desconectado');
    assert.equal(session.state.status, 'error');
    assert.equal(session.state.live.running, false);
    await assert.rejects(() => session.readDtcs(), /No hay conexión/);
});

test('session: periodic DTC re-read during live data', async () => {
    const session = new ObdSession({ makeTransport: () => new SimTransport({ engineOff: true }), dtcPollMs: 600 });
    let dtcEvents = 0;
    session.on('dtcs', () => dtcEvents++);
    await session.connect('SIM-OFF', 'SIM2K_33');
    await session.startLive();
    await until(() => dtcEvents >= 2, 10000);
    await session.disconnect();
});

test('session: battery watch reads ATRV without the ECU, then disconnects', async () => {
    const session = new ObdSession({ makeTransport: () => new SimTransport(), batteryWatchMs: 300 });
    const live = [];
    session.on('live', s => live.push(s));
    await session.watchBattery('SIM');
    assert.equal(session.state.status, 'watch');
    await until(() => live.length >= 2, 5000);
    assert.deepEqual(live[0].fields.map(f => f.name), ['Battery Voltage (ELM327)']);
    assert.equal(live[0].fields[0].value, 12.3);
    await assert.rejects(() => session.connect('SIM', 'SIM2K_33'), /Ya conectado/);
    await session.disconnect();
    assert.equal(session.state.status, 'disconnected');
});
