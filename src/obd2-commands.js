/**
 * OBD2 Command Definitions
 * Dictionary of common OBD2 PIDs with human-readable names and response parsers.
 */

/**
 * Parse hex bytes string into an array of integer values.
 * @param {string} hex - Hex string like "41 0C 1A F8" or "410C1AF8"
 * @returns {number[]}
 */
export function parseHexBytes(hex) {
  // Strip everything that isn't a hex digit (spaces, newlines, colons, etc.)
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  const bytes = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

/**
 * Decode DTC code from two bytes.
 * @param {number} byteA 
 * @param {number} byteB 
 * @returns {string}
 */
function decodeDTC(byteA, byteB) {
  const firstCharMap = ['P', 'C', 'B', 'U'];
  const firstChar = firstCharMap[(byteA >> 6) & 0x03];
  const secondChar = (byteA >> 4) & 0x03;
  const rest = ((byteA & 0x0F) << 8) | byteB;
  return `${firstChar}${secondChar}${rest.toString(16).toUpperCase().padStart(3, '0')}`;
}

/**
 * Common OBD2 commands organized by category.
 */
export const OBD2_COMMANDS = {
  // ═══════════════════════════════════════
  // Engine & Performance
  // ═══════════════════════════════════════
  ENGINE_RPM: {
    name: 'Engine RPM',
    command: '010C',
    unit: 'rpm',
    category: 'Engine',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      // Response: 41 0C A B → RPM = ((A * 256) + B) / 4
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      const A = bytes[dataStart + 2];
      const B = bytes[dataStart + 3];
      return ((A * 256) + B) / 4;
    }
  },

  VEHICLE_SPEED: {
    name: 'Vehicle Speed',
    command: '010D',
    unit: 'km/h',
    category: 'Vehicle',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      return bytes[dataStart + 2];
    }
  },

  ENGINE_LOAD: {
    name: 'Engine Load',
    command: '0104',
    unit: '%',
    category: 'Engine',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      return (bytes[dataStart + 2] * 100) / 255;
    }
  },

  THROTTLE_POSITION: {
    name: 'Throttle Position',
    command: '0111',
    unit: '%',
    category: 'Engine',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      return (bytes[dataStart + 2] * 100) / 255;
    }
  },

  // ═══════════════════════════════════════
  // Temperature
  // ═══════════════════════════════════════
  COOLANT_TEMP: {
    name: 'Coolant Temperature',
    command: '0105',
    unit: '°C',
    category: 'Temperature',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      return bytes[dataStart + 2] - 40;
    }
  },

  INTAKE_AIR_TEMP: {
    name: 'Intake Air Temperature',
    command: '010F',
    unit: '°C',
    category: 'Temperature',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      return bytes[dataStart + 2] - 40;
    }
  },

  // ═══════════════════════════════════════
  // Pressure & Air
  // ═══════════════════════════════════════
  INTAKE_PRESSURE: {
    name: 'Intake Manifold Pressure',
    command: '010B',
    unit: 'kPa',
    category: 'Pressure',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      return bytes[dataStart + 2];
    }
  },

  MAF_RATE: {
    name: 'MAF Air Flow Rate',
    command: '0110',
    unit: 'g/s',
    category: 'Air',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      const A = bytes[dataStart + 2];
      const B = bytes[dataStart + 3];
      return ((A * 256) + B) / 100;
    }
  },

  // ═══════════════════════════════════════
  // Electrical
  // ═══════════════════════════════════════
  CONTROL_MODULE_VOLTAGE: {
    name: 'Battery Voltage (ELM327)',
    command: 'ATRV',
    unit: 'V',
    category: 'Electrical',
    parse(response) {
      // ATRV returns something like "12.4V" or "14.2V"
      const match = response.match(/(\d+\.?\d*)\s*V/i);
      if (match) return parseFloat(match[1]);
      // Try to parse as plain number
      const num = parseFloat(response);
      return isNaN(num) ? null : num;
    }
  },

  // ═══════════════════════════════════════
  // Fuel
  // ═══════════════════════════════════════
  FUEL_LEVEL: {
    name: 'Fuel Tank Level',
    command: '012F',
    unit: '%',
    category: 'Fuel',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      return (bytes[dataStart + 2] * 100) / 255;
    }
  },

  FUEL_CONSUMPTION_RATE: {
    name: 'Fuel Consumption Rate',
    command: '015E',
    unit: 'L/h',
    category: 'Fuel',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      const A = bytes[dataStart + 2];
      const B = bytes[dataStart + 3];
      return ((A * 256) + B) / 20;
    }
  },

  FUEL_SYSTEM_STATUS: {
    name: 'Fuel System Status',
    command: '0103',
    unit: '',
    category: 'Fuel',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      const statusMap = {
        0: 'Off',
        1: 'Open loop (cold)',
        2: 'Closed loop (O2 sensor)',
        4: 'Open loop (load/decel)',
        8: 'Open loop (failure)',
        16: 'Closed loop (feedback fault)'
      };
      return statusMap[bytes[dataStart + 2]] || `Unknown (${bytes[dataStart + 2]})`;
    }
  },

  // ═══════════════════════════════════════
  // Timing
  // ═══════════════════════════════════════
  TIMING_ADVANCE: {
    name: 'Timing Advance',
    command: '010E',
    unit: '° before TDC',
    category: 'Timing',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      return (bytes[dataStart + 2] / 2) - 64;
    }
  },

  RUN_TIME: {
    name: 'Engine Run Time',
    command: '011F',
    unit: 'seconds',
    category: 'Timing',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      const A = bytes[dataStart + 2];
      const B = bytes[dataStart + 3];
      return (A * 256) + B;
    }
  },

  // ═══════════════════════════════════════
  // Diagnostics
  // ═══════════════════════════════════════
  MONITOR_STATUS: {
    name: 'Monitor Status (MIL / Check Engine)',
    command: '0101',
    unit: '',
    category: 'Diagnostics',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      const A = bytes[dataStart + 2];
      const milOn = (A & 0x80) !== 0;
      const dtcCount = A & 0x7F;
      return {
        milOn,
        dtcCount,
        text: milOn
          ? `⚠️  CHECK ENGINE ON — ${dtcCount} DTC(s) stored`
          : `✅ No check engine light — ${dtcCount} DTC(s) stored`
      };
    }
  },

  SUPPORTED_PIDS_01_20: {
    name: 'Supported PIDs [01-20]',
    command: '0100',
    unit: 'bitmask',
    category: 'Diagnostics',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x41);
      if (dataStart === -1) return null;
      const supported = [];
      for (let i = 0; i < 4; i++) {
        const byte = bytes[dataStart + 2 + i];
        for (let bit = 7; bit >= 0; bit--) {
          const pid = (i * 8) + (7 - bit) + 1;
          if ((byte >> bit) & 1) {
            supported.push(pid.toString(16).toUpperCase().padStart(2, '0'));
          }
        }
      }
      return supported;
    }
  },

  READ_DTC: {
    name: 'Read Diagnostic Trouble Codes (OBD2)',
    command: '03',
    unit: 'codes',
    category: 'Diagnostics',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      // Response: 43 XX XX XX XX ...
      const dataStart = bytes.indexOf(0x43);
      if (dataStart === -1) return [];
      const dtcs = [];
      for (let i = dataStart + 1; i < bytes.length - 1; i += 2) {
        const byteA = bytes[i];
        const byteB = bytes[i + 1];
        if (byteA === 0 && byteB === 0) continue;
        dtcs.push(decodeDTC(byteA, byteB));
      }
      return dtcs;
    }
  },

  CLEAR_DTC: {
    name: 'Clear Diagnostic Trouble Codes (OBD2)',
    command: '04',
    unit: '',
    category: 'Diagnostics',
    parse(hex) {
      return hex.includes('44') ? 'DTCs cleared successfully' : 'Failed to clear DTCs';
    }
  },

  // ═══════════════════════════════════════
  // Vehicle Info (Mode 09)
  // ═══════════════════════════════════════
  VIN: {
    name: 'Vehicle Identification Number (VIN)',
    command: '0902',
    unit: '',
    category: 'Vehicle Info',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      const dataStart = bytes.indexOf(0x49);
      if (dataStart === -1) return null;
      const vinBytes = bytes.slice(dataStart + 3);
      return vinBytes
        .filter(b => b >= 0x20 && b <= 0x7E)
        .map(b => String.fromCharCode(b))
        .join('');
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// KWP2000 Commands — for vehicles that don't support standard OBD2
// ═══════════════════════════════════════════════════════════════

export const KWP_COMMANDS = {
  // Service 18: readDiagnosticTroubleCodesByStatus
  // Format: 18 [subFunc] [statusMask] [groupHigh] [groupLow]
  // Different group values retrieve different DTC categories
  READ_DTC_KWP_18_VARIANTS: [
    { command: '1800FF00', name: 'Svc 18: group 00 (powertrain)' },
    { command: '1800FFFF', name: 'Svc 18: group FF (all groups)' },
  ],

  // Parser for any Service 18 positive response (0x58)
  parseDTC18(hex) {
    const bytes = parseHexBytes(hex);
    const dataStart = bytes.indexOf(0x58);
    if (dataStart === -1) return [];
    const dtcs = [];
    // Skip response byte (58) and sub-function echo byte
    for (let i = dataStart + 2; i + 2 < bytes.length; i += 3) {
      const byteA = bytes[i];
      const byteB = bytes[i + 1];
      const status = bytes[i + 2];
      if (byteA === 0 && byteB === 0) continue;
      const code = decodeDTC(byteA, byteB);
      const flags = [];
      if (status & 0x01) flags.push('current');
      if (status & 0x08) flags.push('confirmed');
      if (status & 0x20) flags.push('active');
      if (status & 0x40) flags.push('self-cleared');
      if (status & 0x80) flags.push('MIL on');
      const statusStr = flags.length > 0 ? ` [${flags.join(', ')}]` : ' [stored]';
      dtcs.push(code + statusStr);
    }
    return dtcs;
  },

  // Single-command accessor (primary command)
  READ_DTC_KWP_18: {
    name: 'Read DTCs (KWP service 18)',
    command: '1800FF00',
    parse(hex) { return KWP_COMMANDS.parseDTC18(hex); }
  },

  // Service 13: readDiagnosticTroubleCodes
  // 13 FF = read all stored DTCs
  READ_DTC_KWP_13: {
    name: 'Read DTCs (KWP service 13)',
    command: '13FF',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      // Positive response: 53 XX DTC_HIGH DTC_LOW ...
      const dataStart = bytes.indexOf(0x53);
      if (dataStart === -1) return [];
      const dtcs = [];
      for (let i = dataStart + 1; i + 1 < bytes.length; i += 2) {
        const byteA = bytes[i];
        const byteB = bytes[i + 1];
        if (byteA === 0 && byteB === 0) continue;
        dtcs.push(decodeDTC(byteA, byteB));
      }
      return dtcs;
    }
  },

  // Service 14: clearDiagnosticInformation
  // 14 FF 00 = clear all DTCs
  CLEAR_DTC_KWP: {
    name: 'Clear DTCs (KWP service 14)',
    command: '14FF00',
    parse(hex) {
      return hex.replace(/\s/g, '').includes('54') ? 'DTCs cleared successfully' : 'Failed to clear DTCs';
    }
  },

  // Service 17: readStatusOfDiagnosticTroubleCodes
  READ_DTC_STATUS_KWP: {
    name: 'Read DTC Status (KWP service 17)',
    command: '17FF00',
    parse(hex) {
      const bytes = parseHexBytes(hex);
      // Positive response: 57 ...
      const dataStart = bytes.indexOf(0x57);
      if (dataStart === -1) return [];
      const dtcs = [];
      for (let i = dataStart + 1; i + 2 < bytes.length; i += 3) {
        const byteA = bytes[i];
        const byteB = bytes[i + 1];
        const status = bytes[i + 2];
        if (byteA === 0 && byteB === 0) continue;
        const code = decodeDTC(byteA, byteB);
        const statusStr = (status & 0x80) ? ' [active]' : ' [stored]';
        dtcs.push(code + statusStr);
      }
      return dtcs;
    }
  },

  // Service 21 01: Read live data block 01 (raw)
  READ_DATA_21: {
    name: 'Read Data Block 01 (KWP service 21)',
    command: '2101',
    parse(hex) {
      return hex; // Return raw — need vehicle-specific mapping
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// ECU Identification Commands (KWP2000 Service 1A)
// ═══════════════════════════════════════════════════════════════

export const ECU_ID_COMMANDS = {
  ECU_IDENT: {
    name: 'ECU Identification',
    command: '1A80',
    parse(hex) {
      const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
      const idx = clean.toUpperCase().indexOf('5A80');
      if (idx === -1) return null;
      const dataHex = clean.substring(idx + 4);
      let text = '';
      for (let i = 0; i + 1 < dataHex.length; i += 2) {
        const b = parseInt(dataHex.substring(i, i + 2), 16);
        text += (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.';
      }
      return text.trim();
    }
  },

  PART_NUMBER: {
    name: 'Part Number',
    command: '1A86',
    parse(hex) {
      const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
      const idx = clean.toUpperCase().indexOf('5A86');
      if (idx === -1) return null;
      const dataHex = clean.substring(idx + 4);
      let text = '';
      for (let i = 0; i + 1 < dataHex.length; i += 2) {
        const b = parseInt(dataHex.substring(i, i + 2), 16);
        text += (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.';
      }
      return text.trim();
    }
  },

  HW_VERSION: {
    name: 'Hardware Version',
    command: '1A91',
    parse(hex) {
      const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
      const idx = clean.toUpperCase().indexOf('5A91');
      if (idx === -1) return null;
      const dataHex = clean.substring(idx + 4);
      let text = '';
      for (let i = 0; i + 1 < dataHex.length; i += 2) {
        const b = parseInt(dataHex.substring(i, i + 2), 16);
        text += (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.';
      }
      return text.trim();
    }
  },

  SW_VERSION: {
    name: 'Software Version',
    command: '1A9B',
    parse(hex) {
      const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
      const idx = clean.toUpperCase().indexOf('5A9B');
      if (idx === -1) return null;
      const dataHex = clean.substring(idx + 4);
      let text = '';
      for (let i = 0; i + 1 < dataHex.length; i += 2) {
        const b = parseInt(dataHex.substring(i, i + 2), 16);
        text += (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.';
      }
      return text.trim();
    }
  },

  SERIAL_NUMBER: {
    name: 'Serial Number',
    command: '1A87',
    parse(hex) {
      const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
      const idx = clean.toUpperCase().indexOf('5A87');
      if (idx === -1) return null;
      const dataHex = clean.substring(idx + 4);
      let text = '';
      for (let i = 0; i + 1 < dataHex.length; i += 2) {
        const b = parseInt(dataHex.substring(i, i + 2), 16);
        text += (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.';
      }
      return text.trim();
    }
  },
};

/**
 * Quick-read commands for "Read All Sensors" (OBD2 mode).
 */
export const SENSOR_COMMANDS = [
  'ENGINE_RPM',
  'VEHICLE_SPEED',
  'ENGINE_LOAD',
  'COOLANT_TEMP',
  'INTAKE_AIR_TEMP',
  'INTAKE_PRESSURE',
  'THROTTLE_POSITION',
  'CONTROL_MODULE_VOLTAGE',
  'FUEL_LEVEL',
  'TIMING_ADVANCE',
  'RUN_TIME',
  'MAF_RATE',
];

/**
 * Quick-read block IDs for "Read All Sensors" in KWP2000 mode.
 * These reference block keys from KWP_DATA_BLOCKS in ecu-profiles.js.
 */
export const KWP_SENSOR_BLOCKS = ['BLOCK_01', 'BLOCK_02', 'BLOCK_03'];

