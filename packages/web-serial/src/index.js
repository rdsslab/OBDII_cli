/**
 * Web Serial transport for @obdii/core (Chrome / Edge, desktop and Android).
 *
 * Works with USB ELM327 adapters and with Bluetooth Classic (SPP / RFCOMM)
 * adapters that are already paired in the operating system.
 *   - Desktop Chrome: the paired adapter appears as a serial port.
 *   - Chrome for Android (recent versions): Bluetooth RFCOMM ports.
 *
 * Implements the transport contract: open(), close(), write(text),
 * onData(cb), offData(cb), isOpen — plus onClose(cb) for link loss.
 */

/** Bluetooth Serial Port Profile service class UUID. */
export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

export const isWebSerialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

/**
 * Ask the user to pick an adapter (needs a user gesture, e.g. a click).
 * @returns {Promise<SerialPort>}
 */
export function requestPort() {
    if (!isWebSerialSupported()) throw new Error('Este navegador no soporta Web Serial. Usa Chrome o Edge.');
    return navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID] });
}

/** Ports this site already has permission for (no prompt). */
export async function getGrantedPorts() {
    return isWebSerialSupported() ? navigator.serial.getPorts() : [];
}

/** Human label for a SerialPort. */
export function describeSerialPort(port) {
    const info = port?.getInfo?.() || {};
    if (info.bluetoothServiceClassId) return 'Adaptador Bluetooth (SPP)';
    if (info.usbVendorId) {
        const hex = (n) => n.toString(16).toUpperCase().padStart(4, '0');
        return `Adaptador USB ${hex(info.usbVendorId)}:${hex(info.usbProductId ?? 0)}`;
    }
    return 'Puerto serie';
}

export class WebSerialTransport {
    /**
     * @param {SerialPort} port - from requestPort() / getGrantedPorts()
     * @param {number} [baudRate=38400]
     */
    constructor(port, baudRate = 38400) {
        this.port = port;
        this.baudRate = baudRate;
        this.listeners = new Set();
        this.closeListeners = new Set();
        this.isOpen = false;
        this._reader = null;
        this._readLoop = null;
        this._encoder = new TextEncoder();
        this._closing = false;
    }

    async open() {
        const opts = { baudRate: this.baudRate, dataBits: 8, stopBits: 1, parity: 'none' };
        try {
            await this.port.open(opts);
        } catch (err) {
            if (!/already open/i.test(err.message)) throw new Error(`No se pudo abrir el adaptador: ${err.message}`);
            // Left open by a previous transport (e.g. after a Bluetooth drop):
            // a stale open port has no readable stream, so close and re-open it.
            if (!this.port.readable || !this.port.writable) {
                try { await this.port.close(); } catch { /* ignore */ }
                try { await this.port.open(opts); } catch (e2) { throw new Error(`No se pudo abrir el adaptador: ${e2.message}`); }
            }
        }
        this.isOpen = true;
        this._closing = false;
        this._readLoop = this._read();
    }

    async _read() {
        while (this.isOpen && this.port.readable) {
            this._reader = this.port.readable.getReader();
            try {
                for (;;) {
                    const { value, done } = await this._reader.read();
                    if (done) break;
                    if (value?.length) this.listeners.forEach(cb => cb(value));
                }
            } catch {
                // Non-fatal read errors (framing/parity) leave readable usable;
                // a lost link makes readable null and ends the loop.
            } finally {
                try { this._reader.releaseLock(); } catch { /* ignore */ }
                this._reader = null;
            }
            if (this._closing) break;
        }
        if (!this._closing && this.isOpen) {
            this.isOpen = false;
            this.closeListeners.forEach(cb => cb());
        }
    }

    async write(text) {
        if (!this.isOpen || !this.port.writable) throw new Error('El adaptador no está conectado');
        const writer = this.port.writable.getWriter();
        try {
            await writer.write(this._encoder.encode(text));
        } finally {
            writer.releaseLock();
        }
    }

    onData(cb) { this.listeners.add(cb); }
    offData(cb) { this.listeners.delete(cb); }
    onClose(cb) { this.closeListeners.add(cb); }

    async close() {
        this._closing = true;
        this.isOpen = false;
        try { await this._reader?.cancel(); } catch { /* ignore */ }
        try { await this._readLoop; } catch { /* ignore */ }
        try { await this.port.close(); } catch { /* ignore */ }
        this.listeners.clear();
    }
}
