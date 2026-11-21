# obd-esp32-elm327

El ESP32 crea su propia red Wi-Fi, se conecta al ELM327 por Bluetooth y sirve el panel web. Ningún teléfono ni computadora tiene que estar conectado al adaptador: cualquier dispositivo se une a la red del ESP32, ingresa con usuario y clave y ve el panel.

```
 ELM327 (OBD2) ◄──Bluetooth Classic──► ESP32 ◄──Wi-Fi (red propia, WPA2)──► teléfono / radio / laptop
                                          └─ servidor web http://192.168.4.1  (http://obd.local)
```

**Estado: fase 2** (panel OBD2 completo por el ESP32). Ver [fases](#fases).

El panel de diagnóstico (`/`) es **el mismo `packages/ui` + `packages/core`** que usan la PWA y el servidor: se empaqueta desde el repositorio en cada compilación. Todo ajuste al core o a la interfaz (reconexión, filtro de picos de velocidad, escala de velocidad, grabación, alertas…) llega al ESP32 al volver a compilar y cargar; no hay una copia en C++ que mantener.

## Hardware

| Placa | ¿Sirve? |
|---|---|
| ESP32 DevKit V1 / DevKitC V4 (ESP32-WROOM-32) | ✅ recomendada para empezar (USB integrado) |
| ESP32-CAM (ESP32-S + PSRAM + microSD) | ✅ útil en la fase 4 por la microSD; se programa con un adaptador USB-serie |
| ESP32-S2 / S3 / C3 / C6 | ❌ no tienen Bluetooth Classic: no pueden hablar con un ELM327 Bluetooth SPP |
| ESP-01 (ESP8266) | ❌ sin Bluetooth |

**Alimentación en el auto:** convertidor de 12 V a 5 V (por ejemplo, un cargador USB de encendedor o un módulo reductor) al pin 5V/VIN o al USB. El ELM327 se queda en el conector OBD.

## Compilar y cargar (PlatformIO)

Con la extensión PlatformIO de VS Code: abre la carpeta `firmware/esp32-elm327`, elige el entorno `esp32dev` y usa **Upload**. Desde la terminal:

```bash
cd firmware/esp32-elm327
pio run -e esp32dev -t upload      # compila y carga
pio device monitor                 # registro por USB (115200)
pio test -e native                 # pruebas de la lógica en la PC (necesita gcc/MinGW o clang)
```

- Antes de cada compilación, `scripts/embed_web.py` ejecuta `tools/build-web.mjs` (**necesita Node.js**): comprime `web/*.html`, `packages/ui` y `packages/core` y los incrusta en el firmware (`include/web_assets.h`). No hace falta subir un sistema de archivos. Las voces grabadas (`sounds/*.wav`, ~2.5 MB) no se incluyen: el navegador dice las mismas frases con su voz sintética.
- Particiones `min_spiffs.csv`: Bluetooth + Wi-Fi + servidor web no caben en la partición de 1.25 MB por defecto.
- Tamaño en la fase 2: RAM 18.9 % (62 KB), flash 90.5 % de 1.9 MB (el panel y el core ocupan ~92 KB comprimidos). Si las fases 3–4 no caben, se pasa a `huge_app.csv` (3 MB, sin OTA) o a una placa de 8–16 MB.
- **Driver USB:** la mayoría de las placas DevKit usan el chip CP2102 (driver «CP210x Universal Windows Driver» de Silicon Labs) o el CH340 (driver de WCH). Sin el driver, Windows muestra el dispositivo con error y no crea el puerto COM.
- En Windows, si la compilación falla con `CreateProcess: No such file or directory`, la ruta de la carpeta de PlatformIO es demasiado larga: usa la de por defecto (`%USERPROFILE%\.platformio`).

## Primer uso

1. Enchufa el ELM327 en el conector OBD y alimenta el ESP32.
2. En el teléfono, conéctate a la red **`OBD2-ESP32`** (clave `obd2esp32`). Android avisa que la red no tiene internet: elige **mantener la conexión**.
3. Abre `http://192.168.4.1` (o `http://obd.local`). Muchos teléfonos abren la página solos.
4. Ingresa con **`admin` / `obd2admin`**. Se abre el **panel OBD2**.
5. La primera vez, entra en **Ajustes del ESP32** (enlace en la pestaña Conexión, o `http://192.168.4.1/esp32`):
   - cambia la clave del panel y la de la red Wi-Fi (la página avisa mientras se usen los valores de fábrica);
   - **Buscar adaptadores** → **Conectar** en el que dice «probable ELM327» (PIN 1234 por defecto). El ESP32 recuerda ese adaptador y se reconecta solo al encender;
   - opcional: con el contacto en ON, **Probar ECU**.
6. Vuelve al **Panel OBD2** y pulsa **Conectar** con el contacto en ON. Desde ahí funcionan tiempo real, códigos, información de la ECU, alertas, grabación y calibración, como en la PWA.

**Valores de fábrica:** si olvidas una clave, mantén presionado el botón **BOOT** 5 s con el ESP32 encendido; se borran los ajustes y se reinicia.

## Panel OBD2 (fase 2)

Es la interfaz de `packages/ui`, servida en `/`. La sesión de diagnóstico (`ObdSession` de `packages/core`) **corre en el navegador**, como en la PWA. El ESP32 solo mantiene el Bluetooth con el ELM327 y reenvía los bytes por un WebSocket (`/api/ws/elm`):

```
navegador: packages/ui + packages/core ◄──WebSocket──► ESP32 ◄──Bluetooth SPP──► ELM327
```

- **Un dispositivo a la vez maneja el adaptador.** Si otro teléfono pulsa «Conectar», toma el control y el primero se detiene con un aviso (no se lo disputan).
- Mientras el panel usa el adaptador, las pruebas y la terminal de «Ajustes del ESP32» quedan bloqueadas.
- **Si se corta el Bluetooth** entre el ESP32 y el ELM327, el ESP32 reconecta solo (cada 15 s) y el panel reanuda la sesión y el tiempo real por sí mismo (2/4/8/15 s, luego cada 30 s).
- **Diferencias con la PWA:**
  - **GPS:** los navegadores solo dan la ubicación en páginas `https://`. En `http://192.168.4.1` no hay GPS, así que la calibración de velocidad y la posición en las grabaciones no funcionan. Usa la PWA para eso.
  - **Voces:** usan la voz sintética del navegador en lugar de las grabaciones.
  - **Grabaciones:** se guardan en el navegador del dispositivo (IndexedDB), no en el ESP32.

## Ajustes del ESP32 (`/esp32`, antes la página de la fase 1)

- **Adaptador ELM327:** búsqueda Bluetooth, conexión por lista o por MAC con PIN, desconexión, reconexión automática cada 15 s al adaptador guardado.
- **Pruebas:**
  - **Inicializar ELM327:** `ATZ`, `ATE0`, `ATL0`, `ATS1`, `ATH0`, `ATAT2`, `ATST 96`, `ATRV`.
  - **Probar ECU:** la misma secuencia que el core para el SIM2K-33: `ATSP5`, `ATH1`, `AT SH 81 11 F1`, `AT WM 81 11 F1 3E`, sesión `10 81` (o `10 89`) y una lectura de `21 01`. Solo lectura.
  - **Terminal:** comandos AT y servicios de solo lectura. Las respuestas KWP se muestran decodificadas.
- **Registro:** cada comando enviado (→) y respuesta (←), en vivo (Server-Sent Events).
- **Ajustes:** nombre y clave de la red, usuario y clave del panel, PIN del adaptador. Todo cambio pide la clave actual.
- **Sistema:** versión, tiempo encendido, memoria libre, dispositivos en la red.

### Seguridad
- Red Wi-Fi WPA2 con clave propia (8–63 caracteres).
- Ingreso con usuario y clave: la clave se guarda como SHA-256 con sal aleatoria. Sesión con cookie `HttpOnly; SameSite=Strict` de 12 h; máximo 6 sesiones.
- 5 claves incorrectas bloquean el ingreso 60 s.
- **Terminal con lista de permitidos:** se bloquean borrar códigos (`04`, `14`), el reinicio de la ECU (`11`), la sesión de programación (`10 85`), escrituras (`2E`, `3B`), rutinas (`31`), control de actuadores (`2F`, `30`), acceso de seguridad (`27`), descargas y los comandos AT que cambian el adaptador de forma permanente (`AT PP`, `AT BRD`…). Borrar códigos llegará en la fase 3, con confirmación y PIN como en el servidor.
- Sin HTTPS: el tráfico va cifrado por WPA2 dentro de la red del ESP32, no de extremo a extremo.

## API

Todas las rutas, salvo `/login`, `/api/login` y los archivos del panel (`/src/…`, `/vendor/…`), requieren la cookie de sesión. Los cuerpos POST van como `application/x-www-form-urlencoded`. Las órdenes al adaptador responden `202` (en cola) o `409` (ocupado / no permitido); el resultado llega por el registro.

| Ruta | Descripción |
|---|---|
| `POST /api/login` (`user`, `pass`), `POST /api/logout` | sesión |
| `GET /api/state` | estado: Bluetooth, ELM327, ECU, memoria, red |
| `GET /api/log` | últimas 120 líneas del registro |
| `GET /api/events` | Server-Sent Events: `state`, `log`, `scan` |
| `POST /api/bt/scan`, `GET /api/bt/devices` | búsqueda Bluetooth |
| `POST /api/bt/connect` (`mac`, `pin`, `name`), `POST /api/bt/disconnect` | conexión |
| `POST /api/elm/init`, `/api/elm/voltage`, `/api/elm/ecu-test` | pruebas |
| `POST /api/elm/cmd` (`cmd`) | terminal (lista de permitidos) |
| `GET/POST /api/settings`, `POST /api/restart` | ajustes |
| `GET /` · `GET /esp32` · `GET /login` | panel OBD2 · ajustes del ESP32 · ingreso |
| `GET /src/…`, `/vendor/…` | archivos del panel y del core (gzip, `ETag` por compilación) |
| `WS /api/ws/elm` | puente al ELM327: tramas binarias = bytes en cada sentido; texto JSON del ESP32: `ready`, `wait`, `lost`; cierre `4001` otro dispositivo tomó el control, `4002` sin adaptador guardado, `4003` ESP32 ocupado |

`GET /api/state` incluye `bridge: {active, ready, ip}`. Mientras el puente está activo, las órdenes al adaptador responden `409`.

## Simulador (sin la placa)

`npm run esp32:mock` (desde la raíz del repo) levanta en `http://localhost:8032` las mismas páginas y la misma API, incluido el puente WebSocket, con el ELM327 simulado del core (`SimTransport`). Lee los archivos del repositorio en cada petición: los cambios se ven al recargar. `POST /api/sim/drop` simula que se corta el Bluetooth. La prueba `packages/ui/test/esp32-client.test.js` (incluida en `npm test`) recorre el panel contra el simulador: conexión, tiempo real, códigos, corte y reconexión, y cambio de dispositivo. La lista de permitidos del simulador es una copia de `lib/obd_text/src/obd_text.cpp`: mantenlas iguales.

## Estructura

```
firmware/esp32-elm327/
├── platformio.ini            entornos esp32dev y native (pruebas)
├── include/config.h          valores por defecto y límites
├── src/
│   ├── main.cpp              red Wi-Fi, DNS cautivo, mDNS, botón BOOT
│   ├── settings.*            ajustes en NVS y claves (SHA-256 + sal)
│   ├── events.h              registro compartido entre tareas
│   ├── elm_link.*            tarea Bluetooth: búsqueda, conexión, ELM327, prueba de ECU, puente de bytes
│   └── web.*                 servidor web, ingreso, API, Server-Sent Events, WebSocket del puente
├── lib/obd_text/             lógica pura: limpieza de respuestas, tramas KWP, lista de permitidos
├── lib/auth_core/            lógica pura: bloqueo por intentos, sesiones, cookies
├── test/test_native/         pruebas Unity de lib/ (pio test -e native)
├── web/                      login.html, index.html (= /esp32; se incrustan al compilar)
├── scripts/embed_web.py      ejecuta tools/build-web.mjs antes de compilar
└── tools/
    ├── build-web.mjs         web/*.html + packages/ui + packages/core → include/web_assets.h
    └── mock-server.mjs       simulador del firmware en Node
```

## Fases

1. ✅ **Comunicación:** Bluetooth con el ELM327, red Wi-Fi con ingreso, prueba de ECU, terminal segura, registro en vivo.
2. ✅ **Panel OBD2 completo:** el panel de `packages/ui` servido por el ESP32 y la sesión del core en el navegador, conectada por el puente WebSocket. Con eso llegan tiempo real (con el filtro de picos y la escala de velocidad confirmada), códigos con reporte, borrar códigos con confirmación, información de la ECU, vigilancia de batería, reconexión escalonada, alertas y grabación. No se pasa la decodificación a C++: el core se comparte tal cual.
   *Fases 1 y 2: falta probarlas en la placa y en el auto.*
3. **Sin el panel abierto:** lo que tiene que funcionar con el teléfono guardado. Vigilancia de batería y alertas críticas (sobrecalentamiento, no carga) en C++ con un zumbador, y lectura periódica de códigos.
4. **Extras:** grabación en el ESP32 (memoria interna o microSD de la ESP32-CAM), actualización por Wi-Fi (OTA), `https` o un dominio para tener GPS en el panel.
