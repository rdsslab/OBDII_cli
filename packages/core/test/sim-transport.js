/**
 * Simulated ELM327 + SIM2K-33 ECU transport, for tests without the car.
 *
 * Replays responses captured from the real vehicle (SAIC Wuling, SIM2K-33,
 * ELM327 v1.5 clone). Non-AT responses are framed like the ELM does with
 * ATH1 (fmt / F1 / 11 / [len] / data / checksum) and data is delivered in
 * small Uint8Array chunks, as a real serial port would.
 */

const hexToBytes = (h) => h.trim().split(/\s+/).map(x => parseInt(x, 16));
const toHex = (bytes) => bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** Build a KWP frame as sent by the ECU (target F1 = tester, source 11 = ECU). */
export function kwpFrame(dataHex) {
    const data = hexToBytes(dataHex);
    const head = data.length < 64 ? [0x80 | data.length, 0xF1, 0x11] : [0x80, 0xF1, 0x11, data.length];
    const frame = [...head, ...data];
    frame.push(frame.reduce((a, b) => (a + b) & 0xFF, 0));
    return toHex(frame);
}

/** Captured 2101 response (engine idling: 897 RPM, target 850, 14.0 V, coolant 87 °C). */
export const CAPTURE_2101 = '61 01 8C 3D 39 B4 51 A3 0D 00 00 0D 47 DA 00 F5 0F AA 0B 62 00 81 03 52 03 FF 00 A6 00 00 00 00 B4 B4 B4 B4 8F 02 8D 02 8E 02 95 02 8D 02 50 00 01 9B F9 0E FD 1A 00 A7 D2 82 00 59 35 66 E6 90 2A 4C 00 00 00 00 9A 09 00 4C 04 C2 69 2E 00 BF';

/** Captured DTC list: P1535 (MIL on), P0501, P0335. */
export const CAPTURE_18 = '58 03 15 35 E1 05 01 38 03 35 24';

export class SimTransport {
    constructor({ chunkSize = 7, latencyMs = 2, responses = {} } = {}) {
        this.chunkSize = chunkSize;
        this.latencyMs = latencyMs;
        this.listeners = new Set();
        this.isOpen = false;
        this.headers = false;
        this.log = [];
        this.responses = {
            '1081': '50 81',
            '0100': '7F 01 11',
            '2101': CAPTURE_2101,
            '1800FF00': CAPTURE_18,
            '82': 'C2',
            ...responses,
        };
    }

    async open() { this.isOpen = true; }
    async close() { this.isOpen = false; this.listeners.clear(); }
    onData(cb) { this.listeners.add(cb); }
    offData(cb) { this.listeners.delete(cb); }

    write(text) {
        const cmd = text.replace(/\r/g, '').trim();
        this.log.push(cmd);
        const reply = this._reply(cmd);
        const bytes = new TextEncoder().encode(`${reply}\r\r>`);
        let delay = this.latencyMs;
        for (let i = 0; i < bytes.length; i += this.chunkSize) {
            const chunk = bytes.slice(i, i + this.chunkSize);
            setTimeout(() => this.listeners.forEach(cb => cb(chunk)), delay++);
        }
    }

    _reply(cmd) {
        const c = cmd.toUpperCase().replace(/\s/g, '');
        if (c === 'ATZ') { this.headers = false; return 'ELM327 v1.5'; }
        if (c === 'ATRV') return '12.3V';
        if (c === 'ATH1') { this.headers = true; return 'OK'; }
        if (c === 'ATH0') { this.headers = false; return 'OK'; }
        if (c === 'ATDPN') return 'A5';
        if (c.startsWith('AT')) return 'OK';
        const data = this.responses[c] ?? `7F ${c.slice(0, 2)} 12`;
        return this.headers ? kwpFrame(data) : data;
    }
}
