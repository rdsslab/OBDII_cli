/**
 * @obdii/server — local web server for the ELM327.
 *
 * The laptop talks to the ELM327 (COM port) and serves the shared web UI
 * (packages/ui) to every device on the local network. Live data is read
 * ONCE from the ECU and pushed to all browsers with Server-Sent Events.
 *
 * Read-only, except clearing DTCs: that endpoint exists only when the
 * server is started with a PIN (--pin or OBD_PIN), asks for it on every
 * request and refuses while the engine is running. Nothing resets the ECU
 * or drives actuators.
 *
 * Usage: node src/server.js [--port 3000] [--com COM6] [--profile SIM2K_33] [--sim] [--pin 1234]
 *   --sim  adds a simulated "SIM" port (real captures from the SIM2K-33),
 *          to try the UI without the car.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ELM327, Diagnostics, getProfile, listProfiles, generateHTMLReport } from '@obdii/core';
import { listPorts, describePort, NodeSerialTransport } from '@obdii/serial-node';
import { SimTransport } from '@obdii/core/sim-transport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '../../../packages/ui');
const CORE_DIR = path.resolve(__dirname, '../../../packages/core/src');

// ── CLI args ──────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]);
    return acc;
}, []));
const HTTP_PORT = Number(args.port || process.env.PORT || 3000);
const LIVE_MIN_INTERVAL_MS = 200;     // leaves bus time for other requests
const LIVE_MAX_FAILURES = 3;          // then try to recover the KWP session
const CLEAR_PIN = String(args.pin === true ? '' : args.pin ?? process.env.OBD_PIN ?? '');
if (CLEAR_PIN && CLEAR_PIN.length < 4) {
    console.error('  El PIN debe tener al menos 4 caracteres.');
    process.exit(1);
}
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 60_000;
const pinGuard = { fails: 0, lockedUntil: 0 };

// ── State shared by every client ──────────────────────────────
const state = {
    status: 'disconnected',  // disconnected | connecting | connected | error
    port: null,
    profile: null,
    mode: null,
    version: null,
    voltage: null,
    error: null,
    live: { running: false, source: null, hz: 0 },
    clients: 0,
    clearEnabled: !!CLEAR_PIN,
};
let elm = null;
let diag = null;
let lastDtcs = null;
let ecuInfoCache = null;
let liveLoop = null;
const sseClients = new Set();

const log = (level, msg) => {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    (level === 'warn' ? console.warn : console.log)(line);
    broadcast('log', { level, msg, t: Date.now() });
};

// TX/RX traces are only written to the log while recovering a lost
// session (to diagnose why), never during normal sampling.
let traceToLog = false;
const serverLogger = {
    debug: (label, value) => { if (traceToLog) log('debug', `${label}: ${value}`); },
    info: (m) => log('info', m),
    warn: (m) => log('warn', m),
};

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
}

function setState(patch) {
    Object.assign(state, patch);
    broadcast('state', state);
}

// ── ELM327 actions (serialized: one connect/disconnect at a time) ──
let actionChain = Promise.resolve();
const serial = (fn) => (actionChain = actionChain.then(fn, fn));

function makeTransport(portPath) {
    if (args.sim && portPath === 'SIM') return new SimTransport({ vary: true, latencyMs: 25, hangAfter: Number(args['sim-hang']) || 0 });
    if (args.sim && portPath === 'SIM-OFF') return new SimTransport({ engineOff: true, latencyMs: 25 });
    return new NodeSerialTransport(portPath);
}

async function connect(portPath, profileKey = 'SIM2K_33') {
    if (state.status === 'connected' || state.status === 'connecting') {
        throw new Error(`Ya conectado a ${state.port}`);
    }
    const profile = profileKey ? getProfile(profileKey) : null;
    setState({ status: 'connecting', port: portPath, error: null, profile: profile?.name || null });
    log('info', `Conectando a ${portPath}...`);
    const e = new ELM327({ logger: serverLogger });
    e.debug = false;
    try {
        await e.connect(makeTransport(portPath));
        await e.initialize(profile);
        elm = e;
        diag = new Diagnostics(e);
        lastDtcs = null;
        ecuInfoCache = null;
        const voltage = await diag.readVoltage();
        if (e.mode === 'unknown') {
            setState({ status: 'error', mode: e.mode, version: e.version, voltage, error: 'La ECU no respondió. ¿Contacto en ON?' });
            await e.disconnect();
            elm = diag = null;
            return;
        }
        setState({ status: 'connected', mode: e.mode, version: e.version, voltage });
        log('info', `Conectado: ${e.version}, modo ${e.mode}`);
    } catch (err) {
        try { await e.disconnect(); } catch { /* ignore */ }
        elm = diag = null;
        setState({ status: 'error', error: err.message });
        log('warn', err.message);
    }
}

async function disconnect() {
    await stopLive();
    if (elm) {
        log('info', 'Desconectando (82 + ATZ)...');
        try { await elm.disconnect(); } catch { /* ignore */ }
    }
    elm = diag = null;
    setState({ status: 'disconnected', mode: null, version: null, voltage: null, error: null });
}

function requireConnected() {
    if (!diag || state.status !== 'connected') {
        const err = new Error('No hay conexión con el vehículo');
        err.status = 409;
        throw err;
    }
}

// ── Live data loop (one reader, many viewers) ─────────────────
async function startLive() {
    requireConnected();
    if (liveLoop) return;
    const prep = await diag.prepareLive();
    if (!prep) throw new Error('No hay datos en tiempo real disponibles');
    let stop = false;
    let failures = 0;
    let recoveryLevel = 0;
    const times = [];
    const done = (async () => {
        while (!stop && diag) {
            const t0 = Date.now();
            let snap = null;
            try { snap = await diag.sampleLive(); } catch (err) { log('warn', err.message); }
            if (stop) break;
            if (snap) {
                failures = 0;
                times.push(t0);
                while (times.length && t0 - times[0] > 3000) times.shift();
                const hz = times.length > 1 ? (times.length - 1) / ((times.at(-1) - times[0]) / 1000) : 0;
                state.live.hz = Math.round(hz * 10) / 10;
                broadcast('live', { t: t0, fields: snap.fields, raw: snap.raw, hz: state.live.hz });
            } else if (++failures >= LIVE_MAX_FAILURES) {
                failures = 0;
                const ok = await recoverLink(++recoveryLevel);
                if (ok) recoveryLevel = 0;
                if (stop) break;
            }
            const wait = LIVE_MIN_INTERVAL_MS - (Date.now() - t0);
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
        }
    })();
    liveLoop = { stop: () => { stop = true; return done; } };
    setState({ live: { running: true, source: prep.source, hz: 0 } });
    log('info', `Tiempo real iniciado (${prep.source})`);
}

/**
 * Escalating recovery while live data is running:
 *   1. re-open the KWP session (fast; enough after an ignition blip)
 *   2. full ELM327 re-init (ATZ + config): the adapter may have rebooted,
 *      e.g. from the voltage dip while cranking the engine
 *   3+ close and re-open the serial port (Bluetooth link dropped)
 * TX/RX are traced to the log during recovery.
 */
async function recoverLink(level) {
    const step = Math.min(level, 3);
    const label = ['', 'reabriendo la sesión KWP', 'reinicializando el ELM327 (ATZ)', 'reabriendo el puerto'][step];
    log('warn', `Sin respuesta de la ECU; ${label} (≈6 s)...`);
    const prevDebug = elm.debug;
    elm.debug = true;
    traceToLog = true;
    let ok = false;
    try {
        if (step === 1) ok = await elm.recoverSession();
        else if (step === 2) ok = await elm.reinitialize();
        else {
            const portPath = state.port;
            try { await elm.port?.close(); } catch { /* ignore */ }
            elm.port = null;
            elm.connected = false;
            await new Promise(r => setTimeout(r, 2000));
            await elm.connect(makeTransport(portPath));
            ok = await elm.reinitialize();
        }
    } catch (err) {
        log('warn', `Recuperación: ${err.message}`);
    } finally {
        traceToLog = false;
        if (elm) elm.debug = prevDebug;
    }
    log(ok ? 'info' : 'warn', ok ? 'Sesión recuperada' : 'No se pudo recuperar; se reintentará');
    if (ok && elm) {
        const voltage = await diag.readVoltage().catch(() => null);
        setState({ mode: elm.mode, voltage });
    }
    return ok;
}

async function stopLive() {
    if (!liveLoop) return;
    const l = liveLoop;
    liveLoop = null;
    await l.stop();
    setState({ live: { running: false, source: null, hz: 0 } });
    log('info', 'Tiempo real detenido');
}

// ── Clear DTCs (the only write to the ECU) ───────────────────
function checkPin(pin) {
    const now = Date.now();
    if (now < pinGuard.lockedUntil) {
        const s = Math.ceil((pinGuard.lockedUntil - now) / 1000);
        throw Object.assign(new Error(`Demasiados intentos. Espera ${s} s.`), { status: 429 });
    }
    const a = crypto.createHash('sha256').update(String(pin ?? '')).digest();
    const b = crypto.createHash('sha256').update(CLEAR_PIN).digest();
    if (!crypto.timingSafeEqual(a, b)) {
        if (++pinGuard.fails >= PIN_MAX_FAILS) {
            pinGuard.fails = 0;
            pinGuard.lockedUntil = now + PIN_LOCK_MS;
        }
        throw Object.assign(new Error('PIN incorrecto'), { status: 403 });
    }
    pinGuard.fails = 0;
}

async function clearDtcs(pin, who) {
    if (!CLEAR_PIN) throw Object.assign(new Error('Borrado deshabilitado: inicia el servidor con --pin'), { status: 403 });
    checkPin(pin);
    requireConnected();
    log('warn', `Borrado de códigos solicitado desde ${who}`);
    const result = await diag.clearDtcs();
    if (result.after) {
        lastDtcs = { ...result.after, t: Date.now() };
        broadcast('dtcs', lastDtcs);
    }
    log(result.ok ? 'info' : 'warn', result.ok
        ? `Códigos borrados (respuesta ${result.response}). Quedan ${result.after?.dtcs.length ?? '?'}.`
        : result.error);
    return result;
}

// ── HTTP ──────────────────────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
}

async function readBody(req) {
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (body.length > 10_000) throw new Error('Body too large');
    }
    return body ? JSON.parse(body) : {};
}

async function serveStatic(res, baseDir, relPath) {
    const file = path.resolve(baseDir, '.' + path.posix.normalize('/' + relPath));
    if (!file.startsWith(baseDir)) return sendJson(res, 403, { error: 'forbidden' });
    try {
        const s = await stat(file);
        const target = s.isDirectory() ? path.join(file, 'index.html') : file;
        const data = await readFile(target);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
    } catch {
        sendJson(res, 404, { error: 'not found' });
    }
}

const routes = {
    'GET /api/state': () => state,
    'GET /api/profiles': () => listProfiles(),
    'GET /api/ports': async () => {
        const ports = (await listPorts()).map(p => ({ ...p, ...describePort(p) }));
        if (args.sim) {
            ports.unshift(
                { path: 'SIM', friendlyName: 'Simulador: motor en marcha (capturas reales del SIM2K-33)', bt: null, mac: null },
                { path: 'SIM-OFF', friendlyName: 'Simulador: motor apagado, contacto en ON', bt: null, mac: null },
            );
        }
        return ports;
    },
    'POST /api/connect': async (body) => {
        if (!body.port || !/^[\w./\\:-]+$/.test(body.port)) throw Object.assign(new Error('Puerto inválido'), { status: 400 });
        await serial(() => connect(body.port, body.profile ?? 'SIM2K_33'));
        return state;
    },
    'POST /api/disconnect': async () => { await serial(disconnect); return state; },
    'GET /api/voltage': async () => {
        requireConnected();
        const voltage = await diag.readVoltage();
        setState({ voltage });
        return { voltage };
    },
    'GET /api/dtcs': async () => {
        requireConnected();
        const result = await diag.readDtcs();
        lastDtcs = { ...result, t: Date.now() };
        broadcast('dtcs', lastDtcs);
        return lastDtcs;
    },
    'GET /api/dtcs/last': () => lastDtcs,
    'POST /api/dtcs/clear': (body, req) => clearDtcs(body.pin, req.socket.remoteAddress),
    'GET /api/ecu-info': async () => {
        requireConnected();
        ecuInfoCache = { ...(await diag.readEcuInfo()), t: Date.now() };
        broadcast('ecu-info', ecuInfoCache);
        return ecuInfoCache;
    },
    'GET /api/ecu-info/last': () => ecuInfoCache,
    'POST /api/live/start': async () => { await startLive(); return state; },
    'POST /api/live/stop': async () => { await stopLive(); return state; },
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
        if (url.pathname === '/api/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(state)}\n\n`);
            if (lastDtcs) res.write(`event: dtcs\ndata: ${JSON.stringify(lastDtcs)}\n\n`);
            if (ecuInfoCache) res.write(`event: ecu-info\ndata: ${JSON.stringify(ecuInfoCache)}\n\n`);
            sseClients.add(res);
            setState({ clients: sseClients.size });
            const ping = setInterval(() => res.write(': ping\n\n'), 20000);
            req.on('close', () => {
                clearInterval(ping);
                sseClients.delete(res);
                setState({ clients: sseClients.size });
            });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/report') {
            const dtcs = (lastDtcs?.dtcs || []).map(d => `${d.code}${d.detail ? ` [${d.detail}]` : ''}`);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(generateHTMLReport(dtcs, new Date(lastDtcs?.t || Date.now()).toLocaleString()));
        }

        const handler = routes[`${req.method} ${url.pathname}`];
        if (handler) {
            const body = req.method === 'POST' ? await readBody(req) : undefined;
            return sendJson(res, 200, await handler(body, req));
        }

        if (req.method !== 'GET') return sendJson(res, 404, { error: 'not found' });
        if (url.pathname.startsWith('/core/')) return serveStatic(res, CORE_DIR, url.pathname.slice(6));
        return serveStatic(res, UI_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    } catch (err) {
        sendJson(res, err.status || 500, { error: err.message });
    }
});

server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`\n  OBD2 web server listening on port ${HTTP_PORT}`);
    console.log(`  Local:   http://localhost:${HTTP_PORT}`);
    for (const nets of Object.values(os.networkInterfaces())) {
        for (const n of nets || []) {
            if (n.family === 'IPv4' && !n.internal) console.log(`  Red:     http://${n.address}:${HTTP_PORT}`);
        }
    }
    console.log(CLEAR_PIN ? '  Borrado de códigos: habilitado con PIN.' : '  Borrado de códigos: deshabilitado (usa --pin para habilitarlo).');
    console.log('  Ctrl+C para salir (cierra la sesión con la ECU).\n');
    if (args.com) serial(() => connect(args.com, args.profile ?? 'SIM2K_33'));
});

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log('\n  Cerrando...');
    for (const res of sseClients) res.end();
    await serial(disconnect).catch(() => {});
    server.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
