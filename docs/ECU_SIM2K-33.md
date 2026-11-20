# ECU Siemens VDO SIM2K-33 (SAIC Wuling 2008): notas técnicas

Todo lo que se sabe de esta ECU a partir de pruebas reales con un ELM327 v1.5 (Bluetooth, COM6) y el perfil `SIM2K_33` de [ecu-profiles.js](../packages/core/src/ecu-profiles.js). Sirve para retomar la investigación y completar lo que falta.

- **Protocolo:** ISO 14230-4 KWP2000, fast init (`ATSP5`), cabecera `81 11 F1` (tester `F1` → ECU `11`).
- **Fecha de las pruebas:** 2026-11-19.
- **Leyenda de confianza:** ✔ verificado en el vehículo · ◐ probable (fuente externa o patrón) · ? desconocido.

---

## 1. Identificación (servicio `1A`)

La ECU publica su propio directorio en `1A 81`: entradas `[longitud][id][escala…]`, terminado en `FF`.

| ID | Nombre ISO 14230-3 / ISO 14229 | Contenido |
|---|---|---|
| 8A | System Supplier | sin programar (FF) |
| 8B | ECU Manufacturing Date | sin programar |
| 8C | ECU Serial Number | `KR77175201--` |
| 8D | Supported Functional Units | `KR77175112--` |
| 8E | Vehicle Manufacturer Kit Assembly Part Number | `W1102S52----` |
| 8F | (propio del fabricante) | `4C 00 09 00 4C 80 08 00` |
| 90 | VIN | `KMHDxxxDx1Uxxxxxx`: plantilla de VIN de Hyundai, no el VIN real |
| 91, 92, 98, 99 | HW number, supplier HW, taller, fecha de programación | sin programar |

`1A 80` devuelve la tabla completa concatenada (113 bytes). No hay respuesta para 86, 87, 88, 9B, 9C ni 97.

> Los textos de 8C/8D/8E (`KR77175201`, `KR77175112`, `W1102S52`) son la mejor pista para buscar la calibración exacta. El uso real de cada ID depende del fabricante.

---

## 2. Servicios soportados

### Lectura
| Servicio | Resultado |
|---|---|
| `10 81` sesión estándar | ✔ única sesión útil para leer datos |
| `10 85` | ✔ aceptada, pero es **modo programación**: luego `21 xx` responde NRC `80`. Retirada del perfil. |
| `10 89` | NRC `22` |
| `18 00 FF 00` / `18 02 FF 00` | ✔ DTCs con estado (KWP statusOfDTC) |
| `13`, `17` | NRC `11` / `12`: no soportados |
| `21 01`, `21 02` | ✔ bloques de 78 bytes de datos (ver [ecu-profiles.js](../packages/core/src/ecu-profiles.js)) |
| `21 F0` | existe; NRC `22` en sesión 81, NRC `80` en sesión 85 |
| `21 03` y demás `21 xx` | NRC `12` |
| `12` (freeze frame) | todos los formatos probados → NRC `12` / `79` / `11` |
| `22` | NRC `11` |
| OBD2 modo `01`/`03`/`07`/`0A` | no responde (`UNABLE TO CONNECT`, rechazado en la sesión KWP) |

### Escritura
Probado enviando **solo el byte de servicio**, sin parámetros, con el motor apagado.

| Servicio | Respuesta | Conclusión |
|---|---|---|
| `3D` writeMemoryByAddress | `79` | existe en la sesión 81 |
| `30` inputOutputControlByLocalIdentifier | `12` | existe en la sesión 81 (ver §3) |
| `31` startRoutineByLocalIdentifier | `22` | existe; pide condiciones o desbloqueo |
| `27` securityAccess | `79` | existe |
| `3B` writeDataByLocalIdentifier | `80` | existe solo en otra sesión |
| `34` / `36` / `37` download / transfer | `80` | existen solo en sesión de programación (flash) |
| `2E`, `2F`, `32`, `33`, `35` | `11` | no soportados |
| `14` (borrar DTC), `11` (reset ECU) | — | **no probados** a propósito |

Esta ECU usa el NRC `79` donde se esperaría `13` (longitud incorrecta).

> ⚠ No intentar escrituras (`3D`, `3B`, flash) sin documentación del fabricante. Una clave incorrecta en `27` suele bloquear los intentos por un tiempo.

---

## 3. Actuadores (servicio `30`, inputOutputControlByLocalIdentifier)

### Cómo se obtuvo
- Barrido `30 <id> 01` para los 256 IDs. `01` = reportCurrentState: solo lee, no activa nada. Motor apagado, contacto en ON.
- 227 IDs → NRC `31` (fuera de rango). **29 IDs existen.**
- Después se envió `30 <id> 00` (returnControlToECU) a cada uno: la mayoría responde NRC `31` (no estaban bajo control externo), y `8F` y `A0` lo aceptaron.
- Los parámetros ISO `02` (condiciones), `03` (escala) y `09` (calibración) → NRC `12` en todos. La ECU no implementa esos modos de consulta, lo cual no dice nada sobre la existencia del actuador.

### Tabla
La columna "Función probable" viene de un mapa **no verificado** de una ECU hermana de la familia Siemens VDO (**SIMK43**). Según quien lo encontró, coincide con 24 de estos 29 IDs. La fuente original de esa tabla no se ha revisado directamente.

| ID | Estado leído (01) | Función probable (SIMK43) | Confianza | Notas / contradicciones con este vehículo |
|---|---|---|---|---|
| 10 | 00 | Lámpara MIL (check engine) | ◐ | Con P1535 activo la MIL debería estar pedida; vale la pena leer 10 con el motor en marcha. |
| 11 | 00 | Válvula de purga/cierre del canister EVAP | ◐ | |
| 12 | 00 | Relé de bomba de combustible | ◐ | Leerlo en los ~2 s posteriores a dar contacto (cebado de la bomba). |
| 13 | 00 | Relé del compresor del A/C | ◐ | **Este auto no tiene A/C.** Que exista refuerza la hipótesis de que la ECU está configurada para la versión con A/C (ver P1535). No se puede verificar con el panel del A/C. |
| 14 | 00 | Control de bomba de combustible | ◐ | |
| 1A | 00 | Electroventilador, velocidad alta | ◐ | Leer con el motor caliente cuando entre el ventilador. |
| 1B | 00 | Electroventilador, velocidad baja | ◐ | Ídem. |
| 1C | 00 | Relé principal (main relay) | ◐ (baja) | **Contradicción:** con el contacto en ON un relé principal debería estar activo, pero se leyó 00. |
| 23 | 00 | ? | ? | |
| 30 | 00 | Corte de combustible (4 cilindros) | ◐ | No es un relé. |
| 31 | 00 | Bobina cilindros 1 y 4 (chispa perdida) | ◐ | Coherente con un 4 cilindros. **No activar.** |
| 32 | 00 | Bobina cilindros 2 y 3 (chispa perdida) | ◐ | **No activar.** |
| 40 | 00 | Configuración: transmisión automática | ◐ | No es actuador. **No activar.** |
| 41 | 00 | Configuración: control de tracción | ◐ | No es actuador. **No activar.** |
| 42 | **01** | ? (en SIMK43 también "?") | ? | Activo con el contacto en ON; posiblemente un indicador o configuración. **No activar.** |
| 61–64 | 00 | no aparece en SIMK43 | ? | El patrón de 4 sugiere inyectores 1–4. **No activar.** |
| 69 | 00 | ? | ? | |
| 71–74 | **80** | ? (también desconocidos en SIMK43) | ? | 4 IDs con 0x80: probablemente un indicador de estado por cilindro. **No activar.** |
| 79, 7A | 00 | ? (existen en SIMK43) | ? | |
| 8F | 00 | ? | ? | Acepta returnControlToECU. |
| 91 | NRC `22` | ? | ? | Existe, pero pide otras condiciones (¿motor en marcha?); encaja más con una rutina o monitor. |
| A0 | 00 | ? (existe en SIMK43) | ? | Acepta returnControlToECU. |

### Plan para confirmarlos sin forzar salidas
Usar solo `30 <id> 01` (leer estado) mientras el vehículo hace algo observable:

1. **12 / 14 (bomba):** abrir el registro, dar contacto y leer cada ~0.3 s durante los primeros 3 s.
2. **1A / 1B (ventilador):** motor caliente al ralentí; leer cuando el ventilador arranque y pare.
3. **1C (relé principal):** comparar la lectura con el contacto OFF→ON. Si nunca cambia, descartar la hipótesis.
4. **10 (MIL):** leer con el motor en marcha y con P1535 activo.
5. **61–64 / 31–32 / 71–74:** **no activar.** Identificar cilindros con lámpara noid u osciloscopio en los inyectores, y probador de chispa en las bobinas, **durante el arranque**.
6. **91:** probar `30 91 01` con el motor en marcha.

Activar salidas (parámetros `05`/`06`/`07`/`08`) queda pendiente hasta conocer los valores de control del fabricante. Si se hace, siempre con el motor apagado, una salida a la vez, alguien observando y `30 <id> 00` justo después.

---

## 4. Datos en vivo: lo que falta

Detalle de cada campo y su calibración: [ecu-profiles.js](../packages/core/src/ecu-profiles.js).

- **Velocidad del vehículo** (`2101`, byte de datos 18): la relación con las marchas encaja, pero lee menos que el velocímetro y salta de forma errática, en línea con **P0501**. Escala sin confirmar.
- **Nivel de combustible:** no aparece en `2101`/`2102` y no hay OBD2. Comparar los bytes crudos del CSV de la opción 20 antes y después de cargar combustible.
- **Corrección de mezcla, inyección, valores por cilindro, temperatura del aire de admisión:** escalas sin confirmar.
- **Bloque `2102`:** casi todo en cero; solo hay valores crudos en los bytes 54–57.

---

## 5. DTCs observados y relación con lo anterior

| DTC | Significado (tabla GM-Wuling) | Estado |
|---|---|---|
| P1535 | Sensor de temperatura del evaporador del A/C, circuito alto (abierto / a +12 V) | presente, MIL encendida. El vehículo **no tiene A/C**: circuito inexistente = abierto. Coincide con que exista el actuador 13 (relé del A/C). |
| P0501 | Sensor de velocidad del vehículo, rango/funcionamiento | memorizado; señal de velocidad errática en los datos en vivo |
| P0335 | Sensor de posición del cigüeñal, circuito | memorizado |

Fuente de P1535/P1536/P1545: tabla Wuling "五菱汽车故障码大全" (360doc), citada en [dtc-database.js](../packages/core/src/dtc-database.js).

---

## 6. Pendientes de investigación

- [ ] Conseguir la lista oficial de pruebas de actuadores del SIM2K-33 Wuling (escáner de taller o manual de servicio) y completar la tabla §3.
- [ ] Ubicar la fuente original de la tabla SIMK43 y revisarla directamente.
- [ ] Buscar la calibración por `KR77175201` / `KR77175112` / `W1102S52`.
- [ ] Ejecutar el plan de confirmación §3 (solo lectura).
- [ ] Fijar la escala de la velocidad: opción 20 con CSV a velocidad constante, anotando el velocímetro.
- [ ] Nivel de combustible: CSV antes y después de cargar.
- [ ] Probar el servicio `21 F0` en otras condiciones (¿motor en marcha?).
