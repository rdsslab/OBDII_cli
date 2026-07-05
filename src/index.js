/**
 * OBD2 ELM327 Bluetooth - Interactive CLI Application
 * Supports both standard OBD2 and KWP2000 diagnostic protocols.
 */

import * as readline from 'readline';
import * as fs from 'fs';
import { listPorts } from './bluetooth.js';
import { ELM327 } from './elm327.js';
import { OBD2_COMMANDS, KWP_COMMANDS, SENSOR_COMMANDS, ECU_ID_COMMANDS, KWP_SENSOR_BLOCKS } from './obd2-commands.js';
import { ECU_PROFILES, KWP_DATA_BLOCKS, listProfiles, getProfile } from './ecu-profiles.js';
import { generateHTMLReport } from './dtc-database.js';

// ═══════════════════════════════════════════════════════════════
// ANSI Colors
// ═══════════════════════════════════════════════════════════════
const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
};

const elm327 = new ELM327();

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function clearScreen() {
    process.stdout.write('\x1b[2J\x1b[H');
}

function printHeader() {
    console.log(`
${C.cyan}${C.bold}╔═══════════════════════════════════════════════════════════╗
║            🚗  OBD2 ELM327 Bluetooth Scanner  🔧           ║
╚═══════════════════════════════════════════════════════════╝${C.reset}
`);
}

function printSeparator(label = '') {
    if (label) {
        console.log(`\n${C.dim}─── ${C.cyan}${label} ${C.dim}${'─'.repeat(50 - label.length)}${C.reset}\n`);
    } else {
        console.log(`${C.dim}${'─'.repeat(60)}${C.reset}`);
    }
}

function printSuccess(msg) { console.log(`  ${C.green}✅ ${msg}${C.reset}`); }
function printError(msg) { console.log(`  ${C.red}❌ ${msg}${C.reset}`); }
function printWarning(msg) { console.log(`  ${C.yellow}⚠️  ${msg}${C.reset}`); }
function printInfo(msg) { console.log(`  ${C.blue}ℹ  ${msg}${C.reset}`); }

function printValue(label, value, unit = '') {
    const unitStr = unit ? ` ${C.dim}${unit}${C.reset}` : '';
    console.log(`  ${C.white}${label}:${C.reset} ${C.bold}${C.green}${value}${C.reset}${unitStr}`);
}

function ask(rl, question) {
    return new Promise((resolve) => {
        rl.question(`${C.yellow}${question}${C.reset}`, (answer) => {
            resolve(answer.trim());
        });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════
// Port Selection & Connection
// ═══════════════════════════════════════════════════════════════

async function selectPort(rl) {
    printSeparator('Available Serial/COM Ports');
    const ports = await listPorts();

    if (ports.length === 0) {
        printError('No serial ports found.');
        printInfo('Make sure your ELM327 is paired via Bluetooth in Windows settings.');
        return null;
    }

    ports.forEach((port, index) => {
        const mfg = port.manufacturer !== 'Unknown' ? ` [${port.manufacturer}]` : '';
        console.log(`  ${C.cyan}${index + 1}.${C.reset} ${C.bold}${port.path}${C.reset}${C.dim}${mfg} - ${port.friendlyName}${C.reset}`);
    });

    console.log();
    const choice = await ask(rl, `Select port (1-${ports.length}): `);
    const index = parseInt(choice) - 1;

    if (isNaN(index) || index < 0 || index >= ports.length) {
        printError('Invalid selection.');
        return null;
    }

    return ports[index].path;
}

async function connectToDevice(rl, portPath, profile = null) {
    printSeparator('Connecting');

    try {
        console.log(`  ${C.dim}Connecting to ${portPath}...${C.reset}`);
        await elm327.connect(portPath);
        printSuccess(`Connected to ${portPath}`);

        console.log(`  ${C.dim}Initializing ELM327...${C.reset}`);
        const info = await elm327.initialize(profile);
        printSuccess(`Device: ${info.version}`);
        printInfo(`Protocol: ${info.protocol}`);
        printInfo(`Mode: ${info.mode.toUpperCase()}`);
        if (info.profile) {
            printSuccess(`ECU Profile: ${info.profile}`);
        }

        if (info.mode === 'unknown') {
            console.log();
            printWarning('The ECU does not support standard OBD2 or KWP2000 services.');
            printInfo('You can still use "Send Custom Command" and "Scan Services"');
            printInfo('to explore what the ECU supports.');
        }

        await sleep(500);
        return true;
    } catch (err) {
        printError(`Connection failed: ${err.message}`);
        printInfo('Tips:');
        printInfo('  1. Ensure the ELM327 is paired in Windows Bluetooth settings');
        printInfo('  2. Check Device Manager for the correct COM port');
        printInfo('  3. Make sure the ELM327 is plugged into the OBD2 port');
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
// OBD2 Command Execution
// ═══════════════════════════════════════════════════════════════

async function readSingleCommand(cmdKey) {
    const cmd = OBD2_COMMANDS[cmdKey];
    if (!cmd) {
        printError(`Unknown command: ${cmdKey}`);
        return null;
    }

    const result = await elm327.sendCommand(cmd.command);

    if (!result.success) {
        printWarning(`${cmd.name}: ${result.error || 'No data'}`);
        return null;
    }

    try {
        const parsed = cmd.parse(result.data);
        if (parsed === null || parsed === undefined) {
            printWarning(`${cmd.name}: Could not parse response`);
            return null;
        }
        return { name: cmd.name, value: parsed, unit: cmd.unit, raw: result.data };
    } catch (err) {
        printWarning(`${cmd.name}: Parse error - ${err.message}`);
        return null;
    }
}

async function readAllSensors() {
    printSeparator('Reading All Sensors');

    // If we have an ECU profile (like SIM2K-33), strictly use KWP data blocks
    if (elm327.profile || elm327.mode === 'kwp2000') {
        const profileName = elm327.profile?.name || 'KWP2000';
        printInfo(`Using KWP2000 data blocks (profile: ${profileName})...`);
        console.log();

        let decodedCount = 0;

        for (const blockKey of KWP_SENSOR_BLOCKS) {
            const blockDef = KWP_DATA_BLOCKS[blockKey];
            if (!blockDef) continue;

            console.log(`  ${C.bold}${blockDef.name}${C.reset}  ${C.dim}(${blockDef.command})${C.reset}`);
            const raw = await elm327.readKWPDataBlock(blockDef.id);

            if (!raw.success || raw.bytes.length === 0) {
                printWarning(`  ${blockDef.name}: No data (${raw.error || 'Check connection'})`);
                console.log();
                continue;
            }

            const bytes = raw.bytes;

            // Resolve anchor index for pattern-based blocks (e.g. BLOCK_01)
            let anchorIdx = 0;
            if (blockDef.anchor) {
                const found = (() => {
                    for (let i = 0; i <= bytes.length - blockDef.anchor.length; i++) {
                        if (blockDef.anchor.every((b, j) => bytes[i + j] === b)) return i;
                    }
                    return -1;
                })();
                if (found === -1) {
                    console.log(`  ${C.dim}  ⚠ Anchor pattern not found — showing raw only${C.reset}`);
                } else {
                    anchorIdx = found;
                }
            }

            // Decode calibrated fields
            if (blockDef.fields && blockDef.fields.length > 0) {
                for (const field of blockDef.fields) {
                    try {
                        const value = field.decode(bytes, anchorIdx);
                        if (value === null || value === undefined) continue;
                        if (field.confirmed) {
                            printValue(field.name, value, field.unit);
                            decodedCount++;
                        } else {
                            console.log(`  ${C.dim}? ${field.name}: ${value} ${field.unit}  [needs calibration]${C.reset}`);
                        }
                    } catch {
                        // skip field if decode throws
                    }
                }
            }

            // Always show raw hex for additional calibration
            const hexStr = bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
            console.log(`  ${C.dim}Raw [${bytes.length}B]: ${hexStr}${C.reset}`);
            console.log();
        }

        // Battery voltage from ELM327 (ATRV — always reliable)
        const atrvResponse = await elm327.sendRaw('ATRV', 3000);
        const voltMatch = atrvResponse.match(/([\d.]+)\s*V/i);
        if (voltMatch) {
            printValue('Battery Voltage (ELM327)', voltMatch[1], 'V');
            decodedCount++;
        }

        console.log();
        if (decodedCount === 0) {
            printWarning('No sensor data. Make sure ignition is ON.');
        } else {
            printSuccess(`${decodedCount} values decoded`);
        }
        return;
    }


    // Standard OBD2 mode
    if (elm327.mode === 'unknown') {
        printWarning('Standard OBD2 sensors may not work with this ECU.');
        printInfo('Trying anyway...');
        console.log();
    }

    console.log(`  ${C.dim}Reading ${SENSOR_COMMANDS.length} sensors...${C.reset}\n`);

    let successCount = 0;
    for (const cmdKey of SENSOR_COMMANDS) {
        const result = await readSingleCommand(cmdKey);
        if (result) {
            printValue(result.name, result.value, result.unit);
            successCount++;
        }
    }

    console.log();
    if (successCount === 0) {
        printWarning('No sensors returned data.');
        printInfo('Your vehicle may use non-standard PIDs.');
        printInfo('Try "Scan Services" (option 15) to discover supported commands.');
    } else {
        printSuccess(`${successCount}/${SENSOR_COMMANDS.length} sensors read successfully`);
    }
}

async function readDTCs() {
    printSeparator('Diagnostic Trouble Codes (DTCs)');

    let dtcs = null;
    let obd2Result = null;

    // Skip ALL OBD2 commands if we have a KWP profile or are in KWP mode
    // (elm327.mode can become 'unknown' after recovery failures even with a live KWP session)
    const isKWP = elm327.mode === 'kwp2000' || !!elm327.profile;

    if (!isKWP) {
        // Try OBD2 Monitor Status first
        const statusResult = await readSingleCommand('MONITOR_STATUS');
        if (statusResult) {
            const status = statusResult.value;
            console.log(`  ${status.text}`);
            console.log();
        }

        // Try OBD2 Mode 03
        obd2Result = await elm327.sendCommand(OBD2_COMMANDS.READ_DTC.command);
        if (obd2Result.success) {
            dtcs = OBD2_COMMANDS.READ_DTC.parse(obd2Result.data);
        } else if (obd2Result.data?.includes('BUS INIT: ERROR')) {
            printWarning('Bus initialization failed. Make sure ignition is ON.');
        }
    }

    // Try KWP2000 services if OBD2 failed or we're in KWP mode
    if (!dtcs || isKWP) {
        if (!isKWP) {
            printInfo('OBD2 Mode 03 not supported, trying KWP2000...');
        }

        // Always re-activate the diagnostic session BEFORE reading DTCs
        // Some ECUs (like SIM2K-33) reject Service 18 if session is not fresh
        const sessionCmds = elm327.profile?.sessions?.map(s => s.cmd) || ['1081'];
        let sessionOk = false;
        for (const sc of sessionCmds) {
            const sr = await elm327.sendRaw(sc, 3000);
            if (/^50/.test(sr.replace(/\s/g, ''))) { sessionOk = true; break; }
        }
        if (sessionOk) {
            printInfo('Session (re-)activated ✅');
        } else {
            printInfo('Session re-activation skipped (may already be active)');
        }

        const allDtcs = new Set();
        let svc18worked = false;

        // Service 18: ReadDTCByStatus — try statusMask variants
        // Format: 18 [mask] [groupH] [groupL]
        // SIM2K-33 confirmed: mask=0x00 works. mask=0xFF returns NRC 0x12.
        const service18Variants = [
            { cmd: '1800FF00', label: 'mask=00 all-groups' },   // ✅ confirmed on SIM2K-33
            { cmd: '18FFFF00', label: 'mask=FF all-groups' },   // some other ECUs
            { cmd: '18FF0000', label: 'mask=FF powertrain' },   // some other ECUs
        ];

        for (const variant of service18Variants) {
            const r = await elm327.sendCommand(variant.cmd);
            if (r.success) {
                svc18worked = true;
                const found = KWP_COMMANDS.parseDTC18(r.data);
                printInfo(`Svc 18 [${variant.label}]: ${found.length} DTC(s) — raw: ${r.data.substring(0, 40)}`);
                found.forEach(d => allDtcs.add(d));
            } else {
                printInfo(`Svc 18 [${variant.label}]: ${r.error || r.data}`);
            }
        }

        // Only try alternative services if Service 18 failed entirely
        if (!svc18worked) {
            const kwp13 = await elm327.sendCommand(KWP_COMMANDS.READ_DTC_KWP_13.command);
            if (kwp13.success) {
                const found13 = KWP_COMMANDS.READ_DTC_KWP_13.parse(kwp13.data);
                if (found13.length > 0) {
                    printInfo(`KWP service 13: ${found13.length} DTC(s)`);
                    found13.forEach(d => allDtcs.add(d));
                }
            }

            const kwp17 = await elm327.sendCommand(KWP_COMMANDS.READ_DTC_STATUS_KWP.command);
            if (kwp17.success) {
                const found17 = KWP_COMMANDS.READ_DTC_STATUS_KWP.parse(kwp17.data);
                if (found17.length > 0) {
                    printInfo(`KWP service 17: ${found17.length} DTC(s)`);
                    found17.forEach(d => allDtcs.add(d));
                }
            }
        }

        if (allDtcs.size > 0) {
            dtcs = [...allDtcs];
        }
    }


    // Show results
    if (!dtcs || dtcs.length === 0) {
        printSuccess('No Diagnostic Trouble Codes found');
    } else {
        printWarning(`Found ${dtcs.length} DTC(s):`);
        dtcs.forEach((dtc, i) => {
            console.log(`    ${C.yellow}${i + 1}. ${C.bold}${dtc}${C.reset}`);
        });
        console.log();
        printInfo('Look up codes at: https://www.obd-codes.com/');
    }
    return dtcs;
}

async function clearDTCs(rl) {
    printSeparator('Clear DTCs');
    printWarning('This will clear all stored Diagnostic Trouble Codes.');

    const confirm = await ask(rl, '\n  Are you sure? (y/N): ');
    if (confirm.toLowerCase() !== 'y') {
        printInfo('Cancelled');
        return;
    }

    // Try OBD2 Mode 04 first if not already in KWP mode
    let result;
    if (elm327.mode !== 'kwp2000') {
        result = await elm327.sendCommand(OBD2_COMMANDS.CLEAR_DTC.command);
        if (result.success) {
            const parsed = OBD2_COMMANDS.CLEAR_DTC.parse(result.data);
            printSuccess(parsed);
            return;
        }
    }

    // Try KWP Service 14
    if (elm327.mode !== 'kwp2000') {
        printInfo('OBD2 Mode 04 not supported, trying KWP service 14...');
    }
    result = await elm327.sendCommand(KWP_COMMANDS.CLEAR_DTC_KWP.command);
    if (result.success) {
        const parsed = KWP_COMMANDS.CLEAR_DTC_KWP.parse(result.data);
        printSuccess(parsed);
    } else {
        printError(`Failed to clear DTCs: ${result.error || result.data}`);
    }
}

async function saveDTCs(rl) {
    printSeparator('Guardar DTCs en archivo HTML');
    
    // Re-use readDTCs to get the current list
    let dtcs = await readDTCs();
    if (!dtcs) {
        dtcs = [];
    }

    const now = new Date();
    const dateStr = now.toLocaleString();
    const filename = `dtc_report_${now.toISOString().replace(/[:.]/g, '-')}.html`;
    
    const htmlContent = generateHTMLReport(dtcs, dateStr);
    
    try {
        fs.writeFileSync(filename, htmlContent, 'utf8');
        printSuccess(`Reporte guardado exitosamente en: ${filename}`);
        if (dtcs.length === 0) {
            printInfo('El reporte indica que no hay errores.');
        } else {
            printInfo('Abre el archivo HTML en tu navegador web para ver el detalle visual y soluciones de los códigos.');
        }
    } catch (err) {
        printError(`Error al guardar el archivo: ${err.message}`);
    }
}

async function readVIN() {
    printSeparator('Vehicle Identification Number');

    // In KWP mode, we might want to show VIN from Service 1A if Mode 09 fails
    let vin = null;

    if (elm327.mode !== 'kwp2000') {
        const result = await elm327.sendCommand(OBD2_COMMANDS.VIN.command);
        if (result.success) {
            vin = OBD2_COMMANDS.VIN.parse(result.data);
        }
    }

    if (!vin && elm327.ecuInfo && elm327.ecuInfo['VIN (from ECU)']) {
        vin = elm327.ecuInfo['VIN (from ECU)'];
    }

    if (vin) {
        printValue('VIN', vin);
    } else {
        printWarning('Could not read VIN. This ECU might not support Mode 09 or Service 1A 0x80.');
        printInfo('Try reading ECU Identification (Option 16).');
    }
}

async function sendCustomCommand(rl) {
    printSeparator('Custom Command');
    printInfo('Enter any AT, OBD2, or KWP2000 command');
    printInfo('Examples: ATI, ATRV, 0100, 010C, 2101, 1081, 03');
    printInfo('Type "back" to return to menu');

    while (true) {
        const cmd = await ask(rl, '\n  Command > ');
        if (cmd.toLowerCase() === 'back' || cmd === '') break;

        console.log(`  ${C.dim}Sending: ${cmd}${C.reset}`);
        const result = await elm327.sendCommand(cmd);

        if (result.success) {
            console.log(`  ${C.green}Response:${C.reset} ${C.bold}${result.data}${C.reset}`);
        } else {
            console.log(`  ${C.red}Error:${C.reset} ${result.error || result.data}`);
            console.log(`  ${C.dim}Raw: ${result.data}${C.reset}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Service Scanner — discover what the ECU supports
// ═══════════════════════════════════════════════════════════════

async function scanServices() {
    printSeparator('Scanning ECU Services');
    printInfo('Testing which services the ECU supports...');
    console.log();

    const servicesToTest = [
        { cmd: '0100', name: 'Mode 01 - Live Data (OBD2)', desc: 'Standard OBD2 sensor data' },
        { cmd: '0200', name: 'Mode 02 - Freeze Frame (OBD2)', desc: 'Frozen data from when DTC was set' },
        { cmd: '03', name: 'Mode 03 - Read DTCs (OBD2)', desc: 'Read diagnostic trouble codes' },
        // Mode 04 (Clear DTCs) removed to avoid accidental clearing during scan
        { cmd: '0600', name: 'Mode 06 - Test Results (OBD2)', desc: 'On-board monitoring test results' },
        { cmd: '07', name: 'Mode 07 - Pending DTCs (OBD2)', desc: 'Pending diagnostic trouble codes' },
        { cmd: '09', name: 'Mode 09 - Vehicle Info (OBD2)', desc: 'VIN, calibration ID, etc.' },
        { cmd: '0A', name: 'Mode 0A - Permanent DTCs (OBD2)', desc: 'Permanent diagnostic trouble codes' },
        { cmd: '1081', name: 'Svc 10 - Start Diag Session (KWP)', desc: 'Start diagnostic session' },
        { cmd: '13FF', name: 'Svc 13 - Read DTCs (KWP)', desc: 'KWP read diagnostic trouble codes' },
        // Svc 14 (Clear DTCs) removed to avoid accidental clearing during scan
        { cmd: '17FF00', name: 'Svc 17 - DTC Status (KWP)', desc: 'KWP read DTC status' },
        { cmd: '1800FF00', name: 'Svc 18 - DTCs by Status (KWP)', desc: 'KWP read DTCs by status mask' },
        { cmd: '1A80', name: 'Svc 1A - Read ECU ID (KWP)', desc: 'Read ECU identification' },
        { cmd: '2101', name: 'Svc 21 - Read Data Local ID (KWP)', desc: 'Read data by local identifier' },
        { cmd: '220100', name: 'Svc 22 - Read Data by ID (KWP)', desc: 'Read data by identifier' },
        { cmd: '1902', name: 'Svc 19 - Read DTC Info (UDS)', desc: 'UDS read DTC information' },
        { cmd: '3E', name: 'Svc 3E - Tester Present (KWP/UDS)', desc: 'Keep session alive' },
    ];

    const supported = [];
    const notSupported = [];

    for (const svc of servicesToTest) {
        process.stdout.write(`  ${C.dim}Testing ${svc.cmd}...${C.reset}`);
        const result = await elm327.sendCommand(svc.cmd);

        if (result.success) {
            process.stdout.write(`\r  ${C.green}✅ ${svc.name}${C.reset}\n`);
            console.log(`     ${C.dim}${svc.desc}${C.reset}`);
            console.log(`     ${C.dim}Response: ${result.data.substring(0, 60)}${result.data.length > 60 ? '...' : ''}${C.reset}`);
            supported.push(svc);
        } else {
            process.stdout.write(`\r  ${C.red}❌ ${svc.name}${C.reset}\n`);
            notSupported.push(svc);
        }
    }

    console.log();
    printSeparator('Scan Results');
    printInfo(`Supported: ${supported.length} / ${servicesToTest.length} services`);

    if (supported.length > 0) {
        console.log();
        printSuccess('Your ECU supports:');
        supported.forEach(s => {
            console.log(`    ${C.green}•${C.reset} ${s.name}`);
        });
    }

    if (supported.length === 0) {
        console.log();
        printWarning('No standard services detected.');
        printInfo('Try sending raw commands in "Custom Command" mode.');
        printInfo('Common KWP2000 commands to try:');
        console.log(`    ${C.cyan}2102${C.reset} - Read data group 02`);
        console.log(`    ${C.cyan}2103${C.reset} - Read data group 03`);
        console.log(`    ${C.cyan}1A87${C.reset} - ECU serial number`);
        console.log(`    ${C.cyan}1A91${C.reset} - ECU hardware number`);
        console.log(`    ${C.cyan}1A9B${C.reset} - ECU software number`);
    }
}

// ═══════════════════════════════════════════════════════════════
// ECU Info & KWP Live Data — new features with SIM2K-33 profile
// ═══════════════════════════════════════════════════════════════

async function readECUInfoMenu() {
    printSeparator('ECU Identification (KWP Service 1A)');
    printInfo('Reading ECU identification data...');
    console.log();

    const info = await elm327.readECUInfo();
    const entries = Object.entries(info);

    if (entries.length === 0) {
        printWarning('Could not read any ECU identification data.');
        printInfo('Service 1A may not be supported by this ECU.');
        printInfo('Try reading individual sub-functions with Custom Command:');
        console.log(`    ${C.cyan}1A80${C.reset} - ECU Identification`);
        console.log(`    ${C.cyan}1A86${C.reset} - Part Number`);
        console.log(`    ${C.cyan}1A87${C.reset} - Serial Number`);
        console.log(`    ${C.cyan}1A91${C.reset} - Hardware Version`);
        console.log(`    ${C.cyan}1A9B${C.reset} - Software Version`);
        return;
    }

    for (const [name, data] of entries) {
        printValue(name, data.text || data.hex);
        if (data.text && data.hex) {
            console.log(`    ${C.dim}Hex: ${data.hex}${C.reset}`);
        }
    }

    // Show known profile info if available
    if (elm327.profile) {
        console.log();
        printSeparator('Profile Info');
        printValue('ECU Model', elm327.profile.name);
        printValue('Part Numbers', elm327.profile.partNumbers.join(', '));
        printValue('Vehicle', elm327.profile.vehicle);
    }
}

async function readKWPLiveData() {
    printSeparator('KWP2000 Live Data (Service 21)');

    for (const blockKey of KWP_SENSOR_BLOCKS) {
        const blockDef = KWP_DATA_BLOCKS[blockKey];
        if (!blockDef) continue;

        console.log();
        console.log(`  ${C.cyan}${C.bold}── ${blockDef.name} (${blockDef.command}) ──${C.reset}`);

        // Read raw data
        const raw = await elm327.readKWPDataBlock(blockDef.id);
        if (!raw.success) {
            printWarning(`Block ${blockDef.id}: No response`);
            continue;
        }

        const bytes = raw.bytes;

        // Show byte-indexed hex dump (8 bytes per row)
        console.log(`  ${C.dim}${bytes.length} bytes:${C.reset}`);
        for (let i = 0; i < bytes.length; i += 8) {
            const chunk = bytes.slice(i, Math.min(i + 8, bytes.length));
            const hexPart = chunk.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
            const decPart = chunk.map(b => String(b).padStart(3)).join(' ');
            const pos = `[${String(i).padStart(2)}]`;
            console.log(`    ${C.dim}${pos}${C.reset} ${hexPart}  ${C.dim}(${decPart})${C.reset}`);
        }
    }

    // Battery voltage — always reliable via ELM327 ATRV
    console.log();
    const atrv = await elm327.sendRaw('ATRV', 3000);
    const voltMatch = atrv.match(/([\d.]+)\s*V/i);
    if (voltMatch) {
        printValue('Battery Voltage (ATRV)', voltMatch[1], 'V');
    }

    console.log();
    printInfo('Response length varies (9-35 bytes observed for block 01).');
    printInfo('Byte positions shift between sessions — raw dump only.');
    printInfo('Use ATRV for reliable battery voltage reading.');
}

// ═══════════════════════════════════════════════════════════════
// Main Menu
// ═══════════════════════════════════════════════════════════════

function printMenu() {
    printSeparator('Main Menu');
    console.log(`  ${C.cyan} 1.${C.reset} 📊  Read All Sensors${elm327.mode === 'kwp2000' ? ' (KWP)' : ''}`);
    console.log(`  ${C.cyan} 2.${C.reset} 🔧  Engine RPM`);
    console.log(`  ${C.cyan} 3.${C.reset} 🚗  Vehicle Speed`);
    console.log(`  ${C.cyan} 4.${C.reset} 🌡️   Coolant Temperature`);
    console.log(`  ${C.cyan} 5.${C.reset} ⚡  Engine Load`);
    console.log(`  ${C.cyan} 6.${C.reset} 🎚️   Throttle Position`);
    console.log(`  ${C.cyan} 7.${C.reset} 🔋  Battery Voltage`);
    console.log(`  ${C.cyan} 8.${C.reset} ⛽  Fuel Level`);
    console.log(`  ${C.cyan} 9.${C.reset} 🕐  Engine Run Time`);
    console.log(`  ${C.cyan}10.${C.reset} 🚨  Read DTCs (Trouble Codes)`);
    console.log(`  ${C.cyan}11.${C.reset} 🧹  Clear DTCs`);
    console.log(`  ${C.cyan}12.${C.reset} 🔍  Read VIN`);
    console.log(`  ${C.cyan}13.${C.reset} 📡  Send Custom Command`);
    console.log(`  ${C.cyan}14.${C.reset} 🔄  Read Supported PIDs`);
    console.log(`  ${C.cyan}15.${C.reset} 🔎  Scan ECU Services`);
    console.log(`  ${C.cyan}16.${C.reset} 🏷️   Read ECU Info (KWP 1A)`);
    console.log(`  ${C.cyan}17.${C.reset} 📈  Read KWP Data Blocks (Live)`);
    console.log(`  ${C.cyan}18.${C.reset} 🗑️   Borrar Códigos de Error (Español)`);
    console.log(`  ${C.cyan}19.${C.reset} 💾  Guardar DTCs en archivo de texto`);
    console.log(`  ${C.cyan} 0.${C.reset} ❌  Disconnect & Exit`);
    console.log();
}

async function handleMenuChoice(rl, choice) {
    switch (choice) {
        case '1':
            await readAllSensors();
            break;
        case '2': {
            const r = await readSingleCommand('ENGINE_RPM');
            if (r) printValue(r.name, r.value, r.unit);
            break;
        }
        case '3': {
            const r = await readSingleCommand('VEHICLE_SPEED');
            if (r) printValue(r.name, r.value, r.unit);
            break;
        }
        case '4': {
            const r = await readSingleCommand('COOLANT_TEMP');
            if (r) printValue(r.name, r.value, r.unit);
            break;
        }
        case '5': {
            const r = await readSingleCommand('ENGINE_LOAD');
            if (r) printValue(r.name, r.value, r.unit);
            break;
        }
        case '6': {
            const r = await readSingleCommand('THROTTLE_POSITION');
            if (r) printValue(r.name, r.value, r.unit);
            break;
        }
        case '7': {
            const r = await readSingleCommand('CONTROL_MODULE_VOLTAGE');
            if (r) printValue(r.name, r.value, r.unit);
            break;
        }
        case '8': {
            const r = await readSingleCommand('FUEL_LEVEL');
            if (r) printValue(r.name, r.value, r.unit);
            break;
        }
        case '9': {
            const r = await readSingleCommand('RUN_TIME');
            if (r) {
                const minutes = Math.floor(r.value / 60);
                const seconds = r.value % 60;
                printValue(r.name, `${minutes}m ${seconds}s`, `(${r.value}s)`);
            }
            break;
        }
        case '10':
            await readDTCs();
            break;
        case '11':
            await clearDTCs(rl);
            break;
        case '12':
            await readVIN();
            break;
        case '13':
            await sendCustomCommand(rl);
            break;
        case '14': {
            const r = await readSingleCommand('SUPPORTED_PIDS_01_20');
            if (r) {
                printInfo(`Supported PIDs: ${r.value.join(', ')}`);
            }
            break;
        }
        case '15':
            await scanServices();
            break;
        case '16':
            await readECUInfoMenu();
            break;
        case '17':
            await readKWPLiveData();
            break;
        case '18':
            await clearDTCs(rl);
            break;
        case '19':
            await saveDTCs(rl);
            break;
        default:
            printError('Invalid option. Please select 0-19.');
    }
}

// ═══════════════════════════════════════════════════════════════
// Application Entry Point
// ═══════════════════════════════════════════════════════════════

export async function main() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    clearScreen();
    printHeader();

    try {
        const portPath = await selectPort(rl);
        if (!portPath) { rl.close(); return; }

        // ── ECU Profile Selection ──
        let selectedProfile = null;
        const profiles = listProfiles();
        if (profiles.length > 0) {
            printSeparator('ECU Profile');
            console.log(`  ${C.cyan}0.${C.reset} ${C.bold}Auto-detect${C.reset} ${C.dim}(generic, slower)${C.reset}`);
            profiles.forEach((p, i) => {
                console.log(`  ${C.cyan}${i + 1}.${C.reset} ${C.bold}${p.name}${C.reset} ${C.dim}— ${p.vehicle}${C.reset}`);
                console.log(`     ${C.dim}${p.description}${C.reset}`);
            });
            console.log();
            const profileChoice = await ask(rl, `  Select ECU profile (0-${profiles.length}): `);
            const profileIdx = parseInt(profileChoice);
            if (profileIdx > 0 && profileIdx <= profiles.length) {
                selectedProfile = getProfile(profiles[profileIdx - 1].key);
                printSuccess(`Selected: ${selectedProfile.name}`);
            } else {
                printInfo('Using auto-detect mode');
            }
        }

        const connected = await connectToDevice(rl, portPath, selectedProfile);
        if (!connected) { rl.close(); return; }

        let running = true;
        while (running) {
            printMenu();
            const choice = await ask(rl, '  Select option: ');

            if (choice === '0') {
                running = false;
                continue;
            }

            await handleMenuChoice(rl, choice);

            if (choice !== '13') {
                console.log();
                await ask(rl, '  Press Enter to continue...');
            }
        }

        printSeparator('Disconnecting');
        console.log(`  ${C.dim}Closing connection...${C.reset}`);
        await elm327.disconnect();
        printSuccess('Disconnected successfully');
        console.log(`\n  ${C.cyan}Goodbye! 👋${C.reset}\n`);

    } catch (err) {
        printError(`Unexpected error: ${err.message}`);
    } finally {
        try { await elm327.disconnect(); } catch { /* ignore */ }
        rl.close();
    }
}
