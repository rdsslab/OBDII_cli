# obd-esp32-elm327

El ESP32 crea su propia red Wi-Fi, se conecta al ELM327 por Bluetooth y sirve el panel web. Ningún teléfono ni computadora tiene que estar conectado al adaptador: cualquier dispositivo se une a la red del ESP32, ingresa con usuario y clave y ve el panel.

```
 ELM327 (OBD2) ◄──Bluetooth Classic──► ESP32 ◄──Wi-Fi (red propia, WPA2)──► teléfono / radio / laptop
                                          └─ servidor web http://192.168.4.1  (http://obd.local)
```

**Estado: fase 1** (comunicación). Ver [fases](#fases).

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

- Las páginas `web/*.html` se comprimen y se incrustan en el firmware antes de cada compilación (`scripts/embed_web.py` → `include/web_assets.h`). No hace falta subir un sistema de archivos.
- Particiones `min_spiffs.csv`: Bluetooth + Wi-Fi + servidor web no caben en la partición de 1.25 MB por defecto.
- Tamaño en la fase 1: RAM 18.8 % (60 KB), flash 84.6 % de 1.9 MB. Las fases 2–4 agregan el panel de `packages/ui` (~72 KB comprimido) y más código: si no alcanza, se pasa a `huge_app.csv` (3 MB, sin OTA) o a una placa de 8–16 MB.
- En Windows, si la compilación falla con `CreateProcess: No such file or directory`, la ruta de la carpeta de PlatformIO es demasiado larga: usa la de por defecto (`%USERPROFILE%\.platformio`).

## Primer uso

1. Enchufa el ELM327 en el conector OBD y alimenta el ESP32.
2. En el teléfono, conéctate a la red **`OBD2-ESP32`** (clave `obd2esp32`). Android avisa que la red no tiene internet: elige **mantener la conexión**.
3. Abre `http://192.168.4.1` (o `http://obd.local`). Muchos teléfonos abren la página solos.
4. Ingresa con **`admin` / `obd2admin`**.
5. En **Ajustes**, cambia la clave del panel y la de la red Wi-Fi. El panel muestra un aviso mientras se usen los valores de fábrica.
6. **Buscar adaptadores** → **Conectar** en el que dice «probable ELM327» (PIN 1234 por defecto). El ESP32 recuerda ese adaptador y se reconecta solo al encender.
7. Con el contacto en ON: **Probar ECU**.

**Valores de fábrica:** si olvidas una clave, mantén presionado el botón **BOOT** 5 s con el ESP32 encendido; se borran los ajustes y se reinicia.

## Panel de la fase 1

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

## API (fase 1)

Todas las rutas, salvo `/login` y `/api/login`, requieren la cookie de sesión. Los cuerpos POST van como `application/x-www-form-urlencoded`. Las órdenes al adaptador responden `202` (en cola) o `409` (ocupado / no permitido); el resultado llega por el registro.

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

## Simulador (sin la placa)

`npm run esp32:mock` (desde la raíz del repo) levanta en `http://localhost:8032` las mismas páginas y la misma API, con el ELM327 simulado del core (`SimTransport`). Sirve para trabajar en el panel sin el ESP32. La lista de permitidos del simulador es una copia de `lib/obd_text/src/obd_text.cpp`: mantenlas iguales.

## Estructura

```
firmware/esp32-elm327/
├── platformio.ini            entornos esp32dev y native (pruebas)
├── include/config.h          valores por defecto y límites
├── src/
│   ├── main.cpp              red Wi-Fi, DNS cautivo, mDNS, botón BOOT
│   ├── settings.*            ajustes en NVS y claves (SHA-256 + sal)
│   ├── events.h              registro compartido entre tareas
│   ├── elm_link.*            tarea Bluetooth: búsqueda, conexión, ELM327, prueba de ECU
│   └── web.*                 servidor web, ingreso, API, Server-Sent Events
├── lib/obd_text/             lógica pura: limpieza de respuestas, tramas KWP, lista de permitidos
├── lib/auth_core/            lógica pura: bloqueo por intentos, sesiones, cookies
├── test/test_native/         pruebas Unity de lib/ (pio test -e native)
├── web/                      login.html, index.html (se incrustan al compilar)
├── scripts/embed_web.py      web/*.html → include/web_assets.h
└── tools/mock-server.mjs     simulador del firmware en Node
```

## Fases

1. ✅ **Comunicación:** Bluetooth con el ELM327, red Wi-Fi con ingreso, prueba de ECU, terminal segura, registro en vivo. *Falta probarla en la placa y en el auto.*
2. **Tiempo real y códigos:** la API de `@obdii/server` (`/api/live/*`, `/api/dtcs`, `/api/ecu-info`, eventos `live`, `dtcs`) y el **panel de `packages/ui`** servido desde la memoria del ESP32. Decodificación del bloque 2101 del perfil SIM2K-33 en C++.
3. **Igual que el servidor:** borrar códigos con confirmación y PIN, vigilancia de batería, recuperación escalonada, lectura periódica de códigos.
4. **Extras:** grabación de datos (memoria interna o microSD de la ESP32-CAM), alertas con zumbador sin necesidad del panel, actualización por Wi-Fi (OTA).
