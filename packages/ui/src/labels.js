/**
 * Display metadata for live-data fields: Spanish label, gauge range and
 * whether the field belongs on the compact dashboard ("tablero").
 * Field names come from @obdii/core (ecu-profiles.js / obd2-commands.js).
 */
export const FIELD_META = {
    // KWP2000 SIM2K-33 block 2101
    'Engine RPM': { label: 'RPM del motor', min: 0, max: 7000, dash: true },
    'Target Idle RPM': { label: 'RPM objetivo de ralentí', min: 0, max: 2000 },
    'Engine State': { label: 'Estado del motor', dash: true },
    'Throttle Position': { label: 'Acelerador', min: 0, max: 100, dash: true },
    'Intake Manifold Pressure (MAP)': { label: 'Presión del colector (MAP)', min: 0, max: 105, dash: true },
    'Battery Voltage (ECU)': { label: 'Batería (ECU)', min: 10, max: 16, dash: true },
    'Coolant Temp': { label: 'Temperatura del refrigerante', min: 0, max: 120, dash: true, warnAbove: 105 },
    'Vehicle Speed (ECU)': { label: 'Velocidad (ECU)', min: 0, max: 160, dash: true },
    'O2 Sensor B1S1': { label: 'Sensor O2 B1S1', min: 0, max: 1000 },
    'Short-Term Fuel Trim (lambda ctrl)': { label: 'Corrección de mezcla corta', min: -25, max: 25 },
    'Injection Pulse': { label: 'Pulso de inyección', min: 0, max: 10 },
    'Injection per cyl. (×4µs)': { label: 'Inyección por cilindro' },
    'Intake Air Temp': { label: 'Temp. aire de admisión', min: -10, max: 90, dash: true },
    'Engine Load / air charge (raw)': { label: 'Carga / llenado de aire (crudo)' },
    'Ignition-related (raw)': { label: 'Encendido (crudo)' },
    'Per-cylinder value (raw)': { label: 'Valor por cilindro (crudo)' },
    'Idle control? (raw)': { label: '¿Control de ralentí? (crudo)' },
    // Standard OBD2 PIDs
    'Vehicle Speed': { label: 'Velocidad', min: 0, max: 160, dash: true },
    'Engine Load': { label: 'Carga del motor', min: 0, max: 100, dash: true },
    'Coolant Temperature': { label: 'Temperatura del refrigerante', min: 0, max: 120, dash: true, warnAbove: 105 },
    'Intake Air Temperature': { label: 'Temp. aire de admisión', min: -10, max: 80 },
    'Intake Manifold Pressure': { label: 'Presión del colector (MAP)', min: 0, max: 105, dash: true },
    'Battery Voltage (ELM327)': { label: 'Batería (ELM327)', min: 10, max: 16, dash: true },
    'Fuel Tank Level': { label: 'Nivel de combustible', min: 0, max: 100, dash: true },
    'Timing Advance': { label: 'Avance de encendido', min: -10, max: 50 },
    'Engine Run Time': { label: 'Tiempo de marcha' },
    'MAF Air Flow Rate': { label: 'Caudal de aire (MAF)', min: 0, max: 100 },
};

export const meta = (name) => FIELD_META[name] || { label: name };
