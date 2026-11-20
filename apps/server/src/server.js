/**
 * @obdii/server — local web server for the ELM327.
 *
 * The laptop talks to the ELM327 (COM port) and serves the shared web UI
 * (packages/ui) to every device on the local network. Live data is read
 * ONCE from the ECU and pushed to all browsers with Server-Sent Events.
 * The session logic itself (connect, live loop, recovery) is ObdSession
 * from @obdii/core, shared with the PWA.
 *
 * Read-only, except clearing DTCs: that endpoint exists only when the
 * server is started with a PIN (--pin or OBD_PIN), asks for it on every
 * request and refuses while the engine is running. Nothing resets the ECU
 * or drives actuators.
 *
 * Usage: node src/server.js [--port 3000] [--com COM6] [--profile SIM2K_33] [--sim] [--pin 1234] [--logs dir]
 *   --logs folder for trip recordings (default: logs/ in the repo)
 *   --sim  adds simulated "SIM" / "SIM-OFF" ports (real captures from the
 *          SIM2K-33), to try the UI without the car.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ObdSession, listProfiles, generateHTMLReport, AlertEngine, attachTripRecorder } from '@obdii/core';
import { listPorts, describePort, NodeSerialTransport } from '@obdii/serial-node';
import { SimTransport } from '@obdii/core/sim-transport.js';
import { TripFiles, TRIP_ID_RE, makeServerRecorder } from './trip-files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '../../../packages/ui');
const CORE_DIR = path.resolve(__dirname, '../../../packages/core/src');
const DEFAULT_LOGS_DIR = path.resolve(__dirname, '../../../logs');

// ── CLI args ──────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]);
    return acc;
}, []));
const HTTP_PORT = Number(args.port || process.env.PORT || 3000);
const CLEAR_PIN = String(args.pin === true ? '' : args.pin ?? process.env.OBD_PIN ?? '');
if (CLEAR_PIN && CLEAR_PIN.length < 4) {
    console.error('  El PIN debe tener al menos 4 caracteres.');
    process.exit(1);
}
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 60_000;
const pinGuard = { fails: 0, lockedUntil: 0 };

// ── Shared session ────────────────────────────────────────────
function makeTransport(portPath) {
    if (args.sim && portPath === 'SIM') {
        return new SimTransport({ vary: true, latencyMs: 25, hangAfter: Number(args['sim-hang']) || 0, scenario: args['sim-scenario'] || null });
    }
    if (args.sim && portPath === 'SIM-OFF') return new SimTransport({ engineOff: true, latencyMs: 25 });
    return new NodeSerialTransport(portPath);
}

const session = new ObdSession({ makeTransport });
const sseClients = new Set();

// ── Trip recording (logs/*.jsonl) ─────────────────────────────
// The server evaluates the alerts with the default thresholds only to write
// them into the recording; each browser still shows its own alerts.
const tripAlerts = new AlertEngine();
session
    .on('live', (s) => tripAlerts.update(s))
    .on('dtcs', (d) => tripAlerts.notify('dtcs', d?.dtcs || []))
    .on('ecu-link', (l) => tripAlerts.notify(l.ok ? 'link-ok' : 'link-lost', null, l.t))
    .on('state', (st) => { if (st.status === 'disconnected') tripAlerts.reset(); });
const tripRecorder = makeServerRecorder();
attachTripRecorder(tripRecorder, { session, alerts: tripAlerts });
const trips = new TripFiles(typeof args.logs === 'string' ? args.logs : DEFAULT_LOGS_DIR).attach(tripRecorder);
let tripTimer = null;

const publicState = () => ({ ...session.state, clients: sseClients.size, clearEnabled: !!CLEAR_PIN, trip: trips.status() });

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
}

session
    .on('state', () => broadcast('state', publicState()))
    .on('live', (s) => broadcast('live', s))
    .on('dtcs', (d) => broadcast('dtcs', d))
    .on('ecu-info', (d) => broadcast('ecu-info', d))
    .on('ecu-link', (d) => broadcast('ecu-link', d))
    .on('log', (entry) => {
        (entry.level === 'warn' ? console.warn : console.log)(`[${new Date(entry.t).toLocaleTimeString()}] ${entry.msg}`);
        broadcast('log', entry);
    });

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

function tripStart(body) {
    const st = session.state;
    const cur = trips.start({
        rate: body.rate,
        meta: { origen: 'servidor', perfil: st.profile || '—', adaptador: st.version || '—', puerto: st.port || '—' },
    });
    clearInterval(tripTimer);
    tripTimer = setInterval(() => broadcast('trip', trips.status()), 2000);
    broadcast('trip', trips.status());
    session.log('info', `Grabación iniciada en el servidor: ${cur.id}`);
    return trips.status();
}

async function tripStop() {
    clearInterval(tripTimer);
    tripTimer = null;
    const r = await trips.stop();
    broadcast('trip', trips.status());
    if (r) session.log('info', `Grabación detenida: ${r.id} (${r.samples} muestras, ${r.durationS} s)`);
    return { ...trips.status(), last: r };
}

async function clearDtcs(pin, who) {
    if (!CLEAR_PIN) throw Object.assign(new Error('Borrado deshabilitado: inicia el servidor con --pin'), { status: 403 });
    checkPin(pin);
    return session.clearDtcs(who);
}

// ── HTTP ──────────────────────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav',
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
    'GET /api/state': () => publicState(),
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
        await session.connect(body.port, body.profile ?? 'SIM2K_33');
        return publicState();
    },
    'POST /api/disconnect': async () => { await session.disconnect(); return publicState(); },
    'POST /api/battery-watch': async (body) => {
        if (!body.port || !/^[\w./\\:-]+$/.test(body.port)) throw Object.assign(new Error('Puerto inválido'), { status: 400 });
        await session.watchBattery(body.port);
        return publicState();
    },
    'GET /api/voltage': () => session.readVoltage(),
    'GET /api/dtcs': () => session.readDtcs(),
    'GET /api/dtcs/last': () => session.lastDtcs,
    'POST /api/dtcs/clear': (body, req) => clearDtcs(body.pin, req.socket.remoteAddress),
    'GET /api/ecu-info': () => session.readEcuInfo(),
    'GET /api/ecu-info/last': () => session.ecuInfo,
    'POST /api/live/start': async () => { await session.startLive(); return publicState(); },
    'POST /api/live/stop': async () => { await session.stopLive(); return publicState(); },
    'GET /api/trip': () => trips.status(),
    'POST /api/trip/start': (body) => tripStart(body),
    'POST /api/trip/stop': () => tripStop(),
    'GET /api/trips': () => trips.list(),
    'POST /api/trips/delete': (body) => {
        if (CLEAR_PIN) checkPin(body.pin);
        return trips.remove(String(body.id || ''));
    },
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
        if (url.pathname === '/api/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            sseClients.add(res);
            res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(publicState())}\n\n`);
            if (session.lastDtcs) res.write(`event: dtcs\ndata: ${JSON.stringify(session.lastDtcs)}\n\n`);
            if (session.ecuInfo) res.write(`event: ecu-info\ndata: ${JSON.stringify(session.ecuInfo)}\n\n`);
            broadcast('state', publicState());
            const ping = setInterval(() => res.write(': ping\n\n'), 20000);
            req.on('close', () => {
                clearInterval(ping);
                sseClients.delete(res);
                broadcast('state', publicState());
            });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/report') {
            const last = session.lastDtcs;
            const dtcs = (last?.dtcs || []).map(d => `${d.code}${d.detail ? ` [${d.detail}]` : ''}`);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(generateHTMLReport(dtcs, new Date(last?.t || Date.now()).toLocaleString()));
        }

        const tripCsv = req.method === 'GET' && url.pathname.match(/^\/api\/trips\/([\w-]+)\.csv$/);
        if (tripCsv) {
            if (!TRIP_ID_RE.test(tripCsv[1])) return sendJson(res, 400, { error: 'Registro inválido' });
            const csv = await trips.csv(tripCsv[1]).catch(() => null);
            if (csv == null) return sendJson(res, 404, { error: 'not found' });
            res.writeHead(200, {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="${tripCsv[1]}.csv"`,
                'Cache-Control': 'no-store',
            });
            return res.end('\uFEFF' + csv);
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
    console.log(`  Grabaciones: ${trips.dir}`);
    console.log(CLEAR_PIN ? '  Borrado de códigos: habilitado con PIN.' : '  Borrado de códigos: deshabilitado (usa --pin para habilitarlo).');
    console.log('  Ctrl+C para salir (cierra la sesión con la ECU).\n');
    if (args.com) session.connect(args.com, args.profile ?? 'SIM2K_33').catch(() => {});
});

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log('\n  Cerrando...');
    for (const res of sseClients) res.end();
    await tripStop().catch(() => {});
    await session.disconnect().catch(() => {});
    server.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
