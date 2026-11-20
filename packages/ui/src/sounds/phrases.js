/**
 * Spoken alert phrases. The pre-recorded files in sounds/<lang>/<id>.wav
 * are generated from these texts (tools/generate-voices.mjs); the browser's
 * speech synthesis uses them too when a file is missing.
 */
export const PHRASES = {
    es: {
        overheat: 'Atención. Sobrecalentamiento del motor. Detén el vehículo en un lugar seguro.',
        noCharge: 'Atención. La batería no está cargando. Revisa el alternador.',
        overVoltage: 'Atención. Voltaje demasiado alto. Revisa el regulador del alternador.',
        lowBattery: 'Batería baja. Revisa si dejaste luces o accesorios encendidos.',
        ignitionOn: 'El contacto está encendido con el motor apagado. Esto descarga la batería.',
        linkLost: 'Se perdió la comunicación con el vehículo.',
        newDtc: 'La computadora del motor registró un código de error nuevo.',
        coldRev: 'Motor frío. Evita acelerar fuerte.',
        overRev: 'Revoluciones demasiado altas.',
        noWarmup: 'El motor no alcanza su temperatura normal. Podría ser el termostato.',
        fastHeat: 'Atención. La temperatura del motor sube demasiado rápido. Revisa el refrigerante.',
        test: 'Prueba de alertas. El sonido funciona correctamente.',
    },
    en: {
        overheat: 'Warning. Engine overheating. Stop the vehicle in a safe place.',
        noCharge: 'Warning. The battery is not charging. Check the alternator.',
        overVoltage: 'Warning. Voltage too high. Check the alternator regulator.',
        lowBattery: 'Low battery. Check for lights or accessories left on.',
        ignitionOn: 'The ignition is on with the engine off. This drains the battery.',
        linkLost: 'Connection with the vehicle was lost.',
        newDtc: 'The engine computer stored a new trouble code.',
        coldRev: 'Cold engine. Avoid hard acceleration.',
        overRev: 'Engine speed too high.',
        noWarmup: 'The engine is not reaching normal temperature. The thermostat may be stuck open.',
        fastHeat: 'Warning. Engine temperature is rising too fast. Check the coolant.',
        test: 'Alert test. Sound is working correctly.',
    },
};

/** Voice used to generate each language (Windows desktop voices). */
export const VOICES = { es: 'Microsoft Helena Desktop', en: 'Microsoft Zira Desktop' };
