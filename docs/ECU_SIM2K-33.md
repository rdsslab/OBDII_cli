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
| `14 FF 00` clearDiagnosticInformation | `54 FF 00` | ✔ **probado el 2026-11-20** con el motor apagado y el contacto en ON, en la sesión `81`. La lista quedó vacía de inmediato (ver §5) |
| `11` (reset ECU) | — | **no probado** a propósito |

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

- **Velocidad del vehículo** (`2101`, byte de datos 18): **confirmada con GPS** (2026-11-20, calibración desde la PWA del teléfono, 15–40 km/h). Es 1 km/h por unidad: a velocidad estable, GPS / ECU = 0.97–1.04 (≈ 1.00), y es el byte del bloque que mejor sigue al GPS (r = 0.84 con picos incluidos).
  - El **velocímetro del tablero marca de más** (la nota anterior, tablero ~20/40/60 frente a ECU ~15/35/40, se explica así; la ECU coincide con el GPS).
  - La ECU va ~0.5–1 s detrás del GPS y marca 0 por debajo de ~4 km/h.
  - **Picos (P0501):** ~1 de cada 25 lecturas salta hacia arriba a 1.4–2× durante ~1 s (por ejemplo, GPS 37.5 → ECU 71 → 35), siempre entre 20 y 40 km/h y nunca hacia abajo. Es el patrón de pulsos extra del sensor de velocidad (ruido, conector o masa, rueda dentada). `SpeedSpikeFilter` los oculta solo en pantalla y alertas (una subida mayor que 5 km/h por segundo + 3 km/h se mantiene en el último valor bueno, hasta 3 s). Las grabaciones guardan el valor que envió la ECU con cada pico, el valor mostrado y una marca de pico, para seguir el fallo del sensor.
  - Pendiente: confirmar la linealidad por encima de 40 km/h.
- **Nivel de combustible:** no aparece en `2101`/`2102` y no hay OBD2. Comparar los bytes crudos del CSV de la opción 20 antes y después de cargar combustible.
- **Corrección de mezcla, inyección, valores por cilindro:** escalas sin confirmar.
- **Temperaturas en frío (2026-11-20, 06:15, ~14 h estacionado, a 2333 m de altitud):**

  | Fuente | Valor |
  |---|---|
  | Aire exterior (Open-Meteo, 2333 m) | 14.0 °C (mínima de la noche 13.8 °C) |
  | Refrigerante (byte 3) | 19.5 °C |
  | Aire de admisión (byte 5) | 22.5 °C |

  - **A las 07:04** (justo antes de arrancar): refrigerante 18.8 °C y admisión 21.8 °C, con el aire exterior a ~15 °C. El refrigerante **bajó** mientras el aire subía: el motor seguía soltando calor residual. La última conducción terminó a las 21:31 con 87 °C, ~8.7 h antes. El motor va bajo el asiento, expuesto al aire exterior.
  - **Calentamiento del 2026-11-20 no registrado:** al arrancar (07:04:27) la comunicación se cortó y la recuperación ligera (reabrir la sesión KWP) falló 63 veces hasta que se apagó el motor. Probablemente la caída de voltaje del arranque reinició el ELM327 o cortó el Bluetooth. El servidor ahora escala la recuperación: sesión → `ATZ` + configuración completa → reabrir el puerto, y deja las trazas TX/RX en el registro.
  - **Enfriamiento tras apagar** (ventilador a las 07:22:48, motor apagado ~07:23, contacto en ON):

    | Hora | Refrigerante | Admisión | Byte 2 (crudo) |
    |---|---|---|---|
    | 07:34:40 | 79.5 °C | 66.0 °C | 68 |
    | 07:35:20 | 78.8 °C | 66.0 °C | 68 |
    | 07:36:51 | 77.3 °C | 66.8 °C | 70 |
    | 07:38:23 | 76.5 °C | 67.5 °C | 71 |

    - **Constante de tiempo (ley de enfriamiento de Newton, aire a ~15.5 °C):** τ ≈ 72 min (rango 54–109).
    - **Calor residual a las 06:15:** con ese τ, tras 8.7 h quedarían < 1 °C. El refrigerante debería haber estado casi a la temperatura del aire (~14 °C), no a 19.5 °C.
    - **Indicio de desfase en frío:** el sensor (o la fórmula) leería **~+3 a +5 °C** con el motor frío. Matiz: el enfriamiento real se frena cuando la diferencia es pequeña (convección natural, varias masas), y entre 06:15 y 07:04 el refrigerante bajó mientras el aire subía, así que algo de calor residual quedaba. No se corrige aún.
    - **Al entrar el ventilador**, extrapolando hacia atrás: ~87–95 °C. Coherente con un umbral típico de ventilador, pero sin precisión suficiente para calibrar el extremo caliente.
    - **El aire de admisión sube después de apagar** (66 → 67.5 °C): el colector absorbe calor del motor sin flujo de aire.
  - Los dos sensores leen por encima del aire exterior con un margen parecido: el compartimento del motor estaba más caliente que afuera. **No se recalibró el refrigerante**: restarle 5.5 °C dejaría el ralentí en caliente en ~81 °C, por debajo de la apertura normal del termostato.
  - **Aire de admisión corregido:** el byte 4 con `x − 40` daba 147 °C en frío. Siguiendo el mismo patrón que el refrigerante (byte 2 crudo / byte 3 temperatura), el byte 4 es el valor crudo del sensor y el **byte 5** la temperatura, con `0.75·x − 48`: 22.5 °C en frío y ~74 °C al ralentí en caliente (sensor en el colector, calentado). Sigue sin confirmar.
  - **Para confirmar:** termómetro en el compartimento del motor junto al sensor, en frío, o una lectura tras una noche con el auto a la intemperie.
- **MAP (bytes 13–14) pasa a "sin confirmar":** con el motor apagado marcó 93.6 kPa, pero la presión real en el lugar era **77.6 kPa** (Open-Meteo, superficie a 2333 m). La comprobación anterior ("93.8 kPa = presión atmosférica") suponía nivel del mar.
  - El valor se comporta como un MAP (ralentí ~24–38, desaceleración ~18, techo ~92–93 con poca carga), pero `raw/100` no son kPa absolutos.
  - Ninguna corrección simple encaja: escalar ×0.83 deja el ralentí en ~20 kPa (bajo para esta altura, se esperan ~30–37) y restar una cantidad fija lo deja en ~8 kPa.
  - **Segundo punto, motor caliente y apagado (07:35):** raw 9395 → 94.0, con presión real ~77.9 kPa. Misma relación que en frío (×0.83; diferencia ~16 kPa): la lectura es estable y no depende de la temperatura, pero dos puntos tan cercanos no distinguen entre escala y desfase.
  - **Próximo paso:** registro CSV con motor apagado → ralentí → acelerador a fondo, comparando con los 77–78 kPa conocidos.
- **Bloque `2102`:** casi todo en cero; solo hay valores crudos en los bytes 54–57.

---

## 5. DTCs observados y relación con lo anterior

| DTC | Significado (tabla GM-Wuling) | Estado |
|---|---|---|
| P1535 | Sensor de temperatura del evaporador del A/C, circuito alto (abierto / a +12 V) | presente (`0xF1`), MIL encendida. El vehículo **no tiene A/C**: circuito inexistente = abierto. Coincide con que exista el actuador 13 (relé del A/C). |
| P0501 | Sensor de velocidad del vehículo, rango/funcionamiento | memorizado (`0x38`); señal de velocidad errática en los datos en vivo |
| P0335 | Sensor de posición del cigüeñal, circuito | memorizado (`0x34`) |

**Borrado del 2026-11-20 (~06:50):** con `14 FF 00` la ECU respondió `54 FF 00` y la lista quedó vacía. Con el motor apagado, P1535 **no reapareció** en 10, 30 ni 60 s. Copia previa: `dtc_before_clear_2026-11-20.json` y `dtc_report_before_clear_2026-11-20.html` (en la raíz, fuera de git).

- [x] ¿Vuelve P1535 con el motor en marcha? **Sí.** Tras ~18 min al ralentí (07:04–07:23), a las 07:34 estaba otra vez *presente, MIL encendida* (`0xE1`). Confirma que es permanente en este auto sin A/C.
- [ ] Ver si P0501 (velocidad) y P0335 (cigüeñal) vuelven a aparecer al conducir.

Fuente de P1535/P1536/P1545: tabla Wuling "五菱汽车故障码大全" (360doc), citada en [dtc-database.js](../packages/core/src/dtc-database.js).

---

## 6. Pendientes de investigación

- [ ] Conseguir la lista oficial de pruebas de actuadores del SIM2K-33 Wuling (escáner de taller o manual de servicio) y completar la tabla §3.
- [ ] Ubicar la fuente original de la tabla SIMK43 y revisarla directamente.
- [ ] Buscar la calibración por `KR77175201` / `KR77175112` / `W1102S52`.
- [ ] Ejecutar el plan de confirmación §3 (solo lectura).
- [x] Escala de la velocidad: 1 km/h por unidad, confirmada con GPS entre 15 y 40 km/h (2026-11-20).
- [ ] Calibración GPS a 60–90 km/h para confirmar la linealidad.
- [ ] Revisar el sensor de velocidad (conector, cableado, masa, rueda dentada): explica los picos y P0501.
- [ ] Nivel de combustible: CSV antes y después de cargar.
- [ ] Probar el servicio `21 F0` en otras condiciones (¿motor en marcha?).
