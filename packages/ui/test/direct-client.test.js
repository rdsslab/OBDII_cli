/**
 * DirectClient + WebSerialTransport end to end, in Node, with a fake Web
 * Serial port (real ReadableStream / WritableStream) wired to the SIM2K-33
 * simulator. Covers what the PWA does in Chrome, minus the port picker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimTransport } from '@obdii/core/sim-transport.js';

/** Fake SerialPort backed by the simulator. */
class FakeSerialPort extends EventTarget {
    constructor(simOpts) {
        super();
        this.simOpts = simOpts;
        this.readable = null;
        this.writable = null;
        this.opened = 0;
    }
    getInfo() { return { bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' }; }
    async open({ baudRate }) {
        if (this.readable) throw new Error('The port is already open.');
        assert.equal(baudRate, 38400);
        this.opened++;
        this.sim ||= new SimTransport(this.simOpts);
        await this.sim.open();
        let ctrl;
        this.readable = new ReadableStream({ start: (c) => { ctrl = c; } });
        this._feed = (chunk) => { try { ctrl.enqueue(chunk); } catch { /* closed */ } };
        this.sim.onData(this._feed);
        this._ctrl = ctrl;
        const dec = new TextDecoder();
        this.writable = new WritableStream({ write: (bytes) => this.sim.write(dec.decode(bytes)) });
    }
    async close() {
        this.sim?.offData(this._feed);
        try { this._ctrl.close(); } catch { /* ignore */ }
        this.readable = this.writable = null;
    }
    /** Simulate the Bluetooth link dropping: the stream errors out. */
    drop() {
        this.sim?.offData(this._feed);
        this._ctrl.error(new Error('device lost'));
        this.readable = this.writable = null;
    }
}

function installNavigator(port) {
    const serial = new EventTarget();
    serial.getPorts = async () => [];
    serial.requestPort = async (opts) => {
        assert.ok(opts.allowedBluetoothServiceClassIds.includes('00001101-0000-1000-8000-00805f9b34fb'));
        return port;
    };
    Object.defineProperty(globalThis, 'navigator', { value: { serial }, configurable: true });
}

const until = async (cond, ms = 15000) => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('timeout');
        await new Promise(r => setTimeout(r, 25));
    }
};

test('DirectClient over Web Serial: pick port, connect, live, DTCs, report, clear, disconnect', async () => {
    const port = new FakeSerialPort({ engineOff: true });
    installNavigator(port);
    const { DirectClient } = await import('../src/clients/direct-client.js');
    const client = new DirectClient();
    const seen = { state: [], live: [], dtcs: [] };
    client.on('state', s => seen.state.push(s)).on('live', l => seen.live.push(l)).on('dtcs', d => seen.dtcs.push(d));
    client.start();

    assert.equal(client.capabilities.clearNeedsPin, false);
    const ports = await client.listPorts();
    assert.equal(ports.at(-1).path, 'new');

    await client.connect('new', 'SIM2K_33');
    const st = seen.state.at(-1);
    assert.equal(st.status, 'connected', JSON.stringify(st));
    assert.equal(st.port, 'Adaptador Bluetooth (SPP)');
    assert.equal(st.clearEnabled, true);

    await client.startLive();
    await until(() => seen.live.length >= 3);
    assert.equal(seen.live[0].fields.find(f => f.name === 'Engine RPM').value, 0);
    await client.stopLive();

    const d = await client.readDtcs();
    assert.deepEqual(d.dtcs.map(x => x.code), ['P1535', 'P0501', 'P0335']);
    const url = client.reportUrl();
    assert.match(url, /^blob:/);

    const c = await client.clearDtcs();
    assert.equal(c.ok, true);
    assert.deepEqual(seen.dtcs.at(-1).dtcs, []);

    await client.disconnect();
    assert.equal(seen.state.at(-1).status, 'disconnected');
    assert.equal(port.readable, null, 'port closed');
});

test('DirectClient: a dropped Bluetooth link puts the session in error', async () => {
    const port = new FakeSerialPort({});
    installNavigator(port);
    const { DirectClient } = await import('../src/clients/direct-client.js');
    const client = new DirectClient();
    let last;
    client.on('state', s => { last = s; });
    await client.connect('new', 'SIM2K_33');
    assert.equal(last.status, 'connected');
    port.drop();
    await until(() => last.status === 'error');
    assert.match(last.error, /Se perdió la conexión/);
});
