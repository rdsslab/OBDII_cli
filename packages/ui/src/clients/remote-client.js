/**
 * RemoteClient: the UI talks to @obdii/server over HTTP + Server-Sent Events.
 *
 * Client contract shared with future clients (PWA DirectClient, Android):
 *   on(event, cb)   events: 'state', 'live', 'dtcs', 'ecu-info', 'log', 'ecu-link', 'link', 'trip'
 *   start()
 *   listPorts(), listProfiles(), connect(port, profile), disconnect(), watchBattery(port)
 *   readVoltage(), readDtcs(), readEcuInfo(), startLive(), stopLive()
 *   clearDtcs(pin)  (only when state.clearEnabled; the one write to the ECU)
 *   reportUrl()  (null when the platform has no server-side report)
 *   tripStart({rate}), tripStop(), tripList(), tripDelete(id, pin), tripCsvUrl(id)  (server-side recordings)
 *   capabilities: { choosePort, sharedSession, serverTrips }
 */
export class RemoteClient {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl;
        this.listeners = {};
        this.capabilities = { choosePort: true, sharedSession: true, serverTrips: true };
    }

    on(event, cb) {
        (this.listeners[event] ||= []).push(cb);
        return this;
    }

    _emit(event, data) {
        (this.listeners[event] || []).forEach(cb => cb(data));
    }

    start() {
        const es = new EventSource(`${this.baseUrl}/api/events`);
        es.onopen = () => this._emit('link', { online: true });
        es.onerror = () => this._emit('link', { online: false });
        for (const ev of ['state', 'live', 'dtcs', 'ecu-info', 'log', 'ecu-link', 'trip']) {
            es.addEventListener(ev, (e) => this._emit(ev, JSON.parse(e.data)));
        }
        this.es = es;
    }

    async _req(method, path, body) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    }

    listPorts() { return this._req('GET', '/api/ports'); }
    listProfiles() { return this._req('GET', '/api/profiles'); }
    connect(port, profile) { return this._req('POST', '/api/connect', { port, profile }); }
    disconnect() { return this._req('POST', '/api/disconnect'); }
    watchBattery(port) { return this._req('POST', '/api/battery-watch', { port }); }
    readVoltage() { return this._req('GET', '/api/voltage'); }
    readDtcs() { return this._req('GET', '/api/dtcs'); }
    clearDtcs(pin) { return this._req('POST', '/api/dtcs/clear', { pin }); }
    readEcuInfo() { return this._req('GET', '/api/ecu-info'); }
    startLive() { return this._req('POST', '/api/live/start'); }
    stopLive() { return this._req('POST', '/api/live/stop'); }
    reportUrl() { return `${this.baseUrl}/api/report`; }
    tripStart(opts = {}) { return this._req('POST', '/api/trip/start', { rate: opts.rate }); }
    tripStop() { return this._req('POST', '/api/trip/stop'); }
    tripList() { return this._req('GET', '/api/trips'); }
    tripDelete(id, pin) { return this._req('POST', '/api/trips/delete', { id, pin }); }
    tripCsvUrl(id) { return `${this.baseUrl}/api/trips/${encodeURIComponent(id)}.csv`; }
}
