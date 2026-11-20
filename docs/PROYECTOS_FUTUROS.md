# Proyectos a futuro: núcleo compartido y varias versiones

Plan para llevar la aplicación de consola actual a otras plataformas (servidor web en la laptop, PWA y app Android) sin rehacer el protocolo, que es la parte ya probada con el vehículo (ver [ECU_SIM2K-33.md](ECU_SIM2K-33.md)).

- **Estado:** pasos 1 (monorepo + núcleo + consola) y 2 (`obd-ui` + `obd-server`) implementados el 2026-11-20; el resto, pendiente.
- **Fecha:** 2026-11-20.

### Decisiones tomadas (2026-11-20)
- **Un solo repositorio** con proyectos separados (*npm workspaces*), paquetes con el prefijo `@obdii/`.
- **`obd-server`: aplicación web normal, no PWA.** Varios usuarios conectados a la vez desde la red local, por `http://`. No necesita HTTPS ni instalación.
- **`obd-pwa`: publicada en GitHub Pages** (HTTPS gratis), instalable desde Chrome.
- **`obd-android`: al final.** Android Studio se instala cuando se llegue a ese paso.

---

## 1. Idea general

Separar el código en un **núcleo (core)** independiente de la plataforma y en **proyectos de aplicación** que lo usan. Cada aplicación aporta solo dos cosas: cómo se conecta al ELM327 (el *transporte*) y cómo se muestra la información.

```
                        ┌──────────────────────────┐
                        │        obd-core          │
                        │  protocolo ELM327 / KWP  │
                        │  perfiles de ECU, DTCs   │
                        │  decodificación de datos │
                        └────────────┬─────────────┘
          ┌──────────────┬───────────┴──┬────────────────┐
          │              │              │                │
     ┌────┴────┐   ┌─────┴─────┐  ┌─────┴─────┐   ┌──────┴──────┐
     │ obd-cli │   │obd-server │  │  obd-pwa  │   │ obd-android │
     │ consola │   │ laptop +  │  │ Chrome +  │   │  Capacitor  │
     │ (actual)│   │ red local │  │Web Serial │   │  APK + BT   │
     └─────────┘   └─────┬─────┘  └─────┬─────┘   └──────┬──────┘
                         └──────────────┼────────────────┘
                                 ┌──────┴──────┐
                                 │   obd-ui    │
                                 │  interfaz   │
                                 │ web común   │
                                 └─────────────┘
```

| Proyecto | Qué contiene | Transporte al ELM327 |
|---|---|---|
| `obd-core` | `elm327.js`, `ecu-profiles.js`, `obd2-commands.js`, `dtc-database.js` | ninguno: recibe uno por parámetro |
| `obd-cli` | la consola actual (`index.js`), registro CSV | `serialport` (COM6) |
| `obd-server` | servidor HTTP + WebSocket en la laptop (aplicación web, no PWA) | `serialport` (COM6) |
| `obd-pwa` | la interfaz publicada en GitHub Pages, instalable | Web Serial (Chrome) |
| `obd-android` | la interfaz empaquetada como APK (teléfono y radio del auto) | plugin nativo Bluetooth SPP (y USB opcional) |
| `obd-ui` | pantallas web compartidas: DTCs, tablero en tiempo real, ECU, exportación | ninguno: habla con el core o con el servidor |
| `obd-esp32` | firmware + hardware propio conectado al OBD2, **sin ELM327**; sirve `obd-ui` por Wi-Fi | línea K directa (transceptor L9637D / SN65HVDA195), expuesta por WebSocket |
| `obd-esp32-elm327` | ESP32 como red Wi-Fi propia + servidor web con ingreso, conectado **al ELM327 por Bluetooth** ([firmware/esp32-elm327](../firmware/esp32-elm327/README.md), PlatformIO) | Bluetooth Classic SPP (solo ESP32 clásico) |

> El ELM327 Bluetooth acepta **una sola conexión a la vez**. Laptop, teléfono y radio no pueden conectarse al adaptador al mismo tiempo. Para ver los datos en varias pantallas, una se conecta y las demás usan `obd-server`.

---

## 2. Viabilidad: qué tan acoplado está el código hoy

Revisión del código actual (2026-11-20):

| Archivo | Dependencias de Node | Cambio necesario para el core |
|---|---|---|
| `bluetooth.js` | `serialport` | **Sale del core.** Pasa a ser el transporte Node de `obd-cli` / `obd-server`. |
| `elm327.js` | solo usa `port.on('data')`, `port.removeListener`, `port.write`, `port.isOpen` y `chunk.toString('utf8')`; imprime el debug con `console.log` | Recibir un transporte en vez de abrir el puerto, decodificar con `TextDecoder` y usar un logger inyectable. Cambios pequeños. |
| `ecu-profiles.js` | ninguna | se mueve tal cual |
| `obd2-commands.js` | ninguna | se mueve tal cual |
| `dtc-database.js` | ninguna (el reporte HTML se genera como texto) | se mueve tal cual |
| `index.js` | `readline`, `fs`, ANSI de terminal | se queda en `obd-cli` |

**Conclusión:** es muy viable. Solo `bluetooth.js` está atado a Node; el resto del núcleo ya es JavaScript puro (ES modules) que funciona en el navegador, en Node y dentro de Capacitor.

### Contrato del transporte
Lo mínimo que cada plataforma tiene que implementar:

```js
// Transporte: lo implementa cada aplicación.
{
  open(): Promise<void>,
  close(): Promise<void>,
  write(text: string): Promise<void>,   // el core envía 'ATRV\r', '2101\r', ...
  onData(cb: (chunk: Uint8Array | string) => void): void,
  offData(cb): void,
  onClose?(cb: () => void): void,       // si la plataforma avisa de desconexiones
  isOpen: boolean,
}
```

Implementaciones previstas:
- **Node:** `serialport`, para la consola y el servidor.
- **Web Serial:** `navigator.serial` + `port.readable` / `port.writable`, para la PWA.
- **Capacitor:** plugin Bluetooth serie (SPP); opcionalmente uno USB serie para un ELM327 USB en el radio.
- **Simulado:** respuestas grabadas de este vehículo, para pruebas sin el auto.
- **KWP crudo por WebSocket (`obd-esp32`):** un nivel por debajo de los comandos AT. El ESP32 recibe los bytes de datos de una petición (p. ej. `21 01`) y devuelve los bytes de la respuesta ya validada. El core necesita un modo "sin ELM" que omita los comandos AT y use directamente su manejo de tramas KWP (ver §4.6).

---

## 3. Organización de los repositorios

| Opción | Pros | Contras |
|---|---|---|
| **Monorepo con *npm workspaces*** (recomendada): un solo repositorio, una carpeta y un `package.json` por proyecto (`packages/core`, `apps/cli`, …) | Un cambio en el core se prueba de inmediato en todas las versiones; un solo historial y un solo lugar para la documentación de la ECU; sin publicar paquetes | El repositorio crece; Android Studio genera muchos archivos (se ignoran en `.gitignore`) |
| **Repositorios separados**, con el core publicado en npm o como dependencia git con etiquetas | Cada proyecto tiene su propio ritmo e historial; se puede compartir el core con terceros | Cada arreglo del protocolo obliga a publicar una versión del core y actualizarla en 4 proyectos; es fácil que queden versiones desalineadas |

Con un monorepo, los proyectos **siguen estando separados** (cada uno con sus dependencias, scripts y versión), pero el core se comparte sin pasos de publicación. Si más adelante conviene, `packages/core` se puede extraer a su propio repositorio sin cambiar código.

Estructura propuesta:
```
packages/
  core/          obd-core
  ui/            obd-ui (interfaz web común)
apps/
  cli/           obd-cli (la consola actual)
  server/        obd-server
  pwa/           obd-pwa
  android/       obd-android (Capacitor)
docs/
```

---

## 4. Las versiones: pros y contras

### 4.1 `obd-cli`: consola (actual)
Se mantiene como hoy, solo cambia la importación del core y del transporte. Sigue siendo la herramienta de investigación: barridos, depuración y registros CSV.

### 4.2 `obd-server`: servidor web en la laptop
La laptop se conecta al ELM327 y publica la interfaz en la red local (p. ej. `http://192.168.x.x:3000`). Los datos en tiempo real se leen una vez y se envían por WebSocket a todas las pantallas.

| Pros | Contras |
|---|---|
| Usa la conexión ya probada (COM6), sin riesgo para el protocolo | La laptop tiene que ir en el auto, encendida |
| Funciona en cualquier navegador: Android, iPhone, Firefox, el radio, una tablet | Necesita una red común: hotspot de la laptop o del teléfono |
| Varias pantallas a la vez | Cualquiera en la red podría borrar DTCs: hace falta un PIN para escrituras y modo solo lectura para los demás |
| CSV y reportes quedan en la laptop | Por `http://` no se instala como PWA; no hace falta, porque se decidió que sea una aplicación web normal |
| Se puede probar con el auto desde la laptop de desarrollo | Hay que definir quién tiene el control cuando varios piden comandos |

### 4.3 `obd-pwa`: app web instalable (Chrome Android con Web Serial)
La interfaz publicada en GitHub Pages (HTTPS) que se conecta directo al ELM327 emparejado en el teléfono.

| Pros | Contras |
|---|---|
| Sin laptop ni red: solo teléfono y adaptador | Requiere Chrome Android 137 o superior; el soporte Bluetooth de Web Serial en Android es reciente y está sin probar con este adaptador |
| Se instala desde Chrome, con ícono y modo sin conexión | No avisa bien de las desconexiones: hay que detectarlas por falta de respuesta |
| Se actualiza sola al publicar | No funciona en Firefox, iPhone ni dentro de otras apps (WebView) |
| La misma página funciona en Chrome de escritorio (Windows) | Si Chrome queda en segundo plano, la conexión y el registro se pueden cortar |

### 4.4 `obd-android`: APK con Capacitor (teléfono y radio del auto)
La misma interfaz empaquetada como app, con un plugin nativo de Bluetooth serie.

| Pros | Contras |
|---|---|
| Funciona en Android 7–8 en adelante, sin depender de Chrome: **la opción realista para el radio** | Hay que compilar con Android Studio e instalar el APK a mano |
| Conexión Bluetooth más estable y con aviso de desconexión | Las actualizaciones no son automáticas: cada cambio es un APK nuevo |
| Puede registrar con la pantalla apagada y reconectarse sola cuando el radio arranca | Un proyecto más con herramientas propias (Android SDK, Gradle) |
| Puede usar un ELM327 USB conectado al radio | |

**Antes de hacerla para el radio, revisar:**
- versión de Android del radio;
- si permite emparejar el ELM327 en Ajustes → Bluetooth (en algunos radios el Bluetooth solo sirve para el manos libres; si apps como Torque funcionan, esta también funcionará);
- resolución y orientación (p. ej. 1024×600 horizontal), que requieren un *modo tablero* con números grandes;
- si permite instalar APK fuera de Play Store.

### 4.5 `obd-ui`: interfaz común
Una sola interfaz web responsiva, compartida por `obd-server`, `obd-pwa` y `obd-android`.

Debe tener dos modos de conexión:
- **Directo:** usa `obd-core` con un transporte local (PWA, APK).
- **Remoto:** recibe los datos de `obd-server` por WebSocket.

Pantallas previstas:
- DTCs con su explicación;
- tablero en tiempo real;
- identificación de la ECU;
- exportación a CSV y reporte HTML;
- *modo tablero* para el radio.

Framework por decidir: JavaScript sin framework o Svelte.

### 4.6 `obd-esp32`: ESP32 conectado directo al OBD2 (sin ELM327)
Un ESP32 con un transceptor de línea K reemplaza al ELM327. Se conecta al conector OBD2, habla KWP2000 con la ECU y publica el dashboard por Wi-Fi.

Es viable porque esta ECU usa **línea K (ISO 14230)**, no CAN: una señal serie de un solo cable a 10400 baudios que el UART del ESP32 maneja.

#### Hardware

| Componente | Para qué | Costo aprox. |
|---|---|---|
| ESP32 (clásico o S3) | Wi-Fi, servidor web, UART para la línea K | US$5–10 |
| Transceptor de línea K: **L9637D**, MC33290 o SN65HVDA195 | Adapta la línea K (12 V, un solo cable) a los niveles lógicos | US$1–3 |
| Fuente reductora 12 V → 5 V / 3.3 V para uso automotriz | Alimentación desde el pin 16 | US$2–5 |
| Diodo TVS (p. ej. SMBJ24A), diodo contra polaridad invertida, fusible | Protección contra picos (arranque, alternador) | US$1 |
| Conector OBD2 macho | Conexión al auto | US$3–5 |
| Analizador lógico (para desarrollo) | Verificar tiempos y baudaje | US$10 |

**Pines del conector OBD2:** 7 = línea K · 4 y 5 = masa · 16 = +12 V de batería (siempre activo).

> ⚠ Nunca conectar un pin del ESP32 directo a la línea K: tiene 12 V. Siempre va el transceptor en medio.
>
> - El L9637D funciona a 5 V: su salida RX es de colector abierto y basta una *pull-up* a 3.3 V. Hay que confirmar en la hoja de datos que acepta 3.3 V en TX.
> - El SN65HVDA195 acepta lógica de 3.3 V directamente.

Para autos con CAN en el futuro: el ESP32 trae un controlador CAN (TWAI), así que basta añadir un transceptor SN65HVD230. Conviene dejar el espacio en la placa.

#### Firmware: lo que hoy hace el ELM327

1. **Inicio rápido (fast init):**
   - desconectar el UART del pin TX;
   - mantener la línea K en **bajo 25 ms y en alto 25 ms**, manejando el pin a mano;
   - reconectar el UART a 10400 baudios y enviar `StartCommunication` (`81 11 F1 81` + checksum).
2. **Eco:** la línea K es un solo cable; cada byte enviado vuelve por RX y hay que descartarlo.
3. **Tiempos ISO 14230:**
   - pausa entre bytes enviados (P4): ~5 ms;
   - espera de la respuesta de la ECU (P2): hasta 50 ms;
   - pausa entre la respuesta y la siguiente petición (P3): hasta 5 s;
   - mantener la sesión con `3E` antes de que se cumplan esos 5 s.
4. **Tramas:** cabecera `81 11 F1`, longitud y checksum. Es la misma lógica que `decodeKwpFrames()` en `elm327.js`.
5. **Lo aprendido con esta ECU** (ver [ECU_SIM2K-33.md](ECU_SIM2K-33.md)):
   - enviar `82` al terminar;
   - esperar ~6 s de silencio antes de reintentar cuando la ECU quedó con una sesión abierta;
   - usar la sesión `1081`, no `1085`.
6. **Wi-Fi en modo punto de acceso** (p. ej. red "OBD-Wuling"). La interfaz `obd-ui` va en la flash (LittleFS) y los datos en vivo se envían por WebSocket.

#### Dos formas de organizar el software

| | A. Todo dentro del ESP32 | B. ESP32 como puente (recomendada) |
|---|---|---|
| Qué hace el ESP32 | Protocolo completo + decodificación + DTCs + web | Solo la capa física: inicio, tramas, eco, tiempos y mantener la sesión. Expone "envía bytes, recibe respuesta" por WebSocket |
| Dónde se decodifica | C++ en el ESP32: hay que reescribir perfiles, sensores y base de DTCs | En el navegador, con `obd-core` (`ecu-profiles.js`, `dtc-database.js`) |
| Pros | Autónomo; puede registrar datos sin ningún dispositivo conectado | Reutiliza lo ya calibrado; firmware pequeño; corregir una fórmula no exige reprogramar el ESP32 |
| Contras | Dos implementaciones del protocolo (JS y C++) | Solo decodifica mientras haya un navegador abierto |

Con la opción B, el núcleo necesita un transporte "KWP crudo" además del de comandos AT (ver §2). Es un cambio acotado, porque `elm327.js` ya decodifica las tramas KWP por su cuenta desde que usa `ATH1`.

#### Pros y contras frente al ELM327

| Pros | Contras |
|---|---|
| Control total de los tiempos, sin los errores del clon (recorte con `ATH0`, `BUS INIT: ERROR`) | **Consumo de batería:** el pin 16 tiene corriente siempre. Hay que detectar el contacto (p. ej. voltaje > 13 V con el motor en marcha) y dormir el ESP32, o poner un interruptor. Si no, descarga la batería en días |
| Posiblemente más lecturas por segundo, sin la capa de comandos AT | Hardware propio: soldadura, caja y montaje en el auto |
| Dispositivo autónomo y fijo, con Wi-Fi para varias pantallas (teléfono, laptop, navegador del radio) | Solo autos con línea K, salvo que se añada el transceptor CAN |
| Menos de US$25 en total | Depuración inicial más difícil (requiere analizador lógico) |

#### Plan de pruebas
1. **En la mesa:** ESP32 + transceptor alimentados con 12 V. Con el analizador lógico, verificar que el pulso de inicio dure 25 ms bajo y 25 ms alto y que el baudaje sea 10400.
2. **En el auto con el contacto en ON, solo lectura:** `1081`, `2101`, `18 00 FF 00`. Comparar los bytes con las capturas hechas con el ELM327.
3. **Después:** el dashboard web por Wi-Fi y la gestión de batería (dormir con el contacto apagado).

### 4.7 `obd-esp32-elm327`: ESP32 + ELM327 por Bluetooth
El ESP32 reemplaza a la laptop del servidor: crea su propia red Wi-Fi (WPA2), se conecta al ELM327 por Bluetooth Classic y sirve el panel con usuario y clave. Proyecto en [`firmware/esp32-elm327`](../firmware/esp32-elm327/README.md) (PlatformIO).

- **Viable (8/10)** con un **ESP32 clásico** (WROOM-32 / WROVER: DevKit V1, DevKitC V4, ESP32-CAM). Los S2/S3/C3/C6 no tienen Bluetooth Classic.
- **Panel idéntico:** el ESP32 implementa la misma API que `@obdii/server`, así `packages/ui` funciona sin cambios. La interfaz y el core pesan ~72 KB comprimidos; las voces WAV (2.5 MB) no caben con 4 MB de flash: se usa la voz del navegador y los pitidos.
- **No disponible:** GPS en el panel e instalación como PWA (sin HTTPS).
- **Trabajo principal:** pasar a C++ la sesión (inicio KWP, bloque 2101 del SIM2K-33, códigos, recuperación). Las explicaciones de los códigos se resuelven en el navegador.
- **Fases:** 1) comunicación y acceso ✅ (falta probar en la placa); 2) tiempo real y códigos con el panel de `packages/ui`; 3) borrado con PIN, vigilancia de batería, recuperación; 4) grabación (microSD), zumbador, OTA.
- Más adelante, la conexión Bluetooth puede reemplazarse por la línea K directa de §4.6 sin rehacer el resto.

---

## 5. Orden propuesto

1. ✅ **Core (2026-11-20).** Monorepo creado:
   - núcleo en `packages/core` (`@obdii/core`), con el contrato de transporte y un logger inyectable;
   - transporte Node en `packages/serial-node` (`@obdii/serial-node`);
   - consola en `apps/cli`;
   - transporte simulado y pruebas en `packages/core/test` (`npm test`).
   - **Criterio de aceptación:** la consola se comporta igual que hoy, probada con el auto (DTCs, opción 20, info de la ECU).
   - Añadir el transporte simulado con respuestas grabadas para pruebas sin el vehículo.
2. ✅ **`obd-ui` + `obd-server` (2026-11-20).**
   - `packages/core/src/diagnostics.js`: DTCs, tiempo real e info de la ECU como JSON, reutilizable por la PWA.
   - `packages/ui`: interfaz web sin compilación, con un "cliente" intercambiable (`RemoteClient` para el servidor; la PWA tendrá un `DirectClient` con Web Serial y el mismo contrato).
   - `apps/server`: solo `node:http`, sin dependencias externas. Usa Server-Sent Events en lugar de WebSocket: el envío es unidireccional (servidor → navegadores) y los comandos van por `fetch`.
   - Modo `--sim` con el transporte simulado para probar sin el auto.
3. ✅ **`obd-pwa` (2026-11-20).**
   - `packages/core/src/session.js`: `ObdSession`, la lógica de sesión que antes estaba en el servidor; ahora la comparten el servidor y la PWA.
   - `packages/web-serial`: transporte Web Serial (USB y Bluetooth SPP emparejado; detecta la pérdida del enlace).
   - `packages/ui/src/clients/direct-client.js`: mismo contrato que `RemoteClient`, ejecutando la sesión en el navegador.
   - `apps/pwa`: compilación sin dependencias (*import map*), manifiesto, íconos, service worker para uso sin conexión y workflow de GitHub Pages.
   - Publicada en https://rdsslab.github.io/OBDII_cli/ (GitHub Pages, workflow `Publish PWA`).
   - Probado con un puerto Web Serial simulado en Node y en Chrome headless (sin errores, instalable). **Falta probarlo con el ELM327 real**: en Chrome de la laptop (COM6) y en el teléfono.
3b. ✅ **Alertas, sonido y calibración GPS (2026-11-20).**
   - `packages/core/src/alerts.js`: 11 alertas con umbrales configurables.
   - `packages/ui`: avisos en pantalla, pitidos con Web Audio, voces WAV en español e inglés generadas con Windows TTS, vibración, notificaciones y pantalla encendida.
   - `ObdSession`:
     - relee los códigos cada 3 min durante el tiempo real;
     - nuevo modo «vigilar batería» (solo `ATRV`);
     - evento `ecu-link` para la alerta de comunicación perdida.
   - Calibración GPS de la velocidad en la PWA, con CSV para analizar.
3c. ✅ **Grabación de datos (2026-11-20).** `packages/core/src/trip-log.js` y pestaña **Grabar**: sensores, bloque crudo, GPS (PWA) y eventos. El servidor graba en `logs/*.jsonl` y la PWA en IndexedDB; ambos descargan CSV.
4. **`obd-android`.** Capacitor + plugin Bluetooth serie; probar en el teléfono y luego en el radio.
4b. **`obd-esp32-elm327`** (§4.7). Fase 1 hecha (2026-11-20): Bluetooth al ELM327, red Wi-Fi con ingreso, prueba de ECU, terminal con lista de permitidos, simulador `npm run esp32:mock`.
5. **`obd-esp32`.** Hardware propio sin ELM327. Necesita los pasos 1 y 2 (el core y `obd-ui`) si se sigue la opción B. El trabajo del hardware y del firmware se puede adelantar en paralelo.

Cada paso es usable por sí solo; si uno no da resultado (p. ej. Web Serial en Android), se salta al siguiente sin perder lo anterior.

---

## 6. Riesgos y decisiones pendientes

- [ ] **Repositorio:** monorepo (recomendado) o repositorios separados.
- [ ] **Framework de `obd-ui`:** JavaScript sin framework o Svelte.
- [ ] **Web Serial sobre Bluetooth en Android:** confirmar con el teléfono real antes de invertir en la PWA.
- [ ] **Plugin Bluetooth para Capacitor:** elegir uno mantenido que soporte SPP clásico (no solo BLE).
- [ ] **Radio del auto:** versión de Android y si permite emparejar el ELM327.
- [x] **Seguridad en `obd-server`:** «Borrar códigos» solo con `--pin`; sin PIN el servidor es de solo lectura (2026-11-20).
- [ ] **`obd-esp32`:**
  - elegir el transceptor (L9637D o SN65HVDA195) y la opción de software (A o B);
  - diseñar cómo detectar el contacto para no descargar la batería.
- [ ] **Ciclo de vida de la sesión KWP en móviles:** enviar `82` al cerrar y respetar los ~6 s de silencio antes de reconectar (ver [ECU_SIM2K-33.md](ECU_SIM2K-33.md)), sobre todo cuando Android suspende la app.
