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
import { ECU_ID_SUBFUNCTIONS, KWP_DATA_BLOCKS } from './ecu-profiles.js';

const TIMEOUT_MS = 6000;
const INIT_TIMEOUT_MS = 12000;

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
        /** Prevents Tester Present from colliding with active commands */
        this._busy = false;
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

            // Give the ELM327 a moment to settle after protocol change
            await new Promise(r => setTimeout(r, 200));

            // Set KWP header
            this._debug('Setting header', profile.header);
            await this.sendRaw(`AT SH ${profile.header}`, timeout);

            // Try each session type in order of preference
            for (const session of profile.sessions) {
                this._debug(`Trying session`, session.name);
                const sessionResult = await this.sendRaw(session.cmd, initTimeout);
                this._debug(`Session response`, sessionResult);

                // Positive response starts with 50
                const isPositive = sessionResult.replace(/\s/g, '').match(/^50/);
                if (!isPositive) continue;

                this._info(`✅ Session started: ${session.name}`);

                // Test if OBD2 works within this session
                const obd2Test = await this.sendRaw('0100', timeout);
                if (!this._isError(obd2Test) && !this._isNegativeResponse(obd2Test)) {
                    this.mode = 'obd2';
                    this._info('OBD2 available within KWP session ✅');
                } else {
                    // Test KWP service 21 (readDataByLocalIdentifier)
                    const kwp21 = await this.sendRaw('2101', timeout);
                    if (!this._isError(kwp21) && !this._isNegativeResponse(kwp21)) {
                        this.mode = 'kwp2000';
                        this._info('KWP2000 service 21 available ✅');
                    } else {
                        this.mode = 'kwp2000';
                        this._info('KWP2000 session active (limited services)');
                    }
                }

                // Start tester present with profile-specific interval
                this._startTesterPresent(profile.testerPresentInterval);
                return true;
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

            for (const hdr of headerConfigs) {
                this._debug('Setting header', hdr.header);
                await this.sendRaw(`AT SH ${hdr.header}`, TIMEOUT_MS);

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
                        this._startTesterPresent();
                        return;
                    }

                    // Try KWP readDataByLocalIdentifier (service 21)
                    const kwp21 = await this.sendRaw('2101', TIMEOUT_MS);
                    this._debug('KWP 2101 test', kwp21);
                    if (!this._isError(kwp21) && !this._isNegativeResponse(kwp21)) {
                        this.mode = 'kwp2000';
                        this._info('KWP2000 service 21 works ✅');
                        this._startTesterPresent();
                        return;
                    }

                    // Try KWP readDTCByStatus (service 18)
                    const kwp18 = await this.sendRaw('1800FF00', TIMEOUT_MS);
                    this._debug('KWP 18 test', kwp18);
                    if (!this._isError(kwp18) && !this._isNegativeResponse(kwp18)) {
                        this.mode = 'kwp2000';
                        this._info('KWP2000 service 18 works ✅');
                        this._startTesterPresent();
                        return;
                    }

                    // Try KWP readDTC (service 13)
                    const kwp13 = await this.sendRaw('13FF', TIMEOUT_MS);
                    this._debug('KWP 13 test', kwp13);
                    if (!this._isError(kwp13) && !this._isNegativeResponse(kwp13)) {
                        this.mode = 'kwp2000';
                        this._info('KWP2000 service 13 works ✅');
                        this._startTesterPresent();
                        return;
                    }
                }
            }
        }

        this.mode = 'unknown';
        this._warn('Could not establish KWP2000 session.');
        this._warn('Use "Scan ECU Services" (option 15) and "Custom Command" to explore.');
    }

    /**
     * Send periodic "Tester Present" (3E) to keep KWP session alive.
     */
    _startTesterPresent(intervalMs = 2500) {
        if (this._testerPresentInterval) return;
        this._testerPresentInterval = setInterval(async () => {
            try {
                // Don't send while another command is in progress
                if (this._busy) return;
                if (this.port && this.port.isOpen) {
                    await this.sendRaw('3E', 2000);
                }
            } catch { /* ignore */ }
        }, intervalMs);
    }

    _stopTesterPresent() {
        if (this._testerPresentInterval) {
            clearInterval(this._testerPresentInterval);
            this._testerPresentInterval = null;
        }
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

                    finish(response);
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
                // If bus initialization failed and we have a profile, try to re-init and retry ONCE
                if (response.includes('BUS INIT: ERROR') && this.profile && !isRetry) {
                    this._warn('Bus initialization lost. Attempting auto-recovery...');

                    // Force a hard reset if several failures occur? 
                    // For now, simple re-init is often enough.
                    const reinitOk = await this._initWithProfile(this.profile);
                    if (reinitOk) {
                        this._info('Bus recovered. Retrying command...');
                        return this.sendCommand(command, true);
                    } else {
                        // If re-init failed, try a hard reset: reset ELM327 + full re-config
                        this._warn('Auto-recovery failed. Trying hard reset...');
                        await this.sendRaw('ATZ', INIT_TIMEOUT_MS);
                        // Wait for ELM327 to reboot fully
                        await new Promise(r => setTimeout(r, 1000));
                        // Re-apply base configuration (ATZ clears all settings!)
                        await this.sendRaw('ATE0', TIMEOUT_MS);  // echo off
                        await this.sendRaw('ATL0', TIMEOUT_MS);  // linefeeds off
                        await this.sendRaw('ATS1', TIMEOUT_MS);  // spaces on
                        await this.sendRaw('ATH0', TIMEOUT_MS);  // headers off
                        await this.sendRaw('ATAT2', TIMEOUT_MS); // adaptive timing
                        await this.sendRaw('ATST 96', TIMEOUT_MS); // timeout ~1.5s
                        const secondChance = await this._initWithProfile(this.profile);
                        if (secondChance) return this.sendCommand(command, true);
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

        for (const [key, sub] of Object.entries(ECU_ID_SUBFUNCTIONS)) {
            const result = await this.sendRaw(`1A${sub.id}`, TIMEOUT_MS);

            if (this._isError(result) || this._isNegativeResponse(result)) {
                continue;
            }

            // Positive response: 5A [subFunction] [data...]
            // Some ELM327 clones may strip the 5A prefix
            const clean = result.replace(/\s/g, '');
            const prefix = `5A${sub.id}`.toUpperCase();
            let dataHex;

            const idx = clean.toUpperCase().indexOf(prefix);
            if (idx !== -1) {
                // Standard format: 5A XX [data]
                dataHex = clean.substring(idx + prefix.length);
            } else {
                // ELM327 clone: response is raw data without 5A prefix
                // Use full response as data
                dataHex = clean;
            }

            if (!dataHex || dataHex.length < 2) continue;

            // Try to decode as ASCII text
            let text = '';
            for (let i = 0; i + 1 < dataHex.length; i += 2) {
                const byte = parseInt(dataHex.substring(i, i + 2), 16);
                if (byte >= 0x20 && byte <= 0x7E) {
                    text += String.fromCharCode(byte);
                } else {
                    text += '.';
                }
            }

            info[sub.name] = {
                hex: dataHex,
                text: text.trim(),
            };
        }

        this.ecuInfo = info;
        return info;
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

        // Try to find positive response header (0x61 = response to service 0x21)
        const headerIdx = bytes.indexOf(0x61);
        let dataBytes;
        if (headerIdx !== -1 && headerIdx + 1 < bytes.length) {
            // Standard format: 61 [blockId] [data...]
            dataBytes = bytes.slice(headerIdx + 2);
        } else {
            // ELM327 clone with ATH0: response header stripped, all bytes are data
            dataBytes = bytes;
        }

        return { success: dataBytes.length > 0, bytes: dataBytes, raw: result };
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

        const parsed = [];
        const len = result.bytes.length;

        for (const field of blockDef.fields) {
            // Resolve offset: negative = from end, positive = from start
            const resolvedOffset = field.offset < 0 ? len + field.offset : field.offset;

            if (resolvedOffset < 0 || resolvedOffset >= len) continue;

            try {
                let value;
                if (field.length === 1) {
                    value = field.parse(result.bytes[resolvedOffset]);
                } else if (field.length === 2) {
                    const a = result.bytes[resolvedOffset];
                    const b = result.bytes[resolvedOffset + 1] || 0;
                    value = field.parse(a, b);
                }

                if (value !== null && value !== undefined && !isNaN(value)) {
                    if (typeof value === 'number') {
                        value = Math.round(value * 100) / 100;
                    }
                    parsed.push({ name: field.name, value, unit: field.unit });
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
                    this.port.write('ATZ\r');
                    await new Promise(r => setTimeout(r, 300));
                }
            } catch { /* ignore */ }
            await disconnect(this.port);
            this.port = null;
            this.connected = false;
            this.profile = null;
        }
    }
}
