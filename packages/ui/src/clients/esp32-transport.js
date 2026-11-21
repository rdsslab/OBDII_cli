/**
 * Transport for @obdii/core over the ESP32 bridge (firmware/esp32-elm327).
 *
 * The ESP32 keeps the Bluetooth link to the ELM327 and relays bytes through
 * a WebSocket at /api/ws/elm (needs the panel session cookie). The whole
 * diagnostic session (ObdSession) runs in the browser, exactly as in the PWA.
 *
 * Protocol:
 *   binary frames, both directions   raw bytes to / from the ELM327
 *   text frames from the ESP32 (JSON):
 *     {"type":"ready","name","mac"}   Bluetooth link up: bytes flow from now on
 *     {"type":"wait","reason"}        Bluetooth not connected yet (the ESP32 retries)
 *     {"type":"lost","reason"}        Bluetooth dropped; the socket closes next
 *   close codes:
 *     4001 another device took the adapter   4002 no adapter configured
 *     4003 the ESP32 is busy with a job from its own panel
 *
 * Implements the transport contract: open(), close(), write(text),
 * onData(cb), offData(cb), onClose(cb), isOpen.
 */
export const CLOSE_TAKEN = 4001;
export const CLOSE_NO_ADAPTER = 4002;
export const CLOSE_BUSY = 4003;

const OPEN_TIMEOUT_MS = 30000;      // the ESP32 retries Bluetooth every ~15 s

export class Esp32BridgeTransport {
    /**
     * @param {string} url - ws://host/api/ws/elm
     * @param {object} [o]
     * @param {number} [o.openTimeoutMs]
     * @param {typeof WebSocket} [o.WebSocketImpl] - for tests
     */
    constructor(url, { openTimeoutMs = OPEN_TIMEOUT_MS, WebSocketImpl = globalThis.WebSocket } = {}) {
        this.url = url;
        this.openTimeoutMs = openTimeoutMs;
        this.WebSocketImpl = WebSocketImpl;
        this.listeners = new Set();
        this.closeListeners = new Set();
        this.isOpen = false;
        this.adapter = null;          // {name, mac} from "ready"
        this.lastClose = null;        // {code, reason}
        this._ws = null;
        this._closing = false;
        this._encoder = new TextEncoder();
    }

    open() {
        if (!this.WebSocketImpl) return Promise.reject(new Error('Este navegador no soporta WebSocket'));
        this._closing = false;
        return new Promise((resolve, reject) => {
            let settled = false;
            let waitReason = '';
            const ws = new this.WebSocketImpl(this.url);
            ws.binaryType = 'arraybuffer';
            this._ws = ws;
            const fail = (msg) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { ws.close(); } catch { /* ignore */ }
                reject(new Error(msg));
            };
            const timer = setTimeout(() => fail(waitReason
                ? `El ESP32 no logró conectar el adaptador: ${waitReason}`
                : 'El ESP32 no respondió'), this.openTimeoutMs);

            ws.onmessage = (ev) => {
                if (typeof ev.data === 'string') {
                    let msg;
                    try { msg = JSON.parse(ev.data); } catch { return; }
                    if (msg.type === 'ready' && !settled) {
                        settled = true;
                        clearTimeout(timer);
                        this.adapter = { name: msg.name || '', mac: msg.mac || '' };
                        this.isOpen = true;
                        resolve();
                    } else if (msg.type === 'wait') {
                        waitReason = msg.reason || waitReason;
                    } else if (msg.type === 'lost') {
                        this.lastClose = { code: 0, reason: msg.reason || 'Se perdió la conexión Bluetooth con el adaptador' };
                    }
                    return;
                }
                if (!this.isOpen) return;
                const bytes = new Uint8Array(ev.data);
                if (bytes.length) this.listeners.forEach(cb => cb(bytes));
            };
            ws.onclose = (ev) => {
                const reason = ev.reason || this.lastClose?.reason || closeText(ev.code);
                this.lastClose = { code: ev.code, reason };
                if (!settled) return fail(reason);
                const wasOpen = this.isOpen;
                this.isOpen = false;
                if (wasOpen && !this._closing) this.closeListeners.forEach(cb => cb(this.lastClose));
            };
            ws.onerror = () => { /* onclose follows with the details */ };
        });
    }

    async write(text) {
        if (!this.isOpen || !this._ws) throw new Error('El adaptador no está conectado');
        this._ws.send(this._encoder.encode(text));
    }

    onData(cb) { this.listeners.add(cb); }
    offData(cb) { this.listeners.delete(cb); }
    /** cb({code, reason}) when the bridge closes without close() being called. */
    onClose(cb) { this.closeListeners.add(cb); }

    async close() {
        this._closing = true;
        this.isOpen = false;
        try { this._ws?.close(1000); } catch { /* ignore */ }
        this._ws = null;
        this.listeners.clear();
    }
}

function closeText(code) {
    switch (code) {
        case CLOSE_TAKEN: return 'Otro dispositivo tomó el control del adaptador';
        case CLOSE_NO_ADAPTER: return 'El ESP32 no tiene un adaptador ELM327 guardado: conéctalo en «Ajustes del ESP32»';
        case CLOSE_BUSY: return 'El ESP32 está ocupado con una prueba de su panel: espera a que termine';
        default: return 'Se perdió la conexión con el ESP32 (¿sigues en su red Wi-Fi?)';
    }
}
