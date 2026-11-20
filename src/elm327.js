/**
 * ELM327 Protocol Module
 * Manages ELM327 initialization and command communication.
 * 
 * Supports both standard OBD2 and KWP2000 diagnostic protocols.
 * For KWP2000 vehicles (like SAIC WULING), tries multiple ECU
 * addresses and diagnostic session types to establish communication.
 * 
 * When an ECU profile is provided (e.g. SIM2K-33), the initialization
 * targets the exact protocol, header, and session type — much faster.
 */

import { connect, disconnect } from './bluetooth.js';
import { ECU_ID_SUBFUNCTIONS, ECU_ID_NAMES, KWP_DATA_BLOCKS } from './ecu-profiles.js';

const TIMEOUT_MS = 6000;
const INIT_TIMEOUT_MS = 12000;

/**
 * K-line ECUs keep a diagnostic session open until P3max (~5 s) elapses
 * WITHOUT bus traffic. If the ELM327 is reset (ATZ, app restart, BT drop)
 * while the ECU still has a session open, every new fast-init is answered
 * with "BUS INIT: ERROR" — and retrying immediately keeps the bus busy, so
 * the ECU never times out. We must stay silent > P3max before re-init.
 */
const KLINE_IDLE_RECOVERY_MS = 6000;
const KLINE_INIT_ATTEMPTS = 3;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Informational ELM327 lines that are not ECU data. */
const INFO_LINE = /^(BUS INIT:?\s*(OK|\.+)|SEARCHING\.*)$/i;

const ELM327_ERRORS = [
    'NO DATA',
    'UNABLE TO CONNECT',
    'BUS INIT: ERROR',  // Only ERROR — BUS INIT: OK is valid data
    'BUS ERROR',
    'CAN ERROR',
    'ERROR',
    'STOPPED',
    '<DATA ERROR',
];


// ANSI colors for debug output
const D = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    red: '\x1b[31m',
};

export class ELM327 {
    constructor() {
        /** @type {import('serialport').SerialPort | null} */
        this.port = null;
        this.connected = false;
        this.protocol = 'Auto';
        this.version = '';
        this.debug = true;
        /** @type {'obd2'|'kwp2000'|'unknown'} */
        this.mode = 'unknown';
        /** @type {object|null} Active ECU profile */
        this.profile = null;
        /** @type {object|null} ECU identification data */
        this.ecuInfo = null;
        this._testerPresentInterval = null;
        this._busy = false;
        /** Serializes access to the serial port: one command at a time. */
        this._queue = Promise.resolve();
        /**
         * When true, headers are ON (ATH1) and KWP frames are decoded by us.
         * ELM327 v1.5 clones truncate multi-line KWP responses with ATH0
         * (they drop bytes when stripping headers), so we never rely on it.
         */
        this._kwpFraming = false;
    }

    _debug(label, value) {
        if (!this.debug) return;
        console.log(`  ${D.dim}[${D.cyan}${label}${D.dim}]${D.reset} ${D.magenta}${value}${D.reset}`);
    }

    _info(msg) {
        console.log(`  ${D.green}✓${D.reset} ${msg}`);
    }

    _warn(msg) {
        console.log(`  ${D.yellow}⚠${D.reset} ${msg}`);
    }

    /**
     * Connect to an ELM327 device on the specified port.
     */
    async connect(portPath, baudRate = 38400) {
        this.port = await connect(portPath, baudRate);
        this.connected = true;
    }

    /**
     * Full initialization sequence:
     * 1. Reset & configure ELM327
     * 2. If a profile is given, try profile-specific initialization first
     * 3. Otherwise (or on fallback), try standard OBD2
     * 4. If OBD2 fails, try KWP2000 with different ECU addresses & session types
     * 
     * @param {object|null} profile - ECU profile from ecu-profiles.js (optional)
     */
    async initialize(profile = null) {
        if (!this.connected) throw new Error('Not connected to any device');

        // ── Reset & basic config ──
        const resetResponse = await this.sendRaw('ATZ', INIT_TIMEOUT_MS);
        this.version = this.extractVersion(resetResponse);

        await this.sendRaw('ATE0', TIMEOUT_MS);
        await this.sendRaw('ATL0', TIMEOUT_MS);
        await this.sendRaw('ATS1', TIMEOUT_MS);
        await this.sendRaw('ATH0', TIMEOUT_MS);
        await this.sendRaw('ATAT2', TIMEOUT_MS);
        await this.sendRaw('ATST 96', TIMEOUT_MS);

        // ── Try profile-specific initialization if provided ──
        if (profile) {
            this.profile = profile;
            const profileOk = await this._initWithProfile(profile);
            if (profileOk) {
                const dpResponse = await this.sendRaw('ATDP', TIMEOUT_MS);
                this.protocol = dpResponse.trim() || profile.protocol.protocolName;
                return {
                    version: this.version,
                    protocol: this.protocol,
                    mode: this.mode,
                    profile: profile.name,
                };
            }
            this._warn('Profile init failed, falling back to auto-detect...');
        }

        // ── Try auto-detect protocol + standard OBD2 ──
        await this.sendRaw('ATSP0', TIMEOUT_MS);
        const testResult = await this.sendRaw('0100', INIT_TIMEOUT_MS);
        this._debug('OBD2 test (0100)', testResult);

        if (!this._isError(testResult) && !this._isNegativeResponse(testResult)) {
            this.mode = 'obd2';
            this._info('Standard OBD2 supported ✅');
        } else {
            this._warn('Standard OBD2 not supported, trying KWP2000...');
            await this._tryKWP2000Init();
        }

        // Get protocol description
        const dpResponse = await this.sendRaw('ATDP', TIMEOUT_MS);
        this.protocol = dpResponse.trim() || 'Unknown';

        return {
            version: this.version,
            protocol: this.protocol,
            mode: this.mode,
        };
    }

    /**
     * Profile-specific initialization.
     * Goes directly to the correct protocol, header, and session.
     * Much faster than generic auto-detect.
     * 
     * @param {object} profile - ECU profile
     * @returns {Promise<boolean>} true if successful
     */
    async _initWithProfile(profile) {
        // Stop any active keep-alive loop and set busy flag
        this._stopTesterPresent();
        this._busy = true;

        try {
            const timeout = profile.timing?.commandTimeout || TIMEOUT_MS;
            const initTimeout = profile.timing?.initTimeout || INIT_TIMEOUT_MS;

            this._info(`Using profile: ${profile.name}`);
            this._info(`Vehicle: ${profile.vehicle}`);
            this._debug('Protocol', profile.protocol.protocolName);

            // Set protocol directly (e.g. ATSP5 for KWP Fast Init)
            await this.sendRaw(`ATSP${profile.protocol.atsp}`, timeout);
            await this._enableKwpFraming();

            // Give the ELM327 a moment to settle after protocol change
            await sleep(200);

            // Set KWP header + make the ELM327 send its own keep-alive
            // (Tester Present) to this ECU. The ELM sends it only while the
            // bus is idle, so it never collides with our commands.
            this._debug('Setting header', profile.header);
            await this.sendRaw(`AT SH ${profile.header}`, timeout);
            await this.sendRaw(`AT WM ${profile.header} 3E`, timeout);

            for (let attempt = 1; attempt <= KLINE_INIT_ATTEMPTS; attempt++) {
                let busInitError = false;

                // Try each session type in order of preference
                for (const session of profile.sessions) {
                    this._debug(`Trying session`, session.name);
                    const sessionResult = await this.sendRaw(session.cmd, initTimeout);
                    this._debug(`Session response`, sessionResult);

                    if (sessionResult.includes('BUS INIT: ERROR')) {
                        busInitError = true;
                        break; // other sessions would fail the same way
                    }

                    // Positive response starts with 50
                    if (!/^50/.test(sessionResult.replace(/\s/g, ''))) continue;

                    this._info(`✅ Session started: ${session.name}`);

                    // Test if OBD2 works within this session
                    const obd2Test = await this.sendRaw('0100', timeout);
                    if (!this._isError(obd2Test) && !this._isNegativeResponse(obd2Test)) {
                        this.mode = 'obd2';
                        this._info('OBD2 available within KWP session ✅');
                    } else {
                        // Test KWP service 21 (readDataByLocalIdentifier)
                        const kwp21 = await this.sendRaw('2101', timeout);
                        this.mode = 'kwp2000';
                        if (!this._isError(kwp21) && !this._isNegativeResponse(kwp21)) {
                            this._info('KWP2000 service 21 available ✅');
                        } else {
                            this._info('KWP2000 session active (limited services)');
                        }
                    }
                    return true;
                }

                if (!busInitError || attempt === KLINE_INIT_ATTEMPTS) break;
                this._warn('BUS INIT: ERROR — the ECU may still hold a previous session, or ignition is OFF.');
                this._warn(`Waiting ${KLINE_IDLE_RECOVERY_MS / 1000}s of bus silence before retry (${attempt}/${KLINE_INIT_ATTEMPTS - 1})...`);
                await sleep(KLINE_IDLE_RECOVERY_MS);
            }
            return false;
        } finally {
            this._busy = false;
        }
    }

    /**
     * Try to establish KWP2000 communication.
     * Tests multiple ECU addresses and diagnostic session types.
     */
    async _tryKWP2000Init() {
        // Common ECU physical addresses for Chinese vehicles
        const headerConfigs = [
            { header: '81 11 F1', name: 'ECU 0x11 (engine)' },
            { header: '81 01 F1', name: 'ECU 0x01 (engine alt)' },
            { header: '81 10 F1', name: 'ECU 0x10' },
            { header: 'C0 33 F1', name: 'ECU 0x33 (default KWP)' },
        ];

        // Session types to try for each header
        const sessionCmds = [
            { cmd: '1081', name: 'Default (81)' },
            { cmd: '1089', name: 'Development (89)' },
            { cmd: '1085', name: 'Extended (85)' },
        ];

        // Try KWP protocols: ATSP5 (fast init) first, then ATSP4 (5-baud init)
        const kwpProtocols = [
            { cmd: 'ATSP5', name: 'ISO 14230-4 KWP (fast init)' },
            { cmd: 'ATSP4', name: 'ISO 14230-4 KWP (5-baud init)' },
        ];

        const initTimeout = 8000; // 8s for session commands

        for (const proto of kwpProtocols) {
            this._info(`Trying ${proto.name}...`);
            await this.sendRaw(proto.cmd, TIMEOUT_MS);
            await this._enableKwpFraming();

            for (const hdr of headerConfigs) {
                this._debug('Setting header', hdr.header);
                await this.sendRaw(`AT SH ${hdr.header}`, TIMEOUT_MS);
                await this.sendRaw(`AT WM ${hdr.header} 3E`, TIMEOUT_MS);

                for (const session of sessionCmds) {
                    const sessionResult = await this.sendRaw(session.cmd, initTimeout);
                    this._debug(`Session ${session.name}`, sessionResult);

                    // Check for UNABLE TO CONNECT or other errors — skip immediately
                    if (sessionResult.includes('UNABLE TO CONNECT') || this._isError(sessionResult)) {
                        this._debug('Protocol/header combo not working, skip rest', hdr.name);
                        break; // Skip remaining sessions for this header — won't work
                    }

                    // Positive response starts with 50
                    const isPositive = sessionResult.replace(/\s/g, '').match(/^50/);
                    if (!isPositive) continue;

                    this._info(`Session started: ${session.name} @ ${hdr.name}`);

                    // Session opened! Now test if we can read data
                    const obd2Retry = await this.sendRaw('0100', TIMEOUT_MS);
                    if (!this._isError(obd2Retry) && !this._isNegativeResponse(obd2Retry)) {
                        this.mode = 'obd2';
                        this._info('OBD2 works with KWP session ✅');
                        return;
                    }

                    // Try KWP readDataByLocalIdentifier (service 21)
                    const kwp21 = await this.sendRaw('2101', TIMEOUT_MS);
                    this._debug('KWP 2101 test', kwp21);
                    if (!this._isError(kwp21) && !this._isNegativeResponse(kwp21)) {
                        this.mode = 'kwp2000';
                        this._info('KWP2000 service 21 works ✅');
                        return;
                    }

                    // Try KWP readDTCByStatus (service 18)
                    const kwp18 = await this.sendRaw('1800FF00', TIMEOUT_MS);
                    this._debug('KWP 18 test', kwp18);
                    if (!this._isError(kwp18) && !this._isNegativeResponse(kwp18)) {
                        this.mode = 'kwp2000';
                        this._info('KWP2000 service 18 works ✅');
                        return;
                    }

                    // Try KWP readDTC (service 13)
                    const kwp13 = await this.sendRaw('13FF', TIMEOUT_MS);
                    this._debug('KWP 13 test', kwp13);
                    if (!this._isError(kwp13) && !this._isNegativeResponse(kwp13)) {
                        this.mode = 'kwp2000';
                        this._info('KWP2000 service 13 works ✅');
                        return;
                    }
                }
            }
        }

        this.mode = 'unknown';
        await this._disableKwpFraming();
        this._warn('Could not establish KWP2000 session.');
        this._warn('Use "Scan ECU Services" (option 15) and "Custom Command" to explore.');
    }

    /**
     * Keep-alive is delegated to the ELM327 itself (AT WM <hdr> 3E): it sends
     * the wakeup message only while the bus is idle. A JS setInterval that
     * writes "3E" races with user commands on the same serial port and
     * corrupts responses, so it is no longer used.
     */
    _stopTesterPresent() {
        if (this._testerPresentInterval) {
            clearInterval(this._testerPresentInterval);
            this._testerPresentInterval = null;
        }
    }

    async _enableKwpFraming() {
        await this.sendRaw('ATH1', TIMEOUT_MS);
        this._kwpFraming = true;
    }

    async _disableKwpFraming() {
        this._kwpFraming = false;
        await this.sendRaw('ATH0', TIMEOUT_MS);
    }

    /**
     * Decode KWP2000 (ISO 14230) frames shown with ATH1 into data bytes only.
     * Frame: [fmt] [tgt] [src] ([len]) data... [checksum]
     *   fmt bits 7-6 = address mode (00 = no address bytes)
     *   fmt bits 5-0 = data length (0 => extra length byte follows)
     * ELM327 wraps long frames over several lines, so all hex is joined first.
     * Returns one string per ECU message ("58 03 15 35 E1 ..."), or null if
     * the bytes don't form valid frames (caller then keeps the raw text).
     */
    static decodeKwpFrames(text) {
        const bytes = (text.match(/\b[0-9A-F]{2}\b/gi) || []).map(h => parseInt(h, 16));
        if (bytes.length === 0) return null;
        const messages = [];
        let i = 0;
        while (i < bytes.length) {
            const start = i;
            const fmt = bytes[i++];
            if ((fmt & 0xC0) !== 0) i += 2;          // target + source
            let len = fmt & 0x3F;
            if (len === 0) len = bytes[i++];          // extra length byte
            if (len === undefined || i + len >= bytes.length) return null; // incomplete
            const data = bytes.slice(i, i + len);
            i += len;
            const cs = bytes[i++];
            const sum = bytes.slice(start, i - 1).reduce((a, b) => (a + b) & 0xFF, 0);
            if (cs !== sum) return null;
            messages.push(data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '));
        }
        return messages;
    }

    /**
     * Clean an ELM327 response: drop informational lines (BUS INIT: OK,
     * SEARCHING...) and, in KWP framing mode, strip headers/checksums.
     */
    _normalizeResponse(command, response) {
        const lines = response.split('\n').map(l => l.trim()).filter(l => l && !INFO_LINE.test(l));
        const cleaned = lines.join('\n');
        if (!this._kwpFraming || /^AT/i.test(command) || this._isError(cleaned)) return cleaned;
        const decoded = ELM327.decodeKwpFrames(cleaned);
        return decoded ? decoded.join('\n') : cleaned;
    }

    _isError(response) {
        const upper = response.toUpperCase();
        return ELM327_ERRORS.some(err => upper.includes(err));
    }

    _isNegativeResponse(response) {
        return /7F\s*[0-9A-Fa-f]{2}\s*[0-9A-Fa-f]{2}/.test(response);
    }

    extractVersion(response) {
        const match = response.match(/ELM327\s+v[\d.]+/i);
        return match ? match[0] : 'ELM327 (version unknown)';
    }

    /**
     * Send a raw command and collect ALL data until the '>' prompt.
     */
    sendRaw(command, timeout = TIMEOUT_MS) {
        const run = () => this._sendRawNow(command, timeout);
        const p = this._queue.then(run, run);
        this._queue = p.catch(() => {});
        return p;
    }

    _sendRawNow(command, timeout) {
        return new Promise((resolve) => {
            if (!this.port) {
                resolve('ERROR: Not connected');
                return;
            }

            this._busy = true;
            let buffer = '';
            let timer;

            const finish = (response) => {
                this._busy = false;
                resolve(response);
            };

            const onData = (chunk) => {
                buffer += chunk.toString('utf8');

                if (buffer.includes('>')) {
                    clearTimeout(timer);
                    this.port.removeListener('data', onData);

                    let response = buffer
                        .replace(/>/g, '')
                        .replace(/\r\n/g, '\n')
                        .replace(/\r/g, '\n')
                        .trim();

                    const lines = response.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                    const filtered = lines.filter(l => l.toUpperCase() !== command.toUpperCase());
                    response = filtered.join('\n');

                    this._debug('TX', command);
                    this._debug('RX', response || '(empty)');

                    finish(this._normalizeResponse(command, response));
                }
            };

            timer = setTimeout(() => {
                this.port.removeListener('data', onData);
                const response = buffer.replace(/>/g, '').trim();
                this._debug('TX', command);
                this._debug('RX (timeout)', response || '(empty)');
                finish(response || 'TIMEOUT');
            }, timeout);

            this.port.on('data', onData);
            this.port.write(command + '\r');
        });
    }

    /**
     * Send a command and return result with error detection.
     * Includes auto-recovery for BUS INIT: ERROR.
     */
    async sendCommand(command, isRetry = false) {
        if (!this.connected) {
            return { success: false, data: '', error: 'Not connected' };
        }

        this._busy = true;
        try {
            const response = await this.sendRaw(command);

            if (this._isError(response)) {
                // Bus init failed: the ECU dropped/kept a stale session. Retrying
                // immediately (or ATZ) keeps the K-line busy and never recovers;
                // wait for bus silence, then _initWithProfile (which also retries).
                if (response.includes('BUS INIT: ERROR') && this.profile && !isRetry) {
                    this._warn('Bus initialization lost. Waiting for ECU session timeout, then re-init...');
                    await sleep(KLINE_IDLE_RECOVERY_MS);
                    const reinitOk = await this._initWithProfile(this.profile);
                    if (reinitOk) {
                        this._info('Bus recovered. Retrying command...');
                        return this.sendCommand(command, true);
                    }
                }
                return { success: false, data: response, error: response };
            }

            const negMatch = response.replace(/\s/g, '').match(/7F[0-9A-Fa-f]{2}([0-9A-Fa-f]{2})/);
            if (negMatch) {
                const nrc = parseInt(negMatch[1], 16);
                const nrcMessages = {
                    0x10: 'General reject',
                    0x11: 'Service not supported',
                    0x12: 'Sub-function not supported / PID not supported',
                    0x13: 'Incorrect message length',
                    0x14: 'Response too long',
                    0x21: 'Busy - Repeat request',
                    0x22: 'Conditions not correct',
                    0x24: 'Request sequence error',
                    0x31: 'Request out of range',
                    0x33: 'Security access denied',
                    0x35: 'Invalid key',
                    0x78: 'Response pending',
                    0x80: 'General reject / Conditions not correct',
                };
                const msg = nrcMessages[nrc] || `Rejected (NRC 0x${nrc.toString(16).toUpperCase()})`;
                return { success: false, data: response, error: msg };
            }

            return { success: true, data: response };
        } catch (err) {
            return { success: false, data: '', error: err.message };
        } finally {
            this._busy = false;
        }
    }

    /**
     * Read ECU identification via KWP2000 Service 1A.
     * Tries each sub-function and returns the data found.
     * 
     * @returns {Promise<object>} Key-value pairs of ECU info
     */
    async readECUInfo() {
        const info = {};

        // Which identifiers exist? 1A 81 returns a directory of entries
        // [len][id][scaling...]. Fall back to a static list if unsupported.
        let subs = Object.values(ECU_ID_SUBFUNCTIONS);
        const dir = await this.readECUIdentifier('81');
        if (dir) {
            const ids = ELM327.parseIdDirectory(dir.bytes);
            if (ids.length) {
                subs = ids.map(id => ({ id, name: ECU_ID_NAMES[id] || `Identifier ${id}` }));
            }
        }

        for (const sub of subs) {
            const r = await this.readECUIdentifier(sub.id);
            if (!r) continue;
            info[sub.name] = { id: sub.id, hex: r.hex, text: r.text, empty: r.empty };
        }

        this.ecuInfo = info;
        return info;
    }

    /**
     * Read one KWP 1A identification option.
     * @param {string} id - e.g. '90'
     * @returns {Promise<{bytes:number[], hex:string, text:string, empty:boolean}|null>}
     */
    async readECUIdentifier(id) {
        const result = await this.sendRaw(`1A${id}`, TIMEOUT_MS);
        if (this._isError(result) || this._isNegativeResponse(result)) return null;

        // Positive response: 5A [id] [data...]
        const line = result.split('\n').find(l => l.replace(/\s/g, '').toUpperCase().startsWith(`5A${id}`.toUpperCase()));
        if (!line) return null;
        const bytes = (line.match(/[0-9A-F]{2}/gi) || []).slice(2).map(h => parseInt(h, 16));
        if (bytes.length === 0) return null;

        const hex = bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
        const empty = bytes.every(b => b === 0xFF) || bytes.every(b => b === 0x00);
        const text = empty
            ? '(no programado)'
            : bytes.map(b => (b >= 0x20 && b <= 0x7E ? String.fromCharCode(b) : '.')).join('').replace(/\.{3,}/g, '…').trim();
        return { bytes, hex, text, empty };
    }

    /**
     * Parse a 1A 81 directory: repeated [len][id][len-2 scaling bytes],
     * terminated by 0xFF. Returns the identifier list, e.g. ['8A','8B',…].
     */
    static parseIdDirectory(bytes) {
        const ids = [];
        let i = 0;
        while (i < bytes.length && bytes[i] !== 0xFF) {
            const len = bytes[i];
            if (len < 2 || i + 1 >= bytes.length) break;
            ids.push(bytes[i + 1].toString(16).toUpperCase().padStart(2, '0'));
            i += len;
        }
        return ids;
    }

    /**
     * Read a KWP2000 live data block via Service 21.
     * Returns raw data bytes (after response header).
     * 
     * @param {string} blockId - Block ID, e.g. '01', '02', '03'
     * @returns {Promise<{success: boolean, bytes: number[], raw: string}>}
     */
    async readKWPDataBlock(blockId) {
        const command = `21${blockId}`;
        const result = await this.sendRaw(command, TIMEOUT_MS);

        // Strip informational ELM327 lines like "BUS INIT: OK" which appear
        // on first command after re-initialization but precede valid data
        const cleanResult = result
            .split('\n')
            .filter(line => !/^BUS INIT: OK/i.test(line.trim()))
            .join('\n')
            .trim();

        if (this._isError(cleanResult) || this._isNegativeResponse(cleanResult)) {
            return { success: false, bytes: [], raw: cleanResult, error: cleanResult };
        }

        // Parse response bytes — strip all non-hex chars
        const clean = cleanResult.replace(/[^0-9A-Fa-f]/g, '');
        const bytes = [];
        for (let i = 0; i + 1 < clean.length; i += 2) {
            bytes.push(parseInt(clean.substring(i, i + 2), 16));
        }

        if (bytes.length === 0) {
            return { success: false, bytes: [], raw: cleanResult };
        }

        // Positive response: 61 [blockId] [data...]. With KWP framing the
        // response always starts there; anything else is not this block.
        const expectedId = parseInt(blockId, 16);
        if (bytes[0] !== 0x61 || bytes[1] !== expectedId) {
            return { success: false, bytes: [], raw: cleanResult, error: `Unexpected response: ${cleanResult.substring(0, 40)}` };
        }
        const dataBytes = bytes.slice(2);

        return { success: dataBytes.length > 0, bytes: dataBytes, raw: result };
    }

    /**
     * Re-open the KWP session after it was lost (ignition cycled, BT hiccup).
     * Waits for K-line silence first so a stale ECU session can time out.
     * @returns {Promise<boolean>}
     */
    async recoverSession() {
        if (!this.profile) return false;
        await sleep(KLINE_IDLE_RECOVERY_MS);
        return this._initWithProfile(this.profile);
    }

    /**
     * Read and parse a KWP data block using field definitions from the profile.
     * 
     * @param {object} blockDef - Block definition from KWP_DATA_BLOCKS
     * @returns {Promise<Array<{name: string, value: number|string, unit: string}>>}
     */
    async readKWPParsedBlock(blockDef) {
        const result = await this.readKWPDataBlock(blockDef.id);
        if (!result.success) return [];

        // Fixed-position layout: a different length means a different layout.
        if (blockDef.length && result.bytes.length !== blockDef.length) return [];

        const parsed = [];
        // Raw data bytes (hex, no "61 xx" prefix) for logging / later calibration
        parsed.raw = result.bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        for (const field of blockDef.fields) {
            try {
                const value = field.decode(result.bytes);
                if (value !== null && value !== undefined) {
                    parsed.push({ name: field.name, value, unit: field.unit, confirmed: !!field.confirmed });
                }
            } catch {
                // Skip fields that can't be parsed
            }
        }

        return parsed;
    }

    /**
     * Disconnect from the ELM327 device.
     */
    async disconnect() {
        this._stopTesterPresent();
        if (this.port) {
            try {
                if (this.port.isOpen) {
                    // KWP stopCommunication: the next run can fast-init right
                    // away instead of waiting for the ECU's P3 timeout.
                    if (this._kwpFraming && this.mode !== 'unknown') {
                        await this.sendRaw('82', 2000);
                    }
                    await this.sendRaw('ATZ', 2000);
                }
            } catch { /* ignore */ }
            await disconnect(this.port);
            this.port = null;
            this.connected = false;
            this.profile = null;
        }
    }
}
