/**
 * ObdSession — one shared diagnostic session, platform independent.
 *
 * Owns the ELM327 connection, the live-data loop (one reader, any number of
 * viewers) with escalating recovery, and the cached DTC / ECU results. Used
 * by @obdii/server (wrapped in HTTP + SSE) and by the PWA / Android
 * DirectClient (in the browser).
 *
 * The platform supplies makeTransport(portRef). Events (via on()):
 *   'state' (state object), 'live' ({t, fields, raw, hz}), 'dtcs', 'ecu-info',
 *   'log' ({level, msg, t}), 'ecu-link' ({ok, t}: communication lost / back)
 */
import { ELM327 } from './elm327.js';
import { Diagnostics } from './diagnostics.js';
import { getProfile } from './ecu-profiles.js';

const LIVE_MIN_INTERVAL_MS = 200;     // leaves bus time for other requests
const LIVE_MAX_FAILURES = 3;          // then start recovering the link
const DTC_POLL_MS = 180_000;          // re-read DTCs during live data (new-code alert)
const BATTERY_WATCH_MS = 30_000;      // ATRV period in battery-watch mode
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class ObdSession {
    /**
     * @param {object} o
     * @param {(portRef: any) => object} o.makeTransport
     * @param {(portRef: any) => string} [o.describePort] - label for logs/state
     * @param {number} [o.dtcPollMs] - DTC re-read period during live data (0 = off)
     * @param {number} [o.batteryWatchMs] - ATRV period in battery-watch mode
     */
    constructor({ makeTransport, describePort = (p) => String(p), dtcPollMs = DTC_POLL_MS, batteryWatchMs = BATTERY_WATCH_MS }) {
        this.makeTransport = makeTransport;
        this.dtcPollMs = dtcPollMs;
        this.batteryWatchMs = batteryWatchMs;
        this._watch = null;
        this.describePort = describePort;
        this.listeners = {};
        this.state = {
            status: 'disconnected',  // disconnected | connecting | connected | watch | error
            port: null,
            profile: null,
            mode: null,
            version: null,
            voltage: null,
            error: null,
            live: { running: false, source: null, hz: 0 },
        };
        this.elm = null;
        this.diag = null;
        this.portRef = null;
        this.lastDtcs = null;
        this.ecuInfo = null;
        this._liveLoop = null;
        this._traceToLog = false;
        this._chain = Promise.resolve();
        this._logger = {
            debug: (label, value) => { if (this._traceToLog) this.log('debug', `${label}: ${value}`); },
            info: (m) => this.log('info', m),
            warn: (m) => this.log('warn', m),
        };
    }

    // ── events ────────────────────────────────────────────────
    on(event, cb) { (this.listeners[event] ||= []).push(cb); return this; }
    emit(event, data) { (this.listeners[event] || []).forEach(cb => { try { cb(data); } catch { /* ignore */ } }); }
    log(level, msg) { this.emit('log', { level, msg, t: Date.now() }); }
    setState(patch) {
        Object.assign(this.state, patch);
        this.emit('state', this.state);
    }

    /** Serialize connect/disconnect so they never overlap. */
    _serial(fn) {
        const p = this._chain.then(fn, fn);
        this._chain = p.catch(() => {});
        return p;
    }

    requireConnected() {
        if (!this.diag || this.state.status !== 'connected') {
            throw Object.assign(new Error('No hay conexión con el vehículo'), { status: 409 });
        }
    }

    // ── connection ────────────────────────────────────────────
    connect(portRef, profileKey = 'SIM2K_33') {
        return this._serial(() => this._connect(portRef, profileKey));
    }

    async _connect(portRef, profileKey) {
        const st = this.state.status;
        if (st === 'connected' || st === 'connecting' || st === 'watch') throw new Error(`Ya conectado a ${this.state.port}`);
        const profile = profileKey ? getProfile(profileKey) : null;
        const label = this.describePort(portRef);
        this.setState({ status: 'connecting', port: label, error: null, profile: profile?.name || null });
        this.log('info', `Conectando a ${label}...`);
        const e = new ELM327({ logger: this._logger });
        e.debug = false;
        try {
            await e.connect(this.makeTransport(portRef));
            await e.initialize(profile);
            const diag = new Diagnostics(e);
            const voltage = await diag.readVoltage();
            if (e.mode === 'unknown') {
                this.setState({ status: 'error', mode: e.mode, version: e.version, voltage, error: 'La ECU no respondió. ¿Contacto en ON?' });
                await e.disconnect();
                return this.state;
            }
            this.elm = e;
            this.diag = diag;
            this.portRef = portRef;
            this.lastDtcs = null;
            this.ecuInfo = null;
            this.setState({ status: 'connected', mode: e.mode, version: e.version, voltage });
            this.log('info', `Conectado: ${e.version}, modo ${e.mode}`);
        } catch (err) {
            try { await e.disconnect(); } catch { /* ignore */ }
            this.setState({ status: 'error', error: err.message });
            this.log('warn', err.message);
        }
        return this.state;
    }

    disconnect() {
        return this._serial(async () => {
            await this.stopLive();
            await this._stopWatch();
            if (this.elm) {
                this.log('info', 'Desconectando (82 + ATZ)...');
                try { await this.elm.disconnect(); } catch { /* ignore */ }
            }
            this.elm = this.diag = null;
            this.setState({ status: 'disconnected', mode: null, version: null, voltage: null, error: null });
            return this.state;
        });
    }

    /** The transport reported that the link is gone (e.g. Web Serial disconnect). */
    async linkLost(reason = 'Se perdió la conexión con el adaptador') {
        this.log('warn', reason);
        this.emit('ecu-link', { ok: false, t: Date.now() });
        await this.stopLive().catch(() => {});
        try { await this.elm?.port?.close(); } catch { /* ignore */ }
        this.elm = this.diag = null;
        this.setState({ status: 'error', error: reason, mode: null, voltage: null });
    }

    // ── reads ─────────────────────────────────────────────────
    async readVoltage() {
        this.requireConnected();
        const voltage = await this.diag.readVoltage();
        this.setState({ voltage });
        return { voltage };
    }

    async readDtcs() {
        this.requireConnected();
        this.lastDtcs = { ...(await this.diag.readDtcs()), t: Date.now() };
        this.emit('dtcs', this.lastDtcs);
        return this.lastDtcs;
    }

    async readEcuInfo() {
        this.requireConnected();
        this.ecuInfo = { ...(await this.diag.readEcuInfo()), t: Date.now() };
        this.emit('ecu-info', this.ecuInfo);
        return this.ecuInfo;
    }

    /** WRITES TO THE ECU. Authorization (PIN, confirmation) is the caller's job. */
    async clearDtcs(who = 'local') {
        this.requireConnected();
        this.log('warn', `Borrado de códigos solicitado desde ${who}`);
        const result = await this.diag.clearDtcs();
        if (result.after) {
            this.lastDtcs = { ...result.after, t: Date.now() };
            this.emit('dtcs', this.lastDtcs);
        }
        this.log(result.ok ? 'info' : 'warn', result.ok
            ? `Códigos borrados (respuesta ${result.response}). Quedan ${result.after?.dtcs.length ?? '?'}.`
            : result.error);
        return result;
    }

    // ── live data ─────────────────────────────────────────────
    async startLive() {
        this.requireConnected();
        if (this._liveLoop) return this.state;
        const prep = await this.diag.prepareLive();
        if (!prep) throw new Error('No hay datos en tiempo real disponibles');
        let stop = false;
        let failures = 0;
        let recoveryLevel = 0;
        const times = [];
        let lastDtcPoll = Date.now();
        const done = (async () => {
            while (!stop && this.diag) {
                const t0 = Date.now();
                let snap = null;
                try { snap = await this.diag.sampleLive(); } catch (err) { this.log('warn', err.message); }
                if (stop) break;
                if (snap) {
                    failures = 0;
                    times.push(t0);
                    while (times.length && t0 - times[0] > 3000) times.shift();
                    const hz = times.length > 1 ? (times.length - 1) / ((times.at(-1) - times[0]) / 1000) : 0;
                    this.state.live.hz = Math.round(hz * 10) / 10;
                    this.emit('live', { t: t0, fields: snap.fields, raw: snap.raw, hz: this.state.live.hz });
                    if (this.dtcPollMs && t0 - lastDtcPoll >= this.dtcPollMs) {
                        lastDtcPoll = t0;
                        await this.readDtcs().catch(err => this.log('warn', `Lectura periódica de códigos: ${err.message}`));
                    }
                } else if (++failures >= LIVE_MAX_FAILURES) {
                    failures = 0;
                    const ok = await this._recoverLink(++recoveryLevel);
                    if (ok) recoveryLevel = 0;
                    if (stop) break;
                }
                const wait = LIVE_MIN_INTERVAL_MS - (Date.now() - t0);
                if (wait > 0) await sleep(wait);
            }
        })();
        this._liveLoop = { stop: () => { stop = true; return done; } };
        this.setState({ live: { running: true, source: prep.source, hz: 0 } });
        this.log('info', `Tiempo real iniciado (${prep.source})`);
        return this.state;
    }

    /**
     * Battery watch: talks to the ELM327 only (no ECU, works with the
     * ignition OFF) and reads the battery voltage (ATRV) periodically.
     * Samples are emitted as 'live' events with a single voltage field.
     */
    watchBattery(portRef) {
        return this._serial(async () => {
            const st = this.state.status;
            if (st === 'connected' || st === 'connecting' || st === 'watch') throw new Error(`Ya conectado a ${this.state.port}`);
            const label = this.describePort(portRef);
            this.setState({ status: 'connecting', port: label, error: null, profile: null, mode: null });
            const e = new ELM327({ logger: this._logger });
            e.debug = false;
            try {
                await e.connect(this.makeTransport(portRef));
                let r = await e.sendRaw('ATZ', 12000);
                if (r === 'TIMEOUT') r = await e.sendRaw('ATZ', 12000);
                if (r === 'TIMEOUT') throw new Error('El puerto no responde como un ELM327 (sin respuesta a ATZ).');
                await e.sendRaw('ATE0', 3000);
                this.elm = e;
                this.portRef = portRef;
                const diag = new Diagnostics(e);
                let stop = false;
                const loop = (async () => {
                    while (!stop) {
                        const voltage = await diag.readVoltage().catch(() => null);
                        if (stop) break;
                        if (voltage != null) {
                            this.setState({ voltage });
                            this.emit('live', { t: Date.now(), fields: [{ name: 'Battery Voltage (ELM327)', value: voltage, unit: 'V', confirmed: true }], raw: '', hz: 0 });
                        }
                        for (let w = 0; w < this.batteryWatchMs && !stop; w += 250) await sleep(250);
                    }
                })();
                this._watch = { stop: () => { stop = true; return loop; } };
                this.setState({ status: 'watch', version: e.extractVersion(r), mode: 'atrv', live: { running: true, source: 'Vigilancia de batería (ATRV)', hz: 0 } });
                this.log('info', `Vigilancia de batería iniciada: ATRV cada ${Math.round(this.batteryWatchMs / 1000)} s, sin la ECU.`);
            } catch (err) {
                try { await e.disconnect(); } catch { /* ignore */ }
                this.setState({ status: 'error', error: err.message });
                this.log('warn', err.message);
            }
            return this.state;
        });
    }

    async _stopWatch() {
        if (!this._watch) return;
        const w = this._watch;
        this._watch = null;
        await w.stop();
        try { await this.elm?.disconnect(); } catch { /* ignore */ }
        this.elm = null;
        this.setState({ live: { running: false, source: null, hz: 0 } });
        this.log('info', 'Vigilancia de batería detenida');
    }

    async stopLive() {
        if (!this._liveLoop) return this.state;
        const l = this._liveLoop;
        this._liveLoop = null;
        await l.stop();
        this.setState({ live: { running: false, source: null, hz: 0 } });
        this.log('info', 'Tiempo real detenido');
        return this.state;
    }

    /**
     * Escalating recovery while live data is running:
     *   1. re-open the KWP session (fast; enough after an ignition blip)
     *   2. full ELM327 re-init (ATZ + config): the adapter may have rebooted,
     *      e.g. from the voltage dip while cranking the engine
     *   3+ close and re-open the transport (Bluetooth link dropped)
     * TX/RX are traced to the log during recovery.
     */
    async _recoverLink(level) {
        const elm = this.elm;
        if (!elm) return false;
        const step = Math.min(level, 3);
        if (step === 1) this.emit('ecu-link', { ok: false, t: Date.now() });
        const label = ['', 'reabriendo la sesión KWP', 'reinicializando el ELM327 (ATZ)', 'reabriendo el puerto'][step];
        this.log('warn', `Sin respuesta de la ECU; ${label} (≈6 s)...`);
        const prevDebug = elm.debug;
        elm.debug = true;
        this._traceToLog = true;
        let ok = false;
        try {
            if (step === 1) ok = await elm.recoverSession();
            else if (step === 2) ok = await elm.reinitialize();
            else {
                try { await elm.port?.close(); } catch { /* ignore */ }
                elm.port = null;
                elm.connected = false;
                await sleep(2000);
                await elm.connect(this.makeTransport(this.portRef));
                ok = await elm.reinitialize();
            }
        } catch (err) {
            this.log('warn', `Recuperación: ${err.message}`);
        } finally {
            this._traceToLog = false;
            elm.debug = prevDebug;
        }
        this.log(ok ? 'info' : 'warn', ok ? 'Sesión recuperada' : 'No se pudo recuperar; se reintentará');
        if (ok) this.emit('ecu-link', { ok: true, t: Date.now() });
        if (ok && this.diag) {
            const voltage = await this.diag.readVoltage().catch(() => null);
            this.setState({ mode: elm.mode, voltage });
        }
        return ok;
    }
}
