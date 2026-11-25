/**
 * Display metadata for live-data fields: label in both UI languages, gauge
 * range and whether the field belongs on the compact dashboard ("tablero").
 * Field names come from @obdii/core (ecu-profiles.js / obd2-commands.js).
 * Ranges are defaults; users can override them in Ajustes → Sensores.
 */
import { getLang } from './i18n.js';

export const FIELD_META = {
    // KWP2000 SIM2K-33 block 2101
    'Engine RPM': { label: 'RPM del motor', en: 'Engine RPM', min: 0, max: 7000, dash: true },
    'Target Idle RPM': { label: 'RPM objetivo de ralentí', en: 'Target idle RPM', min: 0, max: 2000 },
    'Engine State': { label: 'Estado del motor', en: 'Engine state', dash: true },
    'Throttle Position': { label: 'Acelerador', en: 'Throttle position', min: 0, max: 100, dash: true },
    'Intake Manifold Pressure (MAP)': { label: 'Presión del colector (MAP)', en: 'Manifold pressure (MAP)', min: 0, max: 105, dash: true },
    'Battery Voltage (ECU)': { label: 'Batería (ECU)', en: 'Battery (ECU)', min: 10, max: 16, dash: true },
    'Coolant Temp': { label: 'Temperatura del refrigerante', en: 'Coolant temperature', min: 0, max: 120, dash: true, warnAbove: 105 },
    'Vehicle Speed (ECU)': { label: 'Velocidad (ECU)', en: 'Speed (ECU)', min: 0, max: 150, dash: true },
    'O2 Sensor B1S1': { label: 'Sensor O2 B1S1', en: 'O2 sensor B1S1', min: 0, max: 1000 },
    'Short-Term Fuel Trim (lambda ctrl)': { label: 'Corrección de mezcla corta', en: 'Short-term fuel trim', min: -25, max: 25 },
    'Injection Pulse': { label: 'Pulso de inyección', en: 'Injection pulse', min: 0, max: 10 },
    'Injection per cyl. (×4µs)': { label: 'Inyección por cilindro', en: 'Injection per cylinder' },
    'Intake Air Temp': { label: 'Temp. aire de admisión', en: 'Intake air temperature', min: -10, max: 90, dash: true },
    'Engine Load / air charge (raw)': { label: 'Carga / llenado de aire (crudo)', en: 'Load / air charge (raw)' },
    'Ignition-related (raw)': { label: 'Encendido (crudo)', en: 'Ignition-related (raw)' },
    'Per-cylinder value (raw)': { label: 'Valor por cilindro (crudo)', en: 'Per-cylinder value (raw)' },
    'Idle control? (raw)': { label: '¿Control de ralentí? (crudo)', en: 'Idle control? (raw)' },
    // Standard OBD2 PIDs
    'Vehicle Speed': { label: 'Velocidad', en: 'Speed', min: 0, max: 150, dash: true },
    'Engine Load': { label: 'Carga del motor', en: 'Engine load', min: 0, max: 100, dash: true },
    'Coolant Temperature': { label: 'Temperatura del refrigerante', en: 'Coolant temperature', min: 0, max: 120, dash: true, warnAbove: 105 },
    'Intake Air Temperature': { label: 'Temp. aire de admisión', en: 'Intake air temperature', min: -10, max: 80 },
    'Intake Manifold Pressure': { label: 'Presión del colector (MAP)', en: 'Manifold pressure (MAP)', min: 0, max: 105, dash: true },
    'Battery Voltage (ELM327)': { label: 'Batería (ELM327)', en: 'Battery (ELM327)', min: 10, max: 16, dash: true },
    'Fuel Tank Level': { label: 'Nivel de combustible', en: 'Fuel tank level', min: 0, max: 100, dash: true },
    'Timing Advance': { label: 'Avance de encendido', en: 'Timing advance', min: -10, max: 50 },
    'Engine Run Time': { label: 'Tiempo de marcha', en: 'Engine run time' },
    'MAF Air Flow Rate': { label: 'Caudal de aire (MAF)', en: 'MAF air flow rate', min: 0, max: 100 },
};

/** Metadata with the label in the active UI language. */
export const meta = (name, lang = getLang()) => {
    const m = FIELD_META[name] || { label: name };
    return lang === 'en' && m.en ? { ...m, label: m.en } : m;
};

export const sensorLabel = (name, lang = getLang()) => meta(name, lang).label || name;
