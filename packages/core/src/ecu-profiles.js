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

/**
 * Fallback list, used only when the ECU doesn't answer the directory request
 * 1A 81 (identification scaling table). Names follow ISO 14230-3 /
 * ISO 14229 (UDS F1xx uses the same low byte); a manufacturer may use an
 * identifier differently.
 */
export const ECU_ID_SUBFUNCTIONS = {
    ECU_IDENT: { id: '80', name: 'ECU Identification' },
    SPARE_PART: { id: '87', name: 'Vehicle Manufacturer Spare Part Number' },
    VM_SW_NUMBER: { id: '88', name: 'Vehicle Manufacturer ECU Software Number' },
    SUPPLIER_ID: { id: '8A', name: 'System Supplier' },
    SERIAL_NUMBER: { id: '8C', name: 'ECU Serial Number' },
    VIN_ECU: { id: '90', name: 'VIN (from ECU)' },
    HW_NUMBER: { id: '91', name: 'Vehicle Manufacturer ECU Hardware Number' },
    SUPPLIER_HW: { id: '92', name: 'System Supplier ECU Hardware Number' },
    SUPPLIER_SW: { id: '94', name: 'System Supplier ECU Software Number' },
    ENGINE_TYPE: { id: '97', name: 'System Name / Engine Type' },
    PROGRAMMING_DATE: { id: '99', name: 'Programming Date' },
};

/**
 * Names for KWP 1A identification options (ISO 14230-3 / ISO 14229 F1xx).
 * SIM2K-33 (1A 81 directory): 8A 8B 8C 8D 8E 8F 90 91 92 98 99; only
 * 8C "KR77175201", 8D "KR77175112", 8E "W1102S52", 8F and 90 hold data.
 */
export const ECU_ID_NAMES = {
    '80': 'ECU Identification (full table)',
    '86': 'Active Diagnostic Session',
    '87': 'Vehicle Manufacturer Spare Part Number',
    '88': 'Vehicle Manufacturer ECU Software Number',
    '89': 'Vehicle Manufacturer ECU Software Version',
    '8A': 'System Supplier',
    '8B': 'ECU Manufacturing Date',
    '8C': 'ECU Serial Number',
    '8D': 'Supported Functional Units',
    '8E': 'Vehicle Manufacturer Kit Assembly Part Number',
    '8F': 'Identifier 8F (manufacturer specific)',
    '90': 'VIN (from ECU)',
    '91': 'Vehicle Manufacturer ECU Hardware Number',
    '92': 'System Supplier ECU Hardware Number',
    '93': 'System Supplier ECU Hardware Version',
    '94': 'System Supplier ECU Software Number',
    '95': 'System Supplier ECU Software Version',
    '96': 'Exhaust Regulation / Type Approval Number',
    '97': 'System Name / Engine Type',
    '98': 'Repair Shop Code / Tester Serial Number',
    '99': 'Programming Date',
    '9A': 'Calibration Repair Shop Code',
    '9B': 'Calibration Date',
    '9C': 'Calibration Equipment Software Number',
    '9D': 'ECU Installation Date',
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

/** Engine state bits (byte 71). Seen: 0x01 0x04 0x08 0x10 0x28 (WOT while driving), 0x00 (transition). */
const ENGINE_STATE_BITS = [
    [0x01, 'parado'],
    [0x04, 'ralentí'],
    [0x08, 'carga parcial'],
    [0x10, 'corte combustible (desaceleración)'],
    [0x20, 'plena carga'],
];
function describeEngineState(v) {
    const names = ENGINE_STATE_BITS.filter(([bit]) => v & bit).map(([, n]) => n);
    const unknown = v & ~ENGINE_STATE_BITS.reduce((a, [bit]) => a | bit, 0);
    if (unknown) names.push(`0x${unknown.toString(16).toUpperCase()}`);
    return names.length ? names.join(' + ') : 'transición (0x00)';
}

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
                    return v === null ? null : describeEngineState(v);
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
                // Behaves like MAP (idle ~24–38, decel ~18, tip-in ~59, light-load
                // ceiling ~92–93), but raw/100 is NOT absolute kPa: engine off on
                // 2026-11-20 06:15 it read 93.6 while the real surface pressure in
                // the test site (2333 m) was 77.6 kPa (Open-Meteo). The old "93.8 =
                // barometric" check assumed sea level. Neither a pure scale
                // (idle → ~20 kPa) nor an offset (idle → ~8 kPa) fits, so the
                // scaling stays as-is and unconfirmed. Next: log engine off +
                // idle + WOT and compare with the known 77–78 kPa.
                name: 'Intake Manifold Pressure (MAP)',
                unit: 'kPa',
                confirmed: false,
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
                // Cold soak 2026-11-20 06:15, ~14 h parked: 19.5 °C with 14.0 °C
                // outdoors (Open-Meteo, test site at 2333 m); the air sensor read
                // 22.5 °C. Both sensors above outdoor air by a similar margin →
                // the engine bay was warmer than outside, not a coolant offset.
                // Scaling kept: a −5.5 °C offset would make warm idle 81 °C,
                // below the usual thermostat opening.
                name: 'Coolant Temp',
                unit: '°C',
                confirmed: true,
                decode: (b) => {
                    const v = u8(b, 3);
                    return v === null ? null : Math.round((v * 0.75 - 48) * 10) / 10;
                },
            },
            {
                // Vehicle speed, 1 km/h per count. CONFIRMED against GPS
                // (2026-11-20, phone PWA calibration, 15–40 km/h): GPS/ECU
                // ≈ 1.00 (0.97–1.04) at steady speed; best-matching byte of
                // the whole block. The dash speedometer reads HIGH (earlier
                // note: dash ~20/40/60 vs ECU ~15/35/40), not the ECU low.
                // ECU lags GPS ~0.5–1 s; reads 0 below ~4 km/h.
                // About 1 read in 25 jumps UP 1.4–2× for ~1 s (P0501, extra
                // VSS pulses): SpeedSpikeFilter (speed-filter.js) holds them.
                // Still to check: linearity above 40 km/h.
                name: 'Vehicle Speed (ECU)',
                unit: 'km/h',
                confirmed: true,
                decode: (b) => u8(b, 18),
            },
            {
                // Narrowband upstream O2 sensor. Switches 28↔174 at idle (closed
                // loop), drops to 2–15 in decel fuel cut (lean), ~178 on tip-in
                // (rich). ≈5 mV/count puts it at 10–890 mV, the normal narrowband
                // range; the exact scale is not verified with a multimeter.
                name: 'O2 Sensor B1S1',
                unit: 'mV',
                confirmed: true,
                decode: (b) => {
                    const v = u8(b, 25);
                    return v === null ? null : v * 5;
                },
            },
            {
                // Signed. Moves opposite to the O2 sensor (rich → negative) and is
                // exactly 0 in fuel cut / open loop → closed-loop lambda control.
                // Scale assumed 32768 = 100 % (not verified).
                name: 'Short-Term Fuel Trim (lambda ctrl)',
                unit: '%',
                confirmed: false,
                decode: (b) => {
                    const v = le16(b, 46);
                    if (v === null) return null;
                    const s = v > 32767 ? v - 65536 : v;
                    return Math.round(s / 327.68 * 10) / 10;
                },
            },
            {
                // 2.7 ms idle, 5.2 ms tip-in, 0.8 ms decel, 0 engine off.
                // Assumed µs (typical values for a 1.x L engine).
                name: 'Injection Pulse',
                unit: 'ms',
                confirmed: false,
                decode: (b) => {
                    const v = le16(b, 15);
                    return v === null ? null : Math.round(v / 10) / 100;
                },
            },
            {
                // Five LE16 values (×4 µs ≈ 2.4 ms idle) tracking Injection Pulse
                // at ~0.23 ratio-offset (likely without injector dead time).
                name: 'Injection per cyl. (×4µs)',
                unit: 'ms',
                confirmed: false,
                decode: (b) => {
                    const vals = [33, 35, 37, 39, 41].map(i => le16(b, i));
                    if (vals.some(v => v === null)) return null;
                    return vals.map(v => (v * 0.004).toFixed(2)).join(' / ');
                },
            },
            {
                // Same layout as the coolant pair (bytes 2/3): byte 4 is the
                // raw NTC sensor value (falls as it warms) and byte 5 the
                // linearized temperature, scaled 0.75·x − 48.
                // Cold soak 2026-11-20 06:15 (outdoor 14.0 °C, coolant 19.5 °C):
                //   byte 4 = 187, byte 5 = 94 → 22.5 °C (byte 4 with x−40 gave 147 °C,
                //   which ruled out the previous hypothesis).
                // Warm idle: byte 5 = 163 → 74 °C, plausible for a heat-soaked
                // manifold-mounted sensor at idle. Not yet confirmed.
                name: 'Intake Air Temp',
                unit: '°C',
                confirmed: false,
                decode: (b) => {
                    const v = u8(b, 5);
                    return v === null ? null : Math.round((v * 0.75 - 48) * 10) / 10;
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
            {
                // Four identical values (one per cylinder): 185 idle, 130 @2150,
                // 102 @3730, 150 decel. Possibly per-cylinder ignition angle /
                // knock retard (identical = no knock correction).
                name: 'Per-cylinder value (raw)',
                unit: 'raw',
                confirmed: false,
                decode: (b) => {
                    const vals = [29, 30, 31, 32].map(i => u8(b, i));
                    return vals.some(v => v === null) ? null : vals.join(' / ');
                },
            },
            {
                // 0 engine off, 98–144 running; slow steps. Possibly idle air
                // control / idle actuator position.
                name: 'Idle control? (raw)',
                unit: 'raw',
                confirmed: false,
                decode: (b) => u8(b, 54),
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
            // 1085 removed: on KWP2000 0x85 is ECU *programming* mode. SIM2K-33
            // accepts it but then rejects data reads (2101 → NRC 0x80), so it
            // was never a useful fallback and leaves the ECU in the wrong mode.
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
