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
 *
 * Link loss (Bluetooth dropped, adapter unplugged, ECU silent for good):
 * with autoReconnect (default) the session goes to 'reconnecting' and
 * retries the full connection with growing delays, then resumes live data
 * (or the battery watch) by itself. disconnect() cancels it.
 */
import { ELM327 } from './elm327.js';
import { Diagnostics } from './diagnostics.js';
import { getProfile } from './ecu-profiles.js';
import { SpeedSpikeFilter } from './speed-filter.js';

const LIVE_MIN_INTERVAL_MS = 200;     // leaves bus time for other requests
const LIVE_MAX_FAILURES = 3;          // then start recovering the link
const DTC_POLL_MS = 180_000;          // re-read DTCs during live data (new-code alert)
const BATTERY_WATCH_MS = 30_000;      // ATRV period in battery-watch mode
const LIVE_GIVE_UP_LEVEL = 5;         // recovery steps before a full reconnect
const LIVE_VOLTAGE_MS = 15_000;       // ATRV refresh during live data (header chip)
const RECONNECT_DELAYS_MS = [2000, 4000, 8000, 15000, 30000];   // last one repeats
const RECONNECT_MAX_MS = 30 * 60_000; // then stop and show the error
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class ObdSession {
    /**
     * @param {object} o
     * @param {(portRef: any) => object} o.makeTransport
     * @param {(portRef: any) => string} [o.describePort] - label for logs/state
     * @param {number} [o.dtcPollMs] - DTC re-read period during live data (0 = off)
     * @param {number} [o.batteryWatchMs] - ATRV period in battery-watch mode
     * @param {boolean} [o.autoReconnect=true] - reconnect by itself after a link loss
     * @param {number[]} [o.reconnectDelaysMs] - waits between attempts (last repeats)
     * @param {number} [o.reconnectMaxMs] - give up after this long
     * @param {number} [o.liveVoltageMs] - ATRV refresh period during live data (0 = off)
     */
    constructor({
        makeTransport, describePort = (p) => String(p), dtcPollMs = DTC_POLL_MS, batteryWatchMs = BATTERY_WATCH_MS,
        autoReconnect = true, reconnectDelaysMs = RECONNECT_DELAYS_MS, reconnectMaxMs = RECONNECT_MAX_MS,
        liveVoltageMs = LIVE_VOLTAGE_MS,
    }) {
        this.liveVoltageMs = liveVoltageMs;
        this.makeTransport = makeTransport;
        this.autoReconnect = autoReconnect;
        this.reconnectDelaysMs = reconnectDelaysMs;
        this.reconnectMaxMs = reconnectMaxMs;
        this._reconnect = null;      // {cancelled, wake} while reconnecting
        this._profileKey = null;
        this.dtcPollMs = dtcPollMs;
        this.batteryWatchMs = batteryWatchMs;
        this._watch = null;
        this.describePort = describePort;
        this.listeners = {};
        this.state = {
            status: 'disconnected',  // disconnected | connecting | connected | watch | reconnecting | error
            port: null,
            profile: null,
            mode: null,
            version: null,
            voltage: null,
            error: null,
            live: { running: false, source: null, hz: 0 },
            reconnect: null,         // {attempt, nextAt, since} while reconnecting
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
        this._cancelReconnect();
        return this._serial(() => this._connect(portRef, profileKey));
    }

    async _connect(portRef, profileKey, { quiet = false } = {}) {
        const st = this.state.status;
        if (st === 'connected' || st === 'connecting' || st === 'watch') throw new Error(`Ya conectado a ${this.state.port}`);
        this._profileKey = profileKey;
        const profile = profileKey ? getProfile(profileKey) : null;
        const label = this.describePort(portRef);
        if (!quiet) this.setState({ status: 'connecting', port: label, error: null, profile: profile?.name || null });
        if (!quiet) this.log('info', `Conectando a ${label}...`);
        const e = new ELM327({ logger: this._logger });
        e.debug = false;
        try {
            await e.connect(this.makeTransport(portRef));
            await e.initialize(profile);
            const diag = new Diagnostics(e);
            const voltage = await diag.readVoltage();
            if (e.mode === 'unknown') {
                this.portRef = portRef;
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
            if (!quiet) this.log('warn', err.message);
        }
        return this.state;
    }

    disconnect() {
        this._cancelReconnect();
        return this._serial(async () => {
            await this.stopLive();
            await this._stopWatch();
            if (this.elm) {
                this.log('info', 'Desconectando (82 + ATZ)...');
                try { await this.elm.disconnect(); } catch { /* ignore */ }
            }
            this.elm = this.diag = null;
            this.setState({ status: 'disconnected', mode: null, version: null, voltage: null, error: null, reconnect: null });
            return this.state;
        });
    }

    /** The transport reported that the link is gone (e.g. Web Serial disconnect). */
    linkLost(reason = 'Se perdió la conexión con el adaptador') {
        return this._linkDown(reason);
    }

    /** Skip the current wait and try to reconnect now (e.g. the app came back to the foreground). */
    reconnectNow() {
        this._reconnect?.wake?.();
    }

    _cancelReconnect() {
        if (!this._reconnect) return;
        this._reconnect.cancelled = true;
        this._reconnect.wake?.();
    }

    /**
     * Link gone: tear down what is left and, with autoReconnect, retry the
     * full connection until it works (then resume live data / battery
     * watch), the user disconnects, or reconnectMaxMs passes.
     */
    async _linkDown(reason, { fromLoop = false } = {}) {
        if (this._reconnect) return;                      // already handling it
        const wasWatch = this.state.status === 'watch' || !!this._watch;
        const resumeLive = !!this._liveLoop || fromLoop;
        const portRef = this.portRef;
        const profileKey = this._profileKey;
        const rc = { cancelled: false, wake: null };
        this._reconnect = rc;                             // set before any await
        this.log('warn', reason);
        this.emit('ecu-link', { ok: false, t: Date.now() });
        if (!fromLoop) await this.stopLive().catch(() => {});
        if (this._watch) { const w = this._watch; this._watch = null; await w.stop().catch(() => {}); }
        try { await this.elm?.port?.close(); } catch { /* ignore */ }
        this.elm = this.diag = null;
        const base = { mode: null, voltage: null, live: { running: false, source: null, hz: 0 } };

        if (!this.autoReconnect || portRef == null || rc.cancelled) {
            this._reconnect = null;
            if (!rc.cancelled) this.setState({ ...base, status: 'error', error: reason, reconnect: null });
            return;
        }

        const since = Date.now();
        let attempt = 0;
        while (!rc.cancelled) {
            const delay = this.reconnectDelaysMs[Math.min(attempt, this.reconnectDelaysMs.length - 1)];
            if (Date.now() + delay - since > this.reconnectMaxMs) break;
            this.setState({ ...base, status: 'reconnecting', error: reason, reconnect: { attempt: attempt + 1, nextAt: Date.now() + delay, since } });
            await new Promise(resolve => { const t = setTimeout(resolve, delay); rc.wake = () => { clearTimeout(t); resolve(); }; });
            rc.wake = null;
            if (rc.cancelled) break;
            attempt++;
            if (attempt === 1 || attempt % 5 === 0) this.log('info', `Reconectando automáticamente (intento ${attempt})...`);
            await this._serial(async () => {
                if (rc.cancelled) return;
                this.setState({ status: 'reconnecting', reconnect: { attempt, nextAt: null, since } });
                if (wasWatch) await this._watchBattery(portRef, { quiet: true });
                else await this._connect(portRef, profileKey, { quiet: true });
            }).catch(() => {});
            if (rc.cancelled) {
                // disconnect() came in while this attempt was connecting: undo it
                if (this.state.status === 'connected' || this.state.status === 'watch') await this.disconnect();
                break;
            }
            const st = this.state.status;
            if (st === 'connected' || st === 'watch') {
                this._reconnect = null;
                this.setState({ reconnect: null, error: null });
                this.log('info', `Reconectado automáticamente (intento ${attempt}, ${Math.round((Date.now() - since) / 1000)} s sin enlace)`);
                this.emit('ecu-link', { ok: true, t: Date.now() });
                if (st === 'connected' && resumeLive) {
                    await this.startLive().catch(err => this.log('warn', `No se pudo retomar el tiempo real: ${err.message}`));
                }
                return;
            }
        }
        this._reconnect = null;
        if (!rc.cancelled) {
            this.setState({ ...base, status: 'error', reconnect: null, error: `${reason}. No se pudo reconectar en ${Math.round(this.reconnectMaxMs / 60000)} min: conecta de nuevo a mano.` });
            this.log('warn', 'Reconexión automática agotada');
        }
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
        let linkDown = false;              // 'ecu-link' false was emitted
        let lastFailLog = 0;
        const times = [];
        let lastDtcPoll = Date.now();
        let lastVoltage = Date.now();
        let lostByLoop = false;
        let lastSpikeLog = 0;
        const speedFilter = new SpeedSpikeFilter();
        this.speedFilter = speedFilter;
        const done = (async () => {
            while (!stop && this.diag) {
                const t0 = Date.now();
                let snap = null;
                let why = null;
                try { snap = await this.diag.sampleLive(); } catch (err) { why = err.message; }
                if (stop) break;
                if (snap) {
                    failures = 0;
                    if (recoveryLevel) this.log('info', 'Datos en tiempo real recuperados');
                    recoveryLevel = 0;
                    if (linkDown) { linkDown = false; this.emit('ecu-link', { ok: true, t: Date.now() }); }
                    times.push(t0);
                    while (times.length && t0 - times[0] > 3000) times.shift();
                    const hz = times.length > 1 ? (times.length - 1) / ((times.at(-1) - times[0]) / 1000) : 0;
                    this.state.live.hz = Math.round(hz * 10) / 10;
                    const spike = speedFilter.apply(snap, t0);
                    if (spike && t0 - lastSpikeLog > 10_000) {
                        lastSpikeLog = t0;
                        this.log('warn', `Pico de velocidad descartado: la ECU envió ${spike.raw} km/h, se muestra ${spike.shown} (sensor de velocidad, P0501)`);
                    }
                    this.emit('live', { t: t0, fields: snap.fields, raw: snap.raw, hz: this.state.live.hz });
                    if (this.dtcPollMs && t0 - lastDtcPoll >= this.dtcPollMs) {
                        lastDtcPoll = t0;
                        await this.readDtcs().catch(err => this.log('warn', `Lectura periódica de códigos: ${err.message}`));
                    }
                    if (this.liveVoltageMs && t0 - lastVoltage >= this.liveVoltageMs) {
                        lastVoltage = t0;
                        const v = await this.diag?.readVoltage().catch(() => null);
                        if (v != null && v !== this.state.voltage) this.setState({ voltage: v });
                    }
                } else {
                    failures++;
                    // say why (at most every 10 s): NO DATA, incomplete answer, other length...
                    if (Date.now() - lastFailLog > 10_000) {
                        lastFailLog = Date.now();
                        this.log('warn', `Lectura en tiempo real fallida: ${why || this.elm?.lastBlockError || 'sin datos'}`);
                    }
                    if (failures >= LIVE_MAX_FAILURES) {
                        failures = 0;
                        const level = ++recoveryLevel;
                        // a soft retry first; the user only hears about it if that is not enough
                        if (level >= 2 && !linkDown) { linkDown = true; this.emit('ecu-link', { ok: false, t: Date.now() }); }
                        const ok = await this._recoverLink(level);
                        if (stop) break;
                        if (!ok && this.autoReconnect && recoveryLevel >= LIVE_GIVE_UP_LEVEL) { lostByLoop = true; break; }
                    }
                }
                const wait = LIVE_MIN_INTERVAL_MS - (Date.now() - t0);
                if (wait > 0) await sleep(wait);
            }
        })();
        const loop = { stop: () => { stop = true; return done; } };
        this._liveLoop = loop;
        done.then(() => {
            if (!lostByLoop || this._liveLoop !== loop) return;
            this._liveLoop = null;
            this._linkDown('La ECU o el adaptador dejaron de responder', { fromLoop: true });
        });
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
        this._cancelReconnect();
        return this._serial(() => this._watchBattery(portRef));
    }

    async _watchBattery(portRef, { quiet = false } = {}) {
        {
            const st = this.state.status;
            if (st === 'connected' || st === 'connecting' || st === 'watch') throw new Error(`Ya conectado a ${this.state.port}`);
            const label = this.describePort(portRef);
            this.portRef = portRef;
            if (!quiet) this.setState({ status: 'connecting', port: label, error: null, profile: null, mode: null });
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
                let misses = 0;
                const loop = (async () => {
                    while (!stop) {
                        const voltage = await diag.readVoltage().catch(() => null);
                        if (stop) break;
                        // 3 silent reads in a row: the adapter is gone
                        if (voltage == null && ++misses >= 3 && this.autoReconnect) {
                            setTimeout(() => this._linkDown('El adaptador dejó de responder (vigilancia de batería)'), 0);
                            break;
                        }
                        if (voltage != null) {
                            misses = 0;
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
                if (!quiet) this.log('warn', err.message);
            }
            return this.state;
        }
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
     * Escalating recovery while live data is running (the level only goes
     * back to 0 when a sample is read again):
     *   1. soft: check the adapter (ATRV) and just retry; a slow or garbled
     *      answer over Bluetooth needs nothing more
     *   2. re-open the KWP session (enough after an ignition blip)
     *   3. full ELM327 re-init (ATZ + config): the adapter may have rebooted,
     *      e.g. from the voltage dip while cranking the engine
     *   4+ close and re-open the transport (Bluetooth link dropped)
     * TX/RX are traced to the log during recovery.
     */
    async _recoverLink(level) {
        const elm = this.elm;
        if (!elm) return false;
        const step = Math.min(level, 4);
        if (step === 1) {
            const v = await this.diag?.readVoltage().catch(() => null);
            if (v == null) { this.log('warn', 'El adaptador no responde a ATRV'); return false; }
            this.log('info', `Adaptador responde (${v} V); reintentando la lectura sin reiniciar`);
            await sleep(1000);
            return true;
        }
        const label = ['', '', 'reabriendo la sesión KWP', 'reinicializando el ELM327 (ATZ)', 'reabriendo el puerto'][step];
        this.log('warn', `Sin respuesta de la ECU; ${label} (≈6 s)...`);
        const prevDebug = elm.debug;
        elm.debug = true;
        this._traceToLog = true;
        let ok = false;
        try {
            if (step === 2) ok = await elm.recoverSession();
            else if (step === 3) ok = await elm.reinitialize();
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
        if (ok && this.diag) {
            const voltage = await this.diag.readVoltage().catch(() => null);
            this.setState({ mode: elm.mode, voltage });
        }
        return ok;
    }
}
