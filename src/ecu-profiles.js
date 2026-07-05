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
 * IMPORTANT: The ELM327 v1.5 clone returns VARIABLE-LENGTH responses
 * for block 01 (observed: 9, 25, 26, 35 bytes). Fixed byte offsets 
 * are NOT reliable. The byte positions shift between sessions.
 * 
 * Current approach: show raw hex dump only. No automatic parsing.
 * Battery voltage is read separately via ELM327 ATRV command.
 * 
 * The stable pattern 9A 09 00 2D appears in all responses as a
 * calibration/reference constant — it is NOT battery voltage.
 */
/**
 * Find a byte sequence (needle) inside a byte array (haystack).
 * Returns the index of the first match, or -1.
 */
function findBytes(haystack, needle) {
    for (let i = 0; i <= haystack.length - needle.length; i++) {
        if (needle.every((b, j) => haystack[i + j] === b)) return i;
    }
    return -1;
}

export const KWP_DATA_BLOCKS = {
    BLOCK_01: {
        id: '01',
        command: '2101',
        name: 'Primary Engine Data',
        responsePrefix: 0x61,
        // PATTERN-BASED decoding — response length varies (21–31 bytes).
        // Anchor: bytes [52 03 FF 00] appear consistently in the data stream.
        //   - RPM actual:  2 bytes BEFORE anchor, little-endian uint16
        //   - Target RPM:  bytes [anchor+0 : anchor+1] = always 0x0352 = 850
        //   - ECT:         byte at anchor+7 (°C direct)
        //   - Dyn bytes:   anchor+4 and anchor+5 are very variable (lambda/injector?)
        //
        // Verified against 5 real captures (21B, 21B, 23B, 28B, 31B).
        anchor: [0x52, 0x03, 0xFF, 0x00],
        fields: [
            {
                name: 'Engine RPM',
                unit: 'RPM',
                confirmed: true,
                decode: (bytes, anchorIdx) => {
                    if (anchorIdx < 2) return null;
                    return (bytes[anchorIdx - 1] << 8) | bytes[anchorIdx - 2];  // LE
                },
            },
            {
                name: 'Target Idle RPM',
                unit: 'RPM',
                confirmed: true,
                decode: (bytes, anchorIdx) => {
                    if (anchorIdx + 1 >= bytes.length) return null;
                    return (bytes[anchorIdx + 1] << 8) | bytes[anchorIdx];  // always 850
                },
            },
            {
                name: 'Coolant Temp',
                unit: '°C',
                confirmed: true,
                decode: (bytes, anchorIdx) => {
                    const idx = anchorIdx + 7;
                    return idx < bytes.length ? bytes[idx] : null;
                },
            },
            {
                name: 'Dynamic A (anchor+4)',
                unit: 'raw',
                confirmed: false,
                decode: (bytes, anchorIdx) => {
                    const idx = anchorIdx + 4;
                    return idx < bytes.length ? bytes[idx] : null;
                },
            },
            {
                name: 'Dynamic B (anchor+5)',
                unit: 'raw',
                confirmed: false,
                decode: (bytes, anchorIdx) => {
                    const idx = anchorIdx + 5;
                    return idx < bytes.length ? bytes[idx] : null;
                },
            },
        ],
    },

    BLOCK_02: {
        id: '02',
        command: '2102',
        name: 'Secondary Data',
        responsePrefix: 0x61,
        fields: [
            {
                name: 'O2 Sensor',
                unit: 'mV',
                confirmed: true,
                decode: (bytes) => bytes[4] * 4,  // byte[4] × 4 = mV
            },
            {
                name: 'Short-Term Fuel Trim',
                unit: '%',
                confirmed: true,
                decode: (bytes) => {
                    const trim = ((bytes[2] - 128) / 128 * 100);
                    return Math.round(trim * 10) / 10;  // ref=128 → 0%
                },
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
