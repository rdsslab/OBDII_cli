/**
 * Firmware simulator: serves web/*.html and the same phase-1 API as the
 * ESP32 (login, Bluetooth, ELM327, settings, Server-Sent Events), with the
 * ELM327 simulated by SimTransport from @obdii/core. Use it to work on the
 * panel without the board:
 *
 *   node firmware/esp32-elm327/tools/mock-server.mjs [port]     (default 8032)
 *   npm run esp32:mock
 *
 * Login: admin / obd2admin (firmware defaults). The command allowlist is a
 * copy of lib/obd_text/src/obd_text.cpp checkCommand(); keep them in sync.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimTransport } from '../../../packages/core/src/sim-transport.js';
import { ELM327 } from '../../../packages/core/src/elm327.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(DIR, '../web');
const PORT = Number(process.argv[2] || process.env.PORT || 8032);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();

// ── state ─────────────────────────────────────────────────────
const cfg = { apSsid: 'OBD2-ESP32', apPass: 'obd2esp32', webUser: 'admin', webPass: 'obd2admin', elmMac: '', elmName: '', elmPin: '1234' };
const FAKE_DEVICES = [
    { mac: '00:1D:A5:00:00:01', name: 'OBDII', rssi: -58, likelyElm: true },
    { mac: '3C:2E:F9:11:22:33', name: 'Teléfono', rssi: -71, likelyElm: false },
    { mac: '9C:B6:D0:44:55:66', name: '', rssi: -88, likelyElm: false },
];
const st = {
    bt: { state: 'idle', mac: '', name: '', error: '', busy: false, job: '', autoReconnect: false },
    elm: { ready: false, version: '', protocol: '', voltage: null },
    ecu: 'sin probar',
};
let devices = [];
let sim = null;
let kwpFraming = false;
const sessions = new Map();
const guard = { fails: 0, lockedUntil: 0 };
const history = [];
let lastId = 0;
const sse = new Set();

function emit(event, data, id) {
    const payload = `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) res.write(payload);
}
function log(level, msg) {
    const l = { id: ++lastId, up: Date.now() - t0, level, msg };
    history.push(l);
    while (history.length > 120) history.shift();
    console.log(`[${level}] ${msg}`);
    emit('log', l, l.id);
}
const stateJson = () => ({
    fw: '0.1.0 (fase 1, simulador)', uptimeS: Math.round((Date.now() - t0) / 1000), heap: 112000, minHeap: 98000,
    wifiClients: 1, sessions: sessions.size, apSsid: cfg.apSsid,
    defaults: { web: cfg.webPass === 'obd2admin', ap: cfg.apPass === 'obd2esp32' }, ...structuredClone(st),
});
const pushState = () => emit('state', stateJson());
setInterval(pushState, 3000);

// ── allowlist (mirror of obd_text.cpp) ────────────────────────
function normalize(cmd) {
    const c = String(cmd).trim().toUpperCase();
    return c.startsWith('AT') ? c.replace(/ +/g, ' ') : c.replace(/ /g, '');
}
function checkCommand(raw) {
    const c = normalize(raw);
    if (!c) return 'Comando vacío';
    if (c.length > 40) return 'Comando demasiado largo';
    if (c.startsWith('AT')) {
        const a = c.slice(2).replace(/ /g, '');
        return ['PP', 'BRD', 'BRT', 'MA', 'MR', 'MT', 'CSM', 'SD', 'PB'].some(b => a.startsWith(b))
            ? 'Comando AT bloqueado: cambia el adaptador de forma permanente o monitorea el bus sin fin' : null;
    }
    if (c.length % 2 || !/^[0-9A-F]+$/.test(c)) return 'Los comandos de diagnóstico van en bytes hexadecimales (por ejemplo 2101)';
    const sid = parseInt(c.slice(0, 2), 16), sub = c.length >= 4 ? parseInt(c.slice(2, 4), 16) : -1;
    if ([0x01, 0x02, 0x03, 0x05, 0x06, 0x07, 0x09, 0x0A, 0x13, 0x17, 0x18, 0x1A, 0x21, 0x22, 0x3E, 0x81, 0x82].includes(sid)) return null;
    if (sid === 0x10) return [0x81, 0x89, 0xC0].includes(sub) ? null : 'Solo se permiten las sesiones 10 81, 10 89 y 10 C0 (10 85 es programación de la ECU)';
    if (sid === 0x04 || sid === 0x14) return 'Borrar códigos solo se hace desde la función con confirmación y PIN (fase 3)';
    if (sid === 0x11) return 'El reinicio de la ECU (11) está bloqueado';
    return 'Servicio bloqueado: solo se permiten lecturas (sin escrituras, rutinas ni pruebas de actuadores)';
}

// ── simulated ELM327 over "Bluetooth" ─────────────────────────
function sendRaw(cmd, timeout = 6000) {
    return new Promise((resolve) => {
        if (!sim) return resolve('TIMEOUT');
        log('t', cmd);
        let buf = '';
        const dec = new TextDecoder();
        const done = (text) => { sim.offData(onData); clearTimeout(timer); resolve(text); };
        const onData = (chunk) => {
            buf += dec.decode(chunk);
            if (buf.includes('>')) {
                const clean = buf.replace(/>/g, '').split(/[\r\n]+/).map(s => s.trim())
                    .filter(s => s && !/^(SEARCHING|BUS INIT:?\s*(OK|\.+))/i.test(s) && s.toUpperCase() !== cmd.toUpperCase()).join('\n');
                log('r', clean.replace(/\n/g, ' | ') || '(vacío)');
                done(clean);
            }
        };
        const timer = setTimeout(() => { log('r', 'TIMEOUT'); done('TIMEOUT'); }, timeout);
        sim.onData(onData);
        sim.write(`${cmd}\r`);
    });
}

async function job(name, fn) {
    if (st.bt.busy) throw Object.assign(new Error(`El adaptador está ocupado: espera a que termine «${st.bt.job}»`), { status: 409 });
    st.bt.busy = true; st.bt.job = name; pushState();
    (async () => { try { await fn(); } finally { st.bt.busy = false; st.bt.job = ''; pushState(); } })();
}

async function doInit() {
    st.elm.ready = false; st.ecu = 'sin probar';
    const r = await sendRaw('ATZ', 12000);
    const version = (r.match(/ELM327\s+v[\d.]+/i) || ['ELM327'])[0];
    kwpFraming = false;
    for (const c of ['ATE0', 'ATL0', 'ATS1', 'ATH0', 'ATAT2', 'ATST 96']) await sendRaw(c);
    const v = parseFloat((await sendRaw('ATRV')).match(/([\d.]+)\s*V/i)?.[1]);
    Object.assign(st.elm, { ready: true, version, voltage: Number.isFinite(v) ? v : null });
    log('i', `ELM327 listo: ${version}${Number.isFinite(v) ? ` · ${v.toFixed(1)} V` : ''}`);
}

async function doEcuTest() {
    if (!st.elm.ready) await doInit();
    log('i', 'Probando la ECU (KWP2000, solo lectura)...');
    for (const c of ['ATSP5', 'ATH1']) await sendRaw(c);
    kwpFraming = true;
    await sleep(200);
    await sendRaw('AT SH 81 11 F1');
    await sendRaw('AT WM 81 11 F1 3E');
    for (const session of ['1081', '1089']) {
        const r = await sendRaw(session, 12000);
        const m = ELM327.decodeKwpFrames(r);
        if (!m || !m[0]?.startsWith('50')) continue;
        log('i', `Sesión iniciada (${session})`);
        const d = ELM327.decodeKwpFrames(await sendRaw('2101'));
        if (d && d[0]?.startsWith('61')) log('i', `La ECU responde: bloque 21 01 con ${d[0].split(' ').length} bytes`);
        st.ecu = 'responde'; st.elm.protocol = 'ISO 14230-4 KWP (fast init)';
        return;
    }
    st.ecu = 'sin respuesta';
    log('w', 'La ECU no respondió. ¿Contacto en ON?');
}

// ── HTTP ──────────────────────────────────────────────────────
const cookieOf = (req) => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('obd_sess='))?.slice(9) || '';
const authed = (req) => sessions.has(cookieOf(req));
async function body(req) {
    let b = '';
    for await (const c of req) { b += c; if (b.length > 4000) break; }
    return Object.fromEntries(new URLSearchParams(b));
}
function json(res, code, data, headers = {}) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
}
const fail = (res, code, error) => json(res, code, { error });

const routes = {
    'POST /api/bt/scan': () => {
        if (st.bt.state === 'connected') throw Object.assign(new Error('Desconecta el adaptador antes de buscar'), { status: 409 });
        return job('buscar adaptadores', async () => {
            st.bt.state = 'scanning'; pushState();
            log('i', 'Buscando dispositivos Bluetooth (8 s)...');
            await sleep(2500);
            devices = FAKE_DEVICES;
            emit('scan', devices);
            log('i', `Búsqueda terminada: ${devices.length} dispositivo(s)`);
            st.bt.state = 'idle';
        });
    },
    'POST /api/bt/connect': (b) => {
        const mac = String(b.mac || '').toUpperCase();
        if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) throw Object.assign(new Error('MAC inválida (formato AA:BB:CC:DD:EE:FF)'), { status: 409 });
        if (st.bt.state === 'connected') throw Object.assign(new Error('Ya hay un adaptador conectado'), { status: 409 });
        return job('conectar', async () => {
            Object.assign(st.bt, { state: 'connecting', mac, name: b.name || st.bt.name, error: '' }); pushState();
            log('i', `Conectando con ${b.name ? b.name + ' ' : ''}${mac}...`);
            await sleep(1500);
            if (mac !== FAKE_DEVICES[0].mac) {
                Object.assign(st.bt, { state: 'error', error: 'No se pudo conectar. ¿Adaptador encendido (en el conector OBD) y PIN correcto?' });
                log('w', `No se pudo conectar con ${mac}`);
                return;
            }
            sim = new SimTransport({ latencyMs: 30, vary: true });
            await sim.open();
            Object.assign(st.bt, { state: 'connected', autoReconnect: true });
            Object.assign(cfg, { elmMac: mac, elmName: b.name || cfg.elmName, elmPin: b.pin || cfg.elmPin });
            log('i', `Conectado por Bluetooth a ${mac}`);
            await doInit();
        });
    },
    'POST /api/bt/disconnect': () => job('desconectar', async () => {
        await sim?.close(); sim = null;
        Object.assign(st.bt, { state: 'idle', autoReconnect: false, error: '' });
        st.elm.ready = false; st.ecu = 'sin probar';
        log('i', 'Adaptador desconectado (sin reconexión automática hasta que vuelvas a conectar)');
    }),
    'POST /api/elm/init': () => { needConn(); return job('inicializar ELM327', doInit); },
    'POST /api/elm/voltage': () => { needConn(); return job('leer voltaje', async () => { const v = parseFloat((await sendRaw('ATRV')).match(/([\d.]+)/)?.[1]); if (Number.isFinite(v)) st.elm.voltage = v; }); },
    'POST /api/elm/ecu-test': () => { needConn(); return job('probar ECU', doEcuTest); },
    'POST /api/elm/cmd': (b) => {
        needConn();
        const why = checkCommand(b.cmd);
        if (why) throw Object.assign(new Error(why), { status: 409 });
        const cmd = normalize(b.cmd);
        return job('comando', async () => {
            const r = await sendRaw(cmd, /^(81|10)/.test(cmd) ? 12000 : 6000);
            const a = cmd.replace(/ /g, '');
            if (a === 'ATH1') kwpFraming = true;
            if (['ATH0', 'ATZ', 'ATD', 'ATWS'].includes(a)) kwpFraming = false;
            if (!a.startsWith('AT') && kwpFraming) {
                for (const m of ELM327.decodeKwpFrames(r) || []) log('i', `Datos KWP (${m.split(' ').length} bytes): ${m}`);
            }
        });
    },
    'GET /api/settings': () => ({ apSsid: cfg.apSsid, webUser: cfg.webUser, elmMac: cfg.elmMac, elmName: cfg.elmName, elmPin: cfg.elmPin }),
    'POST /api/settings': (b) => {
        if (b.currentPass !== cfg.webPass) throw Object.assign(new Error('La clave actual no es correcta'), { status: 403 });
        if (b.apPass && (b.apPass.length < 8 || b.apPass.length > 63)) throw Object.assign(new Error('Clave de la red Wi-Fi: entre 8 y 63 caracteres'), { status: 400 });
        if (b.newPass && b.newPass.length < 8) throw Object.assign(new Error('Clave del panel: al menos 8 caracteres'), { status: 400 });
        let restart = false, relogin = false;
        if (b.apSsid && b.apSsid !== cfg.apSsid) { cfg.apSsid = b.apSsid; restart = true; }
        if (b.apPass && b.apPass !== cfg.apPass) { cfg.apPass = b.apPass; restart = true; }
        if (b.webUser && b.webUser !== cfg.webUser) { cfg.webUser = b.webUser; relogin = true; }
        if (b.newPass) { cfg.webPass = b.newPass; relogin = true; }
        if (b.elmPin) cfg.elmPin = b.elmPin;
        if (relogin) sessions.clear();
        log('i', `Ajustes guardados${restart ? ' (se reinicia para aplicar la red Wi-Fi)' : ''}`);
        return { ok: true, restart, relogin };
    },
    'POST /api/restart': () => { log('i', 'Reinicio solicitado desde el panel (simulador: no hace nada)'); return { ok: true }; },
    'GET /api/state': () => stateJson(),
    'GET /api/log': () => history,
    'GET /api/bt/devices': () => devices,
};
function needConn() { if (st.bt.state !== 'connected') throw Object.assign(new Error('Conecta el adaptador primero'), { status: 409 }); }

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
        if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/')) {
            if (url.pathname === '/' && !authed(req)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(await readFile(path.join(WEB, url.pathname === '/' ? 'index.html' : 'login.html')));
        }
        if (req.method === 'POST' && url.pathname === '/api/login') {
            if (Date.now() < guard.lockedUntil) return fail(res, 429, `Demasiados intentos. Espera ${Math.ceil((guard.lockedUntil - Date.now()) / 1000)} s.`);
            const b = await body(req);
            if (b.user !== cfg.webUser || b.pass !== cfg.webPass) {
                if (++guard.fails >= 5) { guard.fails = 0; guard.lockedUntil = Date.now() + 60000; }
                log('w', 'Intento de ingreso fallido');
                return fail(res, 403, 'Usuario o clave incorrectos');
            }
            guard.fails = 0;
            const token = crypto.randomBytes(16).toString('hex');
            sessions.set(token, Date.now());
            log('i', 'Ingreso al panel');
            return json(res, 200, { ok: true }, { 'Set-Cookie': `obd_sess=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200` });
        }
        if (req.method === 'POST' && url.pathname === '/api/logout') {
            sessions.delete(cookieOf(req));
            return json(res, 200, { ok: true }, { 'Set-Cookie': 'obd_sess=; Path=/; Max-Age=0' });
        }
        if (url.pathname.startsWith('/api/') && !authed(req)) return fail(res, 401, 'Sesión no iniciada');
        if (url.pathname === '/api/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(stateJson())}\n\n`);
            sse.add(res);
            req.on('close', () => sse.delete(res));
            return;
        }
        const h = routes[`${req.method} ${url.pathname}`];
        if (h) {
            const r = await h(req.method === 'POST' ? await body(req) : {});
            return r === undefined ? json(res, 202, { queued: true }) : json(res, 200, r);
        }
        if (url.pathname.startsWith('/api/')) return fail(res, 404, 'No encontrado');
        res.writeHead(302, { Location: '/login' });
        res.end();
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
}).listen(PORT, () => {
    console.log(`\n  Simulador del firmware ESP32: http://localhost:${PORT}  (admin / obd2admin)\n`);
    log('i', 'Bluetooth listo (modo maestro)');
});
