/**
 * Esp32Client + Esp32BridgeTransport end to end, in Node, against the
 * firmware simulator (firmware/esp32-elm327/tools/mock-server.mjs): login,
 * WebSocket bridge to the simulated ELM327, live data, DTCs, a Bluetooth
 * drop with automatic reconnection, and another device taking over.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Esp32Client } from '../src/clients/esp32-client.js';

const MOCK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../firmware/esp32-elm327/tools/mock-server.mjs');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
let proc;
let cookie;

const until = async (cond, ms = 20000) => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('timeout');
        await new Promise(r => setTimeout(r, 25));
    }
};
const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: new URLSearchParams(o) });
const api = async (p, o) => {
    const r = await fetch(`${ORIGIN}${p}`, o ? form(o) : { headers: { Cookie: cookie } });
    return { status: r.status, body: await r.json() };
};

/** A client as a logged-in browser would be (cookie on fetch and WebSocket). */
function makeClient() {
    class CookieWs extends WebSocket {
        constructor(url) { super(url, { headers: { Cookie: cookie } }); }
    }
    return new Esp32Client({
        origin: ORIGIN,
        fetchImpl: (url, o = {}) => fetch(url, { ...o, headers: { ...o.headers, Cookie: cookie } }),
        WebSocketImpl: CookieWs,
    });
}

before(async () => {
    proc = spawn(process.execPath, [MOCK, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve) => proc.stdout.on('data', (d) => { if (String(d).includes('Simulador')) resolve(); }));
    const r = await fetch(`${ORIGIN}/api/login`, { method: 'POST', body: new URLSearchParams({ user: 'admin', pass: 'obd2admin' }) });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => proc?.kill());

test('pages: / is the shared panel with the ESP32 entry inlined', async () => {
    const html = await (await fetch(`${ORIGIN}/`, { headers: { Cookie: cookie } })).text();
    // The ESP32 build inlines CSS/JS/SVG in one HTML to avoid lwIP requests.
    assert.match(html, /<style>/);
    assert.match(html, /<script type="module">/);
    assert.doesNotMatch(html, /src="src\/main-esp32\.js"/);
    assert.doesNotMatch(html, /href="src\/styles\.css"/);
    // The bundle is the ESP32 entry, and carries the shared UI (including charts).
    assert.match(html, /api\/ws\/elm/);
    assert.match(html, /id="tab-live"/);
    assert.match(html, /id="tab-charts"/);
    assert.equal((await fetch(`${ORIGIN}/esp32`, { redirect: 'manual' })).status, 302, 'needs login');
});

test('no adapter saved yet: connecting explains where to set it up', async () => {
    const client = makeClient();
    const [p] = await client.listPorts();
    assert.match(p.friendlyName, /aún no tiene un ELM327/);
    await client.connect('esp32', 'SIM2K_33').catch(() => {});
    assert.match(client.session.state.error, /no tiene un adaptador ELM327 guardado/);
});

test('bridge: connect, live data, DTCs, Bluetooth drop + reconnect, takeover', { timeout: 90000 }, async () => {
    // Pair the adapter from the ESP32 page, as the user does once
    assert.equal((await api('/api/bt/connect', { mac: '00:1D:A5:00:00:01', name: 'OBDII', pin: '1234' })).status, 202);
    let s;
    for (let i = 0; i < 100 && !(s?.elm?.ready && !s.bt.busy); i++) { s = (await api('/api/state')).body; await new Promise(r => setTimeout(r, 100)); }
    assert.equal(s.bt.state, 'connected');

    const client = makeClient();
    let last;
    let samples = 0;
    const logs = [];
    client.on('state', (st) => { last = st; }).on('live', () => samples++).on('log', (l) => logs.push(l.msg));
    const [p] = await client.listPorts();
    assert.equal(p.path, 'esp32');
    assert.match(p.label, /OBDII 00:1D:A5:00:00:01/);

    await client.connect('esp32', 'SIM2K_33');
    assert.equal(last.status, 'connected', JSON.stringify(last));
    assert.match(last.port, /ELM327 por el ESP32/);

    // The ESP32 page is locked while the panel drives the adapter
    const busy = await api('/api/elm/voltage', {});
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /panel OBD2 está usando el adaptador/);
    assert.equal((await api('/api/state')).body.bridge.active, true);

    await client.startLive();
    await until(() => samples >= 3);
    const d = await client.readDtcs();
    assert.ok(d.dtcs.length > 0);

    // Bluetooth between the ESP32 and the ELM327 drops: the browser session
    // reconnects through a new bridge once the ESP32 has the adapter back.
    assert.equal((await api('/api/sim/drop', {})).status, 200);
    await until(() => last.status === 'reconnecting');
    await until(() => last.status === 'connected' && last.live?.running, 45000);
    const n = samples;
    await until(() => samples > n + 2);

    // A second phone connects: it takes the adapter, the first one stops.
    const other = makeClient();
    let otherLast;
    other.on('state', (st) => { otherLast = st; });
    await other.connect('esp32', 'SIM2K_33');
    assert.equal(otherLast.status, 'connected');
    await until(() => last.status === 'disconnected');
    assert.ok(logs.some(m => /Otro dispositivo tomó el control/.test(m)), logs.join('\n'));

    await other.disconnect();
    for (let i = 0; i < 40 && (await api('/api/state')).body.bridge.active; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal((await api('/api/state')).body.bridge.active, false, 'bridge released on disconnect');
});
