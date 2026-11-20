/**
 * ECU Profiles Module
 * Known ECU configurations for optimized initialization.
 * 
 * With specific ECU information we can skip auto-detection and
 * go directly to the correct protocol, header, and session type.
 */

// ═══════════════════════════════════════════════════════════════
// ECU Identification Commands (KWP2000 Service 1A)
// ═══════════════════════════════════════════════════════════════

export const ECU_ID_SUBFUNCTIONS = {
    ECU_IDENT: { id: '80', name: 'ECU Identification' },
    PART_NUMBER: { id: '86', name: 'Part Number' },
    SERIAL_NUMBER: { id: '87', name: 'Serial Number' },
    SUPPLIER_ID: { id: '88', name: 'Supplier ID' },
    HW_VERSION: { id: '91', name: 'Hardware Version' },
    SW_VERSION: { id: '9B', name: 'Software Version' },
    BOOT_SW: { id: '9C', name: 'Boot Software ID' },
    CODING: { id: '97', name: 'ECU Coding' },
    VIN_ECU: { id: '90', name: 'VIN (from ECU)' },
    CALIBRATION_ID: { id: '92', name: 'Calibration ID' },
};

// ═══════════════════════════════════════════════════════════════
// KWP2000 Live Data Block Definitions
// ═══════════════════════════════════════════════════════════════

/**
 * Data block definitions for KWP2000 Service 21 (readDataByLocalIdentifier).
 *
 * `bytes` passed to decode() are the DATA bytes, i.e. the response without
 * the "61 <blockId>" prefix. (Frame index = data index + 2.)
 *
 * History: older notes claimed block 01 had a VARIABLE length (9–35 bytes)
 * and needed anchor-pattern decoding. That was an artifact of the ELM327 v1.5
 * clone truncating multi-line KWP frames with ATH0. With headers ON and
 * checksum-validated framing (see elm327.js) block 01 is always 78 data bytes
 * at fixed positions.
 *
 * Calibration (2026-11-19, SIM2K-33 on SAIC Wuling), from three captures:
 *   - idle (~960 rpm), revving in neutral (~2150 and ~3730 rpm, decel fuel cut)
 *   - key ON / engine OFF with accelerator released → floored → released
 * `confirmed: true`  = verified against a physical reference (see notes).
 * `confirmed: false` = best hypothesis, shown dimmed as "needs calibration".
 */

const le16 = (bytes, i) => (i + 1 < bytes.length ? bytes[i] | (bytes[i + 1] << 8) : null);
const u8 = (bytes, i) => (i < bytes.length ? bytes[i] : null);

/** Raw throttle value with pedal released / floored (key-on engine-off test). */
const THROTTLE_CLOSED = 13;
const THROTTLE_WOT = 49100;

const ENGINE_STATES = { 1: 'parado', 4: 'ralentí', 8: 'carga parcial', 16: 'corte combustible (desaceleración)' };

export const KWP_DATA_BLOCKS = {
    BLOCK_01: {
        id: '01',
        command: '2101',
        name: 'Primary Engine Data',
        responsePrefix: 0x61,
        length: 78,
        fields: [
            {
                // Matches the revving test exactly (idle ~960, steps to ~2150/~3730).
                name: 'Engine RPM',
                unit: 'RPM',
                confirmed: true,
                decode: (b) => le16(b, 19),
            },
            {
                // Constant 0x0352 = 850 in every capture (also with engine stopped).
                name: 'Target Idle RPM',
                unit: 'RPM',
                confirmed: true,
                decode: (b) => le16(b, 21),
            },
            {
                // 1 stopped, 4 idle, 8 part load, 16 decel fuel cut (seen at
                // 2890 rpm with throttle closed). Bit-coded.
                name: 'Engine State',
                unit: '',
                confirmed: true,
                decode: (b) => {
                    const v = u8(b, 71);
                    if (v === null) return null;
                    return ENGINE_STATES[v] || `0x${v.toString(16).toUpperCase()}`;
                },
            },
            {
                // Key-on engine-off: 13 released, 49100 floored. Exactly 13 at
                // idle and during decel; rises with pedal while revving.
                name: 'Throttle Position',
                unit: '%',
                confirmed: true,
                decode: (b) => {
                    const v = le16(b, 6);
                    if (v === null) return null;
                    const pct = (v - THROTTLE_CLOSED) / (THROTTLE_WOT - THROTTLE_CLOSED) * 100;
                    return Math.max(0, Math.round(pct * 10) / 10);
                },
            },
            {
                // Engine off: 9382 → 93.8 kPa = barometric pressure.
                // Idle ~38 kPa, decel ~18 kPa, tip-in ~59 kPa: typical MAP.
                name: 'Intake Manifold Pressure (MAP)',
                unit: 'kPa',
                confirmed: true,
                decode: (b) => {
                    const v = le16(b, 13);
                    return v === null ? null : Math.round(v / 10) / 10;
                },
            },
            {
                // ×0.1 tracks ATRV: 12.5 V engine off, 13.1–14.5 V charging.
                name: 'Battery Voltage (ECU)',
                unit: 'V',
                confirmed: true,
                decode: (b) => {
                    const v = u8(b, 0);
                    return v === null ? null : v / 10;
                },
            },
            {
                // Standard Siemens/Bosch scaling 0.75·x − 48 gives 82–91 °C on a
                // warm engine, with a dip typical of the thermostat opening.
                // Matches the dashboard gauge (needle at 60–70 % when warm).
                // Byte 2 is its complement (raw sensor voltage).
                name: 'Coolant Temp',
                unit: '°C',
                confirmed: true,
                decode: (b) => {
                    const v = u8(b, 3);
                    return v === null ? null : Math.round((v * 0.75 - 48) * 10) / 10;
                },
            },
            {
                // Slow temperature-like value (byte 5 is its complement, they
                // sum to 243). 36–47 °C with x−40; rises with sustained revs.
                name: 'Intake Air Temp (hypothesis)',
                unit: '°C',
                confirmed: false,
                decode: (b) => {
                    const v = u8(b, 4);
                    return v === null ? null : v - 40;
                },
            },
            {
                // Peaks on tip-in, lowest in decel fuel cut, 0 engine off.
                name: 'Engine Load / air charge (raw)',
                unit: 'raw',
                confirmed: false,
                decode: (b) => le16(b, 11),
            },
            {
                // ~71 idle, ~108 @2150, ~139 @3730 rpm. Possibly ignition advance.
                name: 'Ignition-related (raw)',
                unit: 'raw',
                confirmed: false,
                decode: (b) => u8(b, 62),
            },
        ],
    },

    BLOCK_02: {
        id: '02',
        command: '2102',
        name: 'Secondary Data',
        responsePrefix: 0x61,
        length: 78,
        // Mostly zeros on SIM2K-33. The old "O2 = byte[4]×4" and
        // "fuel trim = byte[2]" decoders were derived from truncated frames
        // and point at bytes that are always 0 — removed. Only raw values left.
        fields: [
            {
                name: 'Value @54 (raw, rises with rpm)',
                unit: 'raw',
                confirmed: false,
                decode: (b) => le16(b, 54),
            },
            {
                name: 'Value @56 (raw, dips on transients)',
                unit: 'raw',
                confirmed: false,
                decode: (b) => le16(b, 56),
            },
        ],
    },

    BLOCK_03: {
        id: '03',
        command: '2103',
        name: 'Additional Data',
        responsePrefix: 0x61,
        fields: [],  // NRC 0x12 — not supported on SIM2K-33
    },
};

// ═══════════════════════════════════════════════════════════════
// ECU Profile Definitions
// ═══════════════════════════════════════════════════════════════

export const ECU_PROFILES = {
    SIM2K_33: {
        name: 'Siemens VDO SIM2K-33',
        partNumbers: ['5WY5833C', '5WY5801A'],
        vehicle: 'SAIC Wuling 2008',
        description: 'ECU Siemens VDO SIM2K-33 — Motor gasolina SAIC Wuling',

        protocol: {
            atsp: '5',
            protocolName: 'ISO 14230-4 KWP (fast init, 10.4 kbaud)',
        },

        header: '81 11 F1',

        sessions: [
            { cmd: '1081', name: 'Default (81)' },
            { cmd: '1089', name: 'Development (89)' },
            { cmd: '1085', name: 'Extended (85)' },
        ],

        testerPresentInterval: 2000,
        dataBlocks: ['BLOCK_01', 'BLOCK_02'],

        timing: {
            initTimeout: 8000,
            commandTimeout: 4000,
        },
    },
};

export function getProfile(key) {
    return ECU_PROFILES[key] || null;
}

export function listProfiles() {
    return Object.entries(ECU_PROFILES).map(([key, profile]) => ({
        key,
        name: profile.name,
        vehicle: profile.vehicle,
        description: profile.description,
    }));
}
