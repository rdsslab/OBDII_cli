export const dtcDatabase = {
    // Generics - Powertrain
    "P0102": {
        "description": "Mass or Volume Air Flow Circuit Low Input",
        "explanation": "El sensor MAF está enviando un voltaje menor al esperado por la ECU.",
        "causes": ["Sensor MAF sucio", "Fugas de aire en la admisión", "Cableado defectuoso del MAF"],
        "solutions": ["Limpiar el sensor MAF con spray especializado", "Revisar fugas en las mangueras de admisión", "Verificar continuidad de los cables"],
        "risks": "Pérdida de potencia, mayor consumo de combustible, jaloneos."
    },
    "P0113": {
        "description": "Intake Air Temperature Circuit High Input",
        "explanation": "El sensor IAT registra un voltaje alto (normalmente indica baja temperatura extrema o circuito abierto).",
        "causes": ["Sensor IAT dañado", "Cable desconectado", "Cables en cortocircuito"],
        "solutions": ["Reconectar el sensor", "Medir la resistencia del sensor IAT", "Cambiar el sensor si está fuera de rango"],
        "risks": "Mezcla de combustible rica, aumento de emisiones, encendido difícil."
    },
    "P0133": {
        "description": "Oxygen Sensor Circuit Slow Response (Bank 1 Sensor 1)",
        "explanation": "El sensor de oxígeno primario está reaccionando muy lento a los cambios de la mezcla aire/combustible.",
        "causes": ["Sensor de oxígeno envejecido o contaminado", "Fuga en el escape cerca del sensor", "Cables del sensor dañados"],
        "solutions": ["Inspeccionar visualmente el sensor", "Revisar fugas de escape", "Reemplazar el sensor de oxígeno"],
        "risks": "Mayor consumo de gasolina, posible daño al catalizador a largo plazo."
    },
    "P0171": {
        "description": "System Too Lean (Bank 1)",
        "explanation": "El motor está funcionando con demasiado aire y muy poco combustible (mezcla pobre).",
        "causes": ["Fuga de vacío severa", "Bomba de combustible débil", "Filtro de combustible obstruido", "Inyectores sucios", "Sensor MAF defectuoso"],
        "solutions": ["Hacer prueba de humo para buscar fugas de vacío", "Medir presión de combustible", "Limpiar sensor MAF", "Limpiar inyectores"],
        "risks": "Sobrecalentamiento del motor, daño en válvulas y pistones si se ignora mucho tiempo."
    },
    "P0300": {
        "description": "Random/Multiple Cylinder Misfire Detected",
        "explanation": "La ECU detecta fallos de encendido (misfire) en varios cilindros, no solo en uno.",
        "causes": ["Bujías desgastadas", "Cables de bujías o bobinas defectuosas", "Baja presión de combustible", "Fugas de vacío"],
        "solutions": ["Revisar estado de bujías y cambiarlas si es necesario", "Revisar bobinas de encendido", "Verificar inyectores"],
        "risks": "Destrucción del convertidor catalítico (catalizador) en poco tiempo, pérdida drástica de potencia."
    },
    "P0340": {
        "description": "Camshaft Position Sensor 'A' Circuit",
        "explanation": "La ECU no recibe la señal correcta del sensor de posición del árbol de levas.",
        "causes": ["Sensor del árbol de levas dañado", "Cableado en mal estado", "Batería baja o problemas en el motor de arranque"],
        "solutions": ["Comprobar conexión del sensor", "Probar el sensor con osciloscopio o multímetro", "Sustituir sensor"],
        "risks": "El vehículo puede no encender o apagarse de repente mientras se conduce."
    },
    "P0420": {
        "description": "Catalyst System Efficiency Below Threshold (Bank 1)",
        "explanation": "El convertidor catalítico no está funcionando de manera eficiente, no purifica bien los gases.",
        "causes": ["Convertidor catalítico dañado/fundido", "Sensor de oxígeno secundario (Sensor 2) defectuoso", "Fugas de escape"],
        "solutions": ["Diagnosticar el sensor de oxígeno trasero", "Revisar fugas en el tubo de escape", "Cambiar el convertidor catalítico"],
        "risks": "No pasará la inspección de emisiones vehiculares, posible pérdida de potencia si el catalizador está tapado."
    },
    "P0500": {
        "description": "Vehicle Speed Sensor 'A' Malfunction",
        "explanation": "La ECU no está leyendo la velocidad del vehículo.",
        "causes": ["Sensor de velocidad (VSS) defectuoso", "Cables rotos o en corto", "Engranaje del sensor desgastado"],
        "solutions": ["Revisar cableado del VSS", "Comprobar señal del sensor girando las ruedas", "Reemplazar VSS"],
        "risks": "El velocímetro no funcionará, el control de crucero fallará y la transmisión automática puede tener cambios bruscos."
    },
    "P0505": {
        "description": "Idle Control System Malfunction",
        "explanation": "La ECU detecta un problema con el sistema de control de marcha mínima (ralentí).",
        "causes": ["Válvula IAC sucia o defectuosa", "Fuga de vacío en el múltiple de admisión", "Cuerpo de aceleración obstruido"],
        "solutions": ["Limpiar la válvula IAC y el cuerpo de aceleración", "Verificar posibles fugas de vacío", "Sustituir válvula IAC"],
        "risks": "El motor puede apagarse en ralentí, o mantener las RPM muy altas o inestables."
    },
    "P0507": {
        "description": "Idle Air Control System RPM Higher Than Expected",
        "explanation": "El motor está girando a más revoluciones de las que debería en ralentí (cuando no estás acelerando).",
        "causes": ["Fuga de vacío grande", "Válvula IAC atascada abierta", "Cuerpo de aceleración defectuoso o mal calibrado"],
        "solutions": ["Realizar prueba de humo para buscar fugas de vacío", "Limpiar o reemplazar válvula IAC", "Recalibrar cuerpo de aceleración"],
        "risks": "Consumo excesivo de combustible, dificultad para frenar en vehículos automáticos."
    },
    "P0101": {
        "description": "Mass or Volume Air Flow Circuit Range/Performance",
        "explanation": "El sensor MAF está enviando señales inconsistentes o fuera del rango esperado según otras lecturas del motor.",
        "causes": ["Sensor MAF muy sucio", "Fugas de aire después del sensor MAF", "Filtro de aire tapado"],
        "solutions": ["Limpiar sensor MAF", "Cambiar filtro de aire", "Revisar hermeticidad de las mangueras de admisión"],
        "risks": "Pérdida de potencia al acelerar, humo negro por el escape, alto consumo."
    },
    "P0118": {
        "description": "Engine Coolant Temperature Sensor 1 Circuit High",
        "explanation": "La señal del sensor de temperatura del refrigerante (ECT) es demasiado alta, usualmente indica baja temperatura extrema por circuito abierto.",
        "causes": ["Sensor ECT dañado", "Conector suelto o corroído", "Cables del sensor cortados"],
        "solutions": ["Reconectar el conector", "Medir voltaje de referencia y tierra en el conector", "Sustituir sensor ECT"],
        "risks": "Ventiladores pueden quedarse encendidos todo el tiempo, consumo excesivo de gasolina (el motor cree que está frío)."
    },
    "P0122": {
        "description": "Throttle/Pedal Position Sensor/Switch 'A' Circuit Low",
        "explanation": "El sensor de posición del acelerador (TPS) está registrando un voltaje anormalmente bajo.",
        "causes": ["TPS defectuoso", "Cables en cortocircuito a tierra", "Cuerpo de aceleración dañado"],
        "solutions": ["Medir el voltaje del TPS con multímetro mientras se acelera", "Revisar cableado", "Sustituir el sensor TPS o cuerpo de aceleración"],
        "risks": "Aceleración irregular, jaloneos, o el vehículo no acelera al pisar el pedal."
    },
    "P0301": {
        "description": "Cylinder 1 Misfire Detected",
        "explanation": "Se detectó que el cilindro número 1 no está generando combustión (misfire).",
        "causes": ["Bujía o bobina del cilindro 1 defectuosa", "Inyector del cilindro 1 obstruido", "Baja compresión en ese cilindro"],
        "solutions": ["Intercambiar bobina con otro cilindro para ver si el fallo cambia de cilindro", "Cambiar bujía", "Revisar inyector y medir compresión"],
        "risks": "Daño grave al catalizador, vibración excesiva del motor."
    },
    "P0302": {
        "description": "Cylinder 2 Misfire Detected",
        "explanation": "Se detectó que el cilindro número 2 no está generando combustión.",
        "causes": ["Bujía o bobina del cilindro 2 defectuosa", "Inyector del cilindro 2 obstruido", "Baja compresión en el cilindro 2"],
        "solutions": ["Intercambiar bobina con otro cilindro", "Cambiar bujía", "Revisar inyector y medir compresión"],
        "risks": "Daño al convertidor catalítico, marcha muy inestable."
    },
    "P0303": {
        "description": "Cylinder 3 Misfire Detected",
        "explanation": "Fallo de encendido específico en el cilindro número 3.",
        "causes": ["Fallo en bobina, bujía, o cable de bujía del cilindro 3", "Inyector tapado", "Problema mecánico (válvulas)"],
        "solutions": ["Revisar chispa", "Probar el inyector", "Comprobar fugas de vacío cercanas al cilindro 3"],
        "risks": "El vehículo perderá fuerza considerablemente, catalizador en riesgo."
    },
    "P0304": {
        "description": "Cylinder 4 Misfire Detected",
        "explanation": "Fallo de encendido localizado en el cilindro número 4.",
        "causes": ["Bobina defectuosa en cilindro 4", "Bujía gastada o llena de aceite", "Problema de cableado en inyector 4"],
        "solutions": ["Inspeccionar si la bujía está empapada de aceite o refrigerante", "Cambiar componentes de encendido"],
        "risks": "Luz de Check Engine parpadeando, alto riesgo para el sistema de emisiones."
    },
    "P0400": {
        "description": "Exhaust Gas Recirculation Flow Malfunction",
        "explanation": "El sistema EGR (Recirculación de Gases de Escape) no está fluyendo la cantidad de gases esperada.",
        "causes": ["Válvula EGR atascada por carbón", "Tubos de EGR tapados", "Fuga en las mangueras de vacío del EGR"],
        "solutions": ["Desmontar y limpiar la válvula EGR y sus tuberías", "Verificar solenoides de vacío", "Sustituir válvula EGR"],
        "risks": "Aumento en las emisiones de NOx, cascabeleo (detonación) en el motor al acelerar."
    },
    "P0442": {
        "description": "Evaporative Emission System Leak Detected (Small Leak)",
        "explanation": "El sistema EVAP detectó una pequeña fuga de vapores de combustible hacia la atmósfera.",
        "causes": ["Tapón del tanque de gasolina suelto o empaque dañado", "Fuga pequeña en una manguera de vapor", "Válvula de purga defectuosa"],
        "solutions": ["Apretar o cambiar el tapón de gasolina", "Inspeccionar mangueras del sistema EVAP cerca del tanque y del motor", "Prueba de humo al sistema EVAP"],
        "risks": "Olor a gasolina, no pasará la verificación ambiental (emisiones)."
    },
    
    // SIM2K-33 / Wuling Common Specifics
    "P2101": {
        "description": "Throttle Actuator Control Motor Circuit Range/Performance",
        "explanation": "Problema con el motor de control del acelerador electrónico (cuerpo de aceleración).",
        "causes": ["Cuerpo de aceleración muy sucio", "Motor del actuador averiado", "Mala conexión en el cuerpo de aceleración"],
        "solutions": ["Limpiar el cuerpo de aceleración", "Verificar arnés y conectores", "Reemplazar cuerpo de aceleración y recalibrar"],
        "risks": "El motor puede entrar en modo de seguridad (Limp Mode), limitando la aceleración drásticamente."
    },
    "P0605": {
        "description": "Internal Control Module Read Only Memory (ROM) Error",
        "explanation": "Problema interno en la memoria de la ECU.",
        "causes": ["Fallo interno de la ECU", "Intento de reprogramación fallido", "Picos de voltaje o batería muy débil"],
        "solutions": ["Revisar voltaje de batería y tierras", "Intentar flashear la ECU nuevamente", "Reemplazar la ECU"],
        "risks": "El vehículo no encenderá o presentará fallas erráticas graves."
    },
    "P2331": {
        "description": "Ignition Coil 'K' Primary Control Circuit High",
        "explanation": "El circuito de control primario de la bobina de encendido 'K' tiene un voltaje más alto de lo normal.",
        "causes": ["Bobina de encendido en cortocircuito", "Cableado en corto hacia la batería", "Fallo en el controlador de la ECU"],
        "solutions": ["Revisar cableado de la bobina de encendido", "Medir resistencia de la bobina", "Sustituir bobina si está en corto"],
        "risks": "Fallo de encendido en el cilindro afectado, pérdida de potencia y posible daño al catalizador."
    }
};

export function generateHTMLReport(dtcs, dateStr) {
    let dtcCardsHTML = '';

    if (!dtcs || dtcs.length === 0) {
        dtcCardsHTML = `<div class="alert success">✅ No se detectaron códigos de error (DTCs) en este escaneo.</div>`;
    } else {
        dtcs.forEach(dtc => {
            // dtc comes as "P0340 [current, active]", extract just the base code (P0340)
            const baseCodeMatch = dtc.match(/^[PBUC]\d{4}/);
            const baseCode = baseCodeMatch ? baseCodeMatch[0] : dtc;
            const statusMatch = dtc.replace(baseCode, '').trim();
            const statusDisplay = statusMatch ? `<span style="font-size: 0.6em; color: var(--gray); font-weight: normal;">${statusMatch}</span>` : '';

            const info = dtcDatabase[baseCode];
            if (info) {
                dtcCardsHTML += `
                <div class="dtc-card">
                    <div class="dtc-header">
                        <h2>${baseCode} ${statusDisplay}</h2>
                        <span class="badge">${info.description}</span>
                    </div>
                    <div class="dtc-body">
                        <p><strong><i class="icon">📖</i> Explicación:</strong> ${info.explanation}</p>
                        
                        <div class="section-title"><i class="icon">🔍</i> Motivos Más Comunes:</div>
                        <ul>
                            ${info.causes.map(c => `<li>${c}</li>`).join('')}
                        </ul>
                        
                        <div class="section-title"><i class="icon">🔧</i> Soluciones Paso a Paso:</div>
                        <ol>
                            ${info.solutions.map(s => `<li>${s}</li>`).join('')}
                        </ol>
                        
                        <div class="warning-box">
                            <strong><i class="icon">⚠️</i> Posibles problemas si no se soluciona:</strong><br>
                            ${info.risks}
                        </div>
                    </div>
                </div>`;
            } else {
                dtcCardsHTML += `
                <div class="dtc-card">
                    <div class="dtc-header">
                        <h2>${baseCode} ${statusDisplay}</h2>
                        <span class="badge unknown">Desconocido</span>
                    </div>
                    <div class="dtc-body">
                        <div class="alert warning">
                            ⚠️ Este código no se encuentra en la base de datos local. 
                            Te sugerimos buscarlo en internet para obtener más detalles de diagnóstico.
                            <br><br>
                            <a href="https://www.obd-codes.com/${baseCode}" target="_blank" style="color: #0066cc;">Buscar ${baseCode} en OBD-Codes.com</a>
                        </div>
                    </div>
                </div>`;
            }
        });
    }

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reporte de Diagnóstico OBD2</title>
    <style>
        :root {
            --primary: #2563eb;
            --primary-dark: #1d4ed8;
            --danger: #dc2626;
            --danger-bg: #fee2e2;
            --warning: #d97706;
            --warning-bg: #fef3c7;
            --success: #16a34a;
            --success-bg: #dcfce7;
            --dark: #1f2937;
            --gray: #4b5563;
            --light: #f3f4f6;
            --white: #ffffff;
            --border: #e5e7eb;
            --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            background-color: var(--light);
            color: var(--dark);
            line-height: 1.6;
            padding: 2rem;
        }

        .container {
            max-width: 900px;
            margin: 0 auto;
        }

        .header {
            background-color: var(--white);
            padding: 2rem;
            border-radius: 12px;
            box-shadow: var(--shadow);
            margin-bottom: 2rem;
            border-top: 5px solid var(--primary);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .header h1 {
            color: var(--dark);
            font-size: 1.8rem;
            margin-bottom: 0.5rem;
        }

        .header .meta {
            color: var(--gray);
            font-size: 0.95rem;
        }

        .dtc-card {
            background-color: var(--white);
            border-radius: 12px;
            box-shadow: var(--shadow);
            margin-bottom: 1.5rem;
            overflow: hidden;
            transition: transform 0.2s ease;
        }

        .dtc-card:hover {
            transform: translateY(-2px);
        }

        .dtc-header {
            background-color: var(--dark);
            color: var(--white);
            padding: 1.25rem 1.5rem;
            display: flex;
            align-items: center;
            gap: 1rem;
        }

        .dtc-header h2 {
            font-size: 1.5rem;
            letter-spacing: 1px;
            margin: 0;
            color: #ef4444; /* Rojo para los códigos */
        }

        .badge {
            background-color: rgba(255,255,255,0.1);
            padding: 0.25rem 0.75rem;
            border-radius: 9999px;
            font-size: 0.875rem;
            font-weight: 500;
        }
        
        .badge.unknown {
            background-color: var(--warning);
            color: white;
        }

        .dtc-body {
            padding: 1.5rem;
        }

        .section-title {
            font-weight: 600;
            margin: 1.25rem 0 0.5rem 0;
            color: var(--dark);
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        ul, ol {
            padding-left: 1.5rem;
            margin-bottom: 1rem;
            color: var(--gray);
        }

        li { margin-bottom: 0.25rem; }

        .warning-box {
            background-color: var(--danger-bg);
            border-left: 4px solid var(--danger);
            padding: 1rem;
            margin-top: 1.5rem;
            border-radius: 0 8px 8px 0;
            color: var(--danger);
        }

        .alert {
            padding: 1rem;
            border-radius: 8px;
            margin-bottom: 1rem;
        }

        .alert.warning {
            background-color: var(--warning-bg);
            border: 1px solid #fcd34d;
            color: #92400e;
        }
        
        .alert.success {
            background-color: var(--success-bg);
            border: 1px solid #86efac;
            color: #166534;
            font-weight: 600;
            text-align: center;
            padding: 2rem;
            font-size: 1.2rem;
        }

        .footer {
            text-align: center;
            margin-top: 3rem;
            color: var(--gray);
            font-size: 0.875rem;
        }
        
        @media (max-width: 600px) {
            body { padding: 1rem; }
            .header { flex-direction: column; align-items: flex-start; gap: 1rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>🚗 Reporte de Diagnóstico OBD2</h1>
                <div class="meta">Códigos de falla detectados en la unidad de control.</div>
            </div>
            <div style="text-align: right;">
                <strong>Fecha y Hora:</strong><br>
                ${dateStr}
            </div>
        </div>

        ${dtcCardsHTML}

        <div class="footer">
            Generado automáticamente por OBD2 ELM327 Bluetooth Scanner.
        </div>
    </div>
</body>
</html>`;
}
