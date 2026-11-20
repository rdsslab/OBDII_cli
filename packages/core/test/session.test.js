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

test('session: linkLost() without autoReconnect puts the session in error and stops live data', async () => {
    const session = new ObdSession({ makeTransport: () => new SimTransport(), autoReconnect: false });
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

test('session: link loss reconnects by itself and resumes live data', { timeout: 30000 }, async () => {
    let opens = 0;
    // the adapter is "away" for the first two reconnect attempts
    const makeTransport = () => {
        opens++;
        if (opens === 2 || opens === 3) return { open: async () => { throw new Error('No se pudo abrir el adaptador'); }, close: async () => {}, onData() {}, offData() {}, write() {}, isOpen: false };
        return new SimTransport();
    };
    const session = new ObdSession({ makeTransport, reconnectDelaysMs: [50, 100] });
    const states = [];
    const links = [];
    let samples = 0;
    session.on('state', s => states.push(s.status)).on('ecu-link', l => links.push(l.ok)).on('live', () => samples++);
    await session.connect('SIM', 'SIM2K_33');
    await session.startLive();
    await until(() => samples > 2);

    session.linkLost('Bluetooth perdido');
    await until(() => session.state.status === 'reconnecting');
    assert.equal(session.state.live.running, false);
    await until(() => session.state.status === 'connected' && session.state.live.running, 25000);
    assert.equal(opens, 4, 'two failed attempts, then success');
    assert.equal(session.state.reconnect, null);
    const before = samples;
    await until(() => samples > before + 2);
    assert.deepEqual(links.slice(-2), [false, true]);
    assert.ok(states.includes('reconnecting'));
    await session.disconnect();
});

test('session: disconnect() cancels the automatic reconnection', { timeout: 15000 }, async () => {
    let opens = 0;
    const session = new ObdSession({
        makeTransport: () => (++opens === 1 ? new SimTransport() : { open: async () => { throw new Error('ausente'); }, close: async () => {}, onData() {}, offData() {}, write() {}, isOpen: false }),
        reconnectDelaysMs: [30],
    });
    await session.connect('SIM', 'SIM2K_33');
    session.linkLost('Bluetooth perdido');
    await until(() => opens >= 3);
    await session.disconnect();
    const n = opens;
    await new Promise(r => setTimeout(r, 300));
    assert.equal(session.state.status, 'disconnected');
    assert.equal(opens, n, 'no more attempts after disconnect');
});

test('session: gives up after reconnectMaxMs with a clear error', { timeout: 15000 }, async () => {
    let opens = 0;
    const session = new ObdSession({
        makeTransport: () => (++opens === 1 ? new SimTransport() : { open: async () => { throw new Error('ausente'); }, close: async () => {}, onData() {}, offData() {}, write() {}, isOpen: false }),
        reconnectDelaysMs: [40], reconnectMaxMs: 300,
    });
    await session.connect('SIM', 'SIM2K_33');
    await session.linkLost('Bluetooth perdido');
    assert.equal(session.state.status, 'error');
    assert.match(session.state.error, /No se pudo reconectar/);
});

test('session: battery watch resumes after a link loss', { timeout: 15000 }, async () => {
    const session = new ObdSession({ makeTransport: () => new SimTransport({ engineOff: true }), batteryWatchMs: 100, reconnectDelaysMs: [50] });
    await session.watchBattery('SIM-OFF');
    assert.equal(session.state.status, 'watch');
    session.linkLost('Bluetooth perdido');
    await until(() => session.state.status === 'reconnecting');
    await until(() => session.state.status === 'watch');
    let v = 0;
    session.on('live', () => v++);
    await until(() => v >= 1);
    await session.disconnect();
    assert.equal(session.state.status, 'disconnected');
});

/** Simulator whose Nth answer to 2101 arrives after the ELM timeout (slow Bluetooth). */
class LateSim extends SimTransport {
    constructor(lateAt, delayMs, opts) { super(opts); this.lateAt = lateAt; this.delayMs = delayMs; this.reads = 0; }
    write(text) {
        const cmd = text.replace(/\r/g, '').trim().toUpperCase();
        if (cmd === '2101' && ++this.reads === this.lateAt) {
            const reply = this._reply(cmd);
            const bytes = new TextEncoder().encode(`${reply}\r\r>`);
            setTimeout(() => this.listeners.forEach(cb => cb(bytes)), this.delayMs);
            return;
        }
        super.write(text);
    }
}

test('session: a late answer is discarded instead of shifting the next responses', { timeout: 30000 }, async () => {
    const session = new ObdSession({ makeTransport: () => new LateSim(4, 6500, { engineOff: true }), dtcPollMs: 0 });
    const logs = [];
    const links = [];
    const live = [];
    session.on('log', e => logs.push(e)).on('ecu-link', l => links.push(l.ok)).on('live', s => live.push(s));
    await session.connect('SIM-OFF', 'SIM2K_33');
    await session.startLive();
    await until(() => logs.some(e => /Respuesta atrasada descartada/.test(e.msg)), 20000);
    const n = live.length;
    await until(() => live.length >= n + 3);
    // responses are in step again: the DTC read gets DTCs, not a 21 01 block
    await session.stopLive();
    const d = await session.readDtcs();
    assert.deepEqual(d.dtcs.map(x => x.code), ['P1535', 'P0501', 'P0335']);
    assert.ok(logs.some(e => /Lectura en tiempo real fallida/.test(e.msg)), 'failure reason logged');
    assert.deepEqual(links, [], 'one slow answer is not a lost link');
    await session.disconnect();
});

test('session: battery voltage (ATRV) is refreshed during live data', { timeout: 15000 }, async () => {
    const sim = new SimTransport({ engineOff: true });
    const session = new ObdSession({ makeTransport: () => sim, liveVoltageMs: 300, dtcPollMs: 0 });
    await session.connect('SIM-OFF', 'SIM2K_33');
    assert.equal(session.state.voltage, 12.3);
    sim.responses.ATRV = '12.9V';
    const orig = sim._reply.bind(sim);
    sim._reply = (c) => (c.toUpperCase().replace(/\s/g, '') === 'ATRV' ? '12.9V' : orig(c));
    await session.startLive();
    await until(() => session.state.voltage === 12.9);
    await session.disconnect();
});
