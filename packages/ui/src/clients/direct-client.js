/**
 * DirectClient: the UI runs the whole diagnostic session in the browser
 * (ObdSession from @obdii/core) and talks to the ELM327 through Web Serial.
 * Used by the PWA. Same contract as RemoteClient (see remote-client.js).
 *
 * Single user, so clearing DTCs asks for confirmation only (no PIN).
 */
import { ObdSession, listProfiles, generateHTMLReport } from '@obdii/core';
import {
    WebSerialTransport, requestPort, getGrantedPorts, describeSerialPort, isWebSerialSupported,
} from '@obdii/web-serial';

const NEW_PORT = 'new';

export class DirectClient {
    constructor() {
        this.listeners = {};
        this.capabilities = { choosePort: true, sharedSession: false, clearNeedsPin: false, webSerial: isWebSerialSupported() };
        this.ports = [];            // SerialPort objects, index = id
        this._reportUrl = null;
        this.session = new ObdSession({
            makeTransport: (port) => {
                const t = new WebSerialTransport(port);
                t.onClose(() => {
                    const st = this.session.state.status;
                    if (st === 'connected' || st === 'watch') {
                        this.session.linkLost('Se perdió la conexión con el adaptador (Bluetooth o USB)');
                    }
                });
                return t;
            },
            describePort: (port) => describeSerialPort(port),
        });
        for (const ev of ['live', 'dtcs', 'ecu-info', 'log', 'ecu-link']) this.session.on(ev, (d) => this._emit(ev, d));
        this.session.on('state', () => this._emit('state', this._state()));
        if (isWebSerialSupported()) {
            navigator.serial.addEventListener('disconnect', (e) => {
                const st = this.session.state.status;
                if (e.target === this.session.portRef && (st === 'connected' || st === 'watch')) {
                    this.session.linkLost('El adaptador se desconectó');
                }
            });
            // The adapter is back (Bluetooth re-linked): do not wait for the next retry.
            navigator.serial.addEventListener('connect', (e) => {
                if (e.target === this.session.portRef) this.session.reconnectNow();
            });
        }
        if (typeof document !== 'undefined') {
            // Android pauses the page in the background; retry as soon as it is visible again.
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && this.session.state.status === 'reconnecting') this.session.reconnectNow();
            });
        }
    }

    _state() {
        return { ...this.session.state, clearEnabled: true };
    }

    on(event, cb) {
        (this.listeners[event] ||= []).push(cb);
        return this;
    }

    _emit(event, data) {
        (this.listeners[event] || []).forEach(cb => cb(data));
    }

    start() {
        this._emit('link', { online: true });
        this._emit('state', this._state());
        if (!isWebSerialSupported()) {
            this._emit('log', { level: 'warn', msg: 'Este navegador no soporta Web Serial. Usa Chrome o Edge (en Android, Chrome reciente).', t: Date.now() });
        }
    }

    async listPorts() {
        this.ports = await getGrantedPorts();
        const list = this.ports.map((p, i) => {
            const name = describeSerialPort(p);
            return { path: String(i), label: `${name} (usado antes)`, friendlyName: name, bt: null, mac: null };
        });
        list.push({ path: NEW_PORT, label: 'Elegir adaptador…', friendlyName: 'Bluetooth emparejado o USB', bt: null, mac: null, isNew: true });
        return list;
    }

    async listProfiles() { return listProfiles(); }

    async _pick(path) {
        if (path === NEW_PORT || !this.ports[Number(path)]) {
            const port = await requestPort();    // must run inside the click handler
            if (!this.ports.includes(port)) this.ports.push(port);
            return port;
        }
        return this.ports[Number(path)];
    }

    async connect(path, profile) {
        return this.session.connect(await this._pick(path), profile);
    }

    /** ATRV only (ELM327, no ECU): works with the ignition off. */
    async watchBattery(path) {
        return this.session.watchBattery(await this._pick(path));
    }

    disconnect() { return this.session.disconnect(); }
    readVoltage() { return this.session.readVoltage(); }
    readDtcs() { return this.session.readDtcs(); }
    readEcuInfo() { return this.session.readEcuInfo(); }
    startLive() { return this.session.startLive(); }
    stopLive() { return this.session.stopLive(); }

    /** Confirmation happens in the UI; there is no PIN on a personal device. */
    clearDtcs() { return this.session.clearDtcs('este dispositivo'); }

    reportUrl() {
        const last = this.session.lastDtcs;
        if (!last) return null;
        if (this._reportUrl) URL.revokeObjectURL(this._reportUrl);
        const dtcs = last.dtcs.map(d => `${d.code}${d.detail ? ` [${d.detail}]` : ''}`);
        const html = generateHTMLReport(dtcs, new Date(last.t).toLocaleString());
        this._reportUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
        return this._reportUrl;
    }
}
