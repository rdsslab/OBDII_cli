/**
 * Esp32Client: the panel served by the ESP32 (firmware/esp32-elm327).
 * Same as the PWA's DirectClient — the whole session runs in this browser —
 * but the bytes go through the ESP32's WebSocket bridge instead of Web
 * Serial. The ESP32 owns the Bluetooth link to the ELM327 (pairing, PIN,
 * auto-reconnect); this page never picks a port.
 *
 * One device drives the adapter at a time: connecting from another phone
 * takes the adapter over and this page stops (no reconnect ping-pong).
 */
import { DirectClient } from './direct-client.js';
import { Esp32BridgeTransport, CLOSE_TAKEN } from './esp32-transport.js';

const PORT_ID = 'esp32';

export class Esp32Client extends DirectClient {
    /**
     * @param {object} [o]
     * @param {string} [o.origin] - http://192.168.4.1 (default: this page)
     * @param {typeof fetch} [o.fetchImpl]
     * @param {typeof WebSocket} [o.WebSocketImpl]
     * @param {number} [o.openTimeoutMs]
     */
    constructor({ origin = globalThis.location?.origin, fetchImpl = globalThis.fetch?.bind(globalThis), WebSocketImpl, openTimeoutMs } = {}) {
        const wsUrl = `${origin.replace(/^http/, 'ws')}/api/ws/elm`;
        let self;
        super({
            makeTransport: () => {
                const t = new Esp32BridgeTransport(wsUrl, { WebSocketImpl, openTimeoutMs });
                t.onClose((info) => self._bridgeClosed(info));
                return t;
            },
            describePort: () => self._label(),
            capabilities: { choosePort: false, sharedSession: false, clearNeedsPin: false, esp32: true },
        });
        self = this;
        this.origin = origin;
        this.fetchImpl = fetchImpl;
        this.adapter = { name: '', mac: '', state: '' };
    }

    _label() {
        const a = this.adapter;
        return `ELM327 por el ESP32${a.name || a.mac ? ` (${[a.name, a.mac].filter(Boolean).join(' ')})` : ''}`;
    }

    _bridgeClosed({ code, reason }) {
        const st = this.session.state.status;
        if (st !== 'connected' && st !== 'watch') return;
        if (code === CLOSE_TAKEN) {
            this._emit('log', { level: 'warn', msg: `${reason}. Esta pantalla se detuvo; pulsa «Conectar» para recuperarlo.`, t: Date.now() });
            this.session.disconnect();
            return;
        }
        this.session.linkLost(reason);
    }

    /** ESP32 state (adapter saved / connected); a lapsed login goes to /login. */
    async _esp32State() {
        const r = await this.fetchImpl(`${this.origin}/api/state`, { cache: 'no-store' });
        if (r.status === 401) {
            if (globalThis.location) globalThis.location.href = '/login';
            throw new Error('Sesión del ESP32 vencida: vuelve a ingresar');
        }
        if (!r.ok) throw new Error(`El ESP32 respondió ${r.status}`);
        return r.json();
    }

    async listPorts() {
        let friendly = 'Configura el adaptador en «Ajustes del ESP32».';
        try {
            const s = await this._esp32State();
            this.adapter = { name: s.bt?.name || '', mac: s.bt?.mac || '', state: s.bt?.state || '' };
            if (!this.adapter.mac) friendly = 'El ESP32 aún no tiene un ELM327 guardado: búscalo y conéctalo en «Ajustes del ESP32».';
            else if (this.adapter.state === 'connected') friendly = 'El ESP32 está conectado al ELM327 por Bluetooth.';
            else friendly = 'El ESP32 se está conectando al ELM327 (reintenta cada 15 s). Al pulsar «Conectar» espera hasta 30 s.';
        } catch (err) {
            friendly = err.message;
        }
        return [{ path: PORT_ID, label: this._label(), friendlyName: friendly, bt: null, mac: this.adapter.mac || null }];
    }

    async _pick() { return PORT_ID; }
}
