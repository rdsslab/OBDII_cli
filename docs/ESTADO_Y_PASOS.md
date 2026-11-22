# Estado del proyecto y pasos hasta terminarlo

Actualizado: 2026-11-21 (fase 3: alertas no bloqueantes, API/UI, correcciones de bugs). Sirve para retomar el trabajo en otra máquina (**Linux**). Contiene lo hecho, cómo preparar el equipo, cómo cargar el ESP32 y qué falta, en orden.

- Uso de cada aplicación: [README.md](../README.md).
- Firmware: [firmware/esp32-elm327/README.md](../firmware/esp32-elm327/README.md).
- La ECU del auto: [ECU_SIM2K-33.md](ECU_SIM2K-33.md).
- Plan general por plataforma: [PROYECTOS_FUTUROS.md](PROYECTOS_FUTUROS.md).

---

## 1. Qué está hecho

| Parte | Estado | Probado en el auto |
|---|---|---|
| `packages/core`: protocolo ELM327 / KWP2000, perfil SIM2K-33, sesión con reconexión, alertas, grabación, filtro de picos de velocidad | ✅ | ✅ (con la consola y el servidor en Windows) |
| `apps/cli`: consola | ✅ | ✅ |
| `apps/server`: servidor web local con PIN para borrar códigos | ✅ | ✅ |
| `apps/pwa`: app instalable con Web Serial | ✅ | parcial |
| `packages/ui`: interfaz web común (tiempo real, códigos, ECU, alertas, grabación, calibración GPS) | ✅ | ✅ |
| **ESP32, fase 1:** red Wi-Fi propia, ingreso con clave, Bluetooth al ELM327, prueba de ECU, terminal segura | ✅ compila | ❌ nunca se cargó en la placa |
| **ESP32, fase 2:** el panel `packages/ui` servido por el ESP32 y la sesión del core en el navegador, por un puente WebSocket ↔ Bluetooth | ✅ compila, pruebas con el simulador | ❌ |
| **ESP32, fase 3:** alertas sin panel abierto (zumbador, vigilancia de batería) con máquina de estados no bloqueante, API `/api/alerts`, controles en `/esp32` | ⚠️ implementado, falta probar en auto | — |
| ESP32, fase 4: grabación en el ESP32, OTA, GPS | ⏳ por hacer | — |
| Android (Capacitor) | ⏳ por hacer (ver PROYECTOS_FUTUROS.md) | — |

### Decisión de la fase 2 (importante para el futuro)
El ESP32 **no** decodifica los datos en C++. Sirve los mismos archivos de `packages/ui` y `packages/core`: `tools/build-web.mjs` los empaqueta en el firmware en cada compilación. La sesión (`ObdSession`) corre en el navegador del teléfono, y el ESP32 solo reenvía bytes entre un WebSocket (`/api/ws/elm`) y el Bluetooth del ELM327.

**Consecuencia:** cualquier cambio en el core o en la interfaz llega al ESP32 al volver a compilar y cargar. No hay una copia en C++ que mantener sincronizada. La única excepción es la lista de comandos permitidos de la terminal: está en `lib/obd_text/src/obd_text.cpp` y copiada en `tools/mock-server.mjs`.

Detalles del puente:
- Un dispositivo a la vez maneja el adaptador; si otro se conecta, toma el control.
- Mientras el panel usa el adaptador, la página `/esp32` bloquea sus pruebas.
- Si se corta el Bluetooth, el ESP32 reconecta cada 15 s y el panel reanuda la sesión solo.

Limitaciones conocidas del panel servido por el ESP32:
- **Sin GPS:** los navegadores exigen `https` para dar la ubicación.
- **Voces sintéticas:** los WAV grabados (2.5 MB) no caben en el firmware.
- **Grabaciones en el teléfono:** se guardan en IndexedDB, no en el ESP32.

### Números de la última compilación (fase 3, 2026-11-21)
- Firmware: RAM 18.9 % (61.976 bytes); flash **56.9 %** de 3 MB (1.788.933 bytes, particiones `huge_app.csv`, **sin OTA**).
- Panel + core empaquetados: 29 archivos, 292 KB → 92 KB gzip (se regeneran al compilar).
- `pio test -e native`: ✅ 6 pruebas pasan en Linux.
- `pio run -e esp32dev`: ✅ compila y se cargó en `/dev/ttyUSB0` (CP2102).

### Correcciones de fase 3 (2026-11-21)
- **Decodificación 2101:** `kwp_decode::hexToBytes()` ahora descarta el prefijo de respuesta positiva `61 01` antes de devolver los datos, evitando el corrimiento de 2 bytes.
- **Alertas no bloqueantes:** la lectura de 2101/ATRV y el zumbador usan máquinas de estados (`cmdBegin/cmdPoll`, `alertTick`, `beepTick`) para no bloquear la tarea elm ni el puente.
- **Auto-reconexión:** `kickReconnect()` resetea fallos; al alcanzar el máximo se avisa una vez y se detiene la auto-reconexión hasta conexión manual.
- **Configuración persistente:** `alertsEnabled`/`buzzerEnabled` en NVS, expuestos en `/api/state` y `/api/alerts`.
- **Limitación:** las alertas por 2101 dependen de una sesión KWP válida; si la ECU no respondió aún, el ESP32 sondea cada 30 s y marca `ecu=responde` al recibir `61 01` válido.

---

## 2. Antes de dejar la máquina Windows

1. **Subir los cambios a git.** El trabajo de la fase 2 puede estar sin commit; revisa con `git status`:
   ```bash
   git add -A
   git commit -m "feat(esp32): phase 2 - shared OBD2 panel served by the ESP32 over a WebSocket bridge"
   git push
   ```
2. **Copiar a mano los archivos que git ignora** (`.gitignore`), si los quieres conservar:
   - capturas y reportes del auto en la raíz: `live_*.csv`, `dtc_*.json`, `dtc_*.log`, `dtc_report_*.html`;
   - la carpeta `logs/` (grabaciones del servidor), si existe.

   `apps/pwa/dist/`, `firmware/*/.pio/` y `include/web_assets.h` no hace falta copiarlos: se regeneran al compilar.
3. **Anotar la MAC del ELM327 Bluetooth.** En Windows aparece en el Administrador de dispositivos, en el puerto «Serie estándar sobre el vínculo Bluetooth» saliente (COM6): son los 12 dígitos después de `_` en el identificador `BTHENUM\…`. En Linux se usa directamente para `rfcomm` (paso 6).

---

## 3. Preparar la máquina Linux

Los ejemplos son para Ubuntu / Debian; en Fedora usa `dnf` y en Arch `pacman` con los mismos paquetes.

```bash
# Herramientas base y compilador (también para las pruebas nativas del firmware)
sudo apt update
sudo apt install -y git build-essential python3 python3-venv pipx curl

# Node.js 22 o superior. Las pruebas usan el WebSocket integrado de Node;
# el proyecto se desarrolló con Node 24.
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version          # v24.x

# PlatformIO (CLI)
pipx install platformio
pipx ensurepath          # luego abre una terminal nueva
pio --version

# Permiso para usar los puertos serie USB sin sudo (cerrar sesión y volver a entrar)
sudo usermod -aG dialout $USER

# Reglas udev de PlatformIO (permisos de las placas)
curl -fsSL https://raw.githubusercontent.com/platformio/platformio-core/develop/platformio/assets/system/99-platformio-udev.rules \
  | sudo tee /etc/udev/rules.d/99-platformio-udev.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

**Driver USB del ESP32:** en Linux no hace falta instalar nada; el kernel trae `cp210x` (CP2102) y `ch341` (CH340). En Windows este paso faltaba (error 28 del CP2102).

**Ubuntu y el paquete `brltty`:** si la placa usa CH340 y el puerto aparece y desaparece al instante, `brltty` lo está tomando. Quítalo con `sudo apt remove brltty`.

**Editor (opcional):** VS Code con la extensión PlatformIO IDE. Abre la carpeta `firmware/esp32-elm327` para compilar y cargar con botones.

---

## 4. Clonar y verificar que todo funciona (sin placa ni auto)

```bash
git clone https://github.com/rdsslab/OBDII_cli.git
cd OBDII_cli
npm install
npm test                       # todas las pruebas deben pasar
npm run pwa:build              # compila la PWA

cd firmware/esp32-elm327
pio run -e esp32dev            # compila el firmware (la primera vez descarga ~300 MB)
pio test -e native             # pruebas de lib/ en la PC: nunca se ejecutaron, revisar si fallan
cd ../..

npm run esp32:mock             # simulador del ESP32: http://localhost:8032 (admin / obd2admin)
```

En el simulador:
1. Entra a `http://localhost:8032/esp32`.
2. **Buscar adaptadores** → **Conectar** en «OBDII».
3. Vuelve a `/` y pulsa **Conectar**: debe mostrar datos en tiempo real.
4. Para probar la reconexión: `curl -X POST -b 'obd_sess=…' localhost:8032/api/sim/drop`, o simplemente desconectando y conectando desde la página.

---

## 5. Cargar el firmware en el ESP32

1. Conecta el ESP32 por USB y busca su puerto:
   ```bash
   pio device list            # normalmente /dev/ttyUSB0 (CP2102 / CH340)
   ```
2. Compila y carga:
   ```bash
   cd firmware/esp32-elm327
   pio run -e esp32dev -t upload          # agrega --upload-port /dev/ttyUSB0 si hay varios
   pio device monitor                     # registro por USB, 115200 baudios (salir: Ctrl+C)
   ```
3. Si la carga falla con `Failed to connect to ESP32: Timed out waiting for packet header`, mantén presionado **BOOT** mientras aparece `Connecting....` y suéltalo cuando empiece a escribir.
4. En el monitor debe aparecer `obd-esp32-elm327 0.2.0 (fase 2)`, «Red Wi-Fi «OBD2-ESP32»…» y «Bluetooth listo (modo maestro)».

Si al compilar aparece `embed_web: Node.js is required`, Node no está en el PATH de la terminal (o del VS Code) que compila.

---

## 6. Usar la consola y el servidor en Linux (opcional)

En Linux el ELM327 Bluetooth no aparece como `COM6`: se crea un puerto `/dev/rfcommN`.

```bash
sudo apt install -y bluez
bluetoothctl              # dentro: power on · scan on · pair AA:BB:CC:DD:EE:FF (PIN 1234) · trust AA:BB:CC:DD:EE:FF · quit
sudo rfcomm bind 0 AA:BB:CC:DD:EE:FF 1     # crea /dev/rfcomm0 (canal 1, el habitual del ELM327)
npm start                                  # elegir /dev/rfcomm0
npm run server -- --com /dev/rfcomm0
```
- `rfcomm bind` no sobrevive a un reinicio; vuelve a ejecutarlo, o configúralo en `/etc/bluetooth/rfcomm.conf` / un servicio systemd.
- Lo que solo funciona en Windows:
  - La marca «BT saliente / entrante» de la lista de puertos depende del `pnpId` de Windows (`BTHENUM`). En Linux no se muestra, y no hace falta porque hay un solo puerto.
  - `tools/generate-voices.mjs` usa la voz de Windows (System.Speech). En Linux, para regenerar los WAV, habría que adaptarlo (por ejemplo con `espeak-ng` o `piper`), o generarlos en Windows. Los WAV ya están en el repositorio.
- La PWA en Linux: Chrome de escritorio con Web Serial ve `/dev/rfcomm0` y los adaptadores USB.

---

## 7. Pasos hasta terminar, en orden

### Paso A: probar la fase 1 en la placa (sin el auto)
Con el ESP32 alimentado por USB y el ELM327 alimentado (en el auto o con una fuente de 12 V en los pines 16 y 4/5 del conector):
- [ ] El teléfono ve la red `OBD2-ESP32`, se conecta (clave `obd2esp32`) y abre `http://192.168.4.1`; prueba también `http://obd.local`.
- [ ] Ingreso con `admin` / `obd2admin`; 5 claves malas bloquean 60 s.
- [ ] En `/esp32`: cambiar la clave del panel y la de la red Wi-Fi. El ESP32 se reinicia con la red nueva.
- [ ] **Buscar adaptadores**: aparece el ELM327 como «probable ELM327».
- [ ] **Conectar** con PIN 1234 (o 0000). **Punto crítico:** algunos clones fallan con `SerialBT.connect()` por el PIN o por SSP; si falla, anotar el modelo y lo que muestra `pio device monitor`.
- [ ] Inicializar ELM327 y leer el voltaje (`ATRV`).
- [ ] Reiniciar el ESP32: debe reconectarse solo al adaptador guardado.
- [ ] Mantener BOOT 5 s: vuelve a los valores de fábrica.

### Paso B: probar la fase 1 en el auto
- [ ] Contacto en ON → **Probar ECU**: «Sesión iniciada (1081)» y «La ECU responde: bloque 21 01 con 78 bytes».
- [ ] Terminal: `2101`, `1A90`, `18FF00`. Comprobar que `04`, `14` y `11` se bloquean.
- [ ] Alimentación en el auto: un convertidor de 12 V a 5 V estable; revisar que el ESP32 no se reinicie al arrancar el motor (caída de voltaje).

### Paso C: probar la fase 2 en el auto
En el panel `/`, con el contacto en ON:
- [ ] **Conectar**: estado «Conectado», protocolo KWP2000.
- [ ] Tiempo real: RPM, temperatura, velocidad, voltaje. Comparar la frecuencia (lecturas/s) con la PWA o el servidor; el puente agrega unos milisegundos por comando.
- [ ] Leer códigos y abrir el reporte HTML.
- [ ] Información de la ECU.
- [ ] Alertas con sonido (pestaña Ajustes → «Probar»): voz sintética o pitidos.
- [ ] Grabación: iniciar, detener y descargar el CSV.
- [ ] Apagar el ELM327 (desconectarlo del OBD) unos segundos y volver a conectarlo: el panel debe mostrar «Reconectando…» y reanudar solo.
- [ ] Segundo teléfono: pulsar **Conectar** ahí; el primero muestra «Otro dispositivo tomó el control».
- [ ] Teléfono en reposo con el panel abierto: comprobar que, al volver, reconecta; y que si se cierra, `/esp32` deja de mostrar «El panel OBD2 está usando el adaptador» (el ESP32 tarda en notar un cliente que desapareció).
- [ ] Vigilar batería con el contacto apagado.
- [ ] Borrar códigos (motor apagado, con confirmación).

Corregir lo que falle, actualizar `firmware/esp32-elm327/README.md` y marcar «probado en el auto».

### Paso D: pendientes menores del firmware
- [ ] `web.cpp`, `onNotFound`: la redirección del portal cautivo usa `192.168.4.1` fijo; debería construirse desde `AP_IP` de `config.h`.
- [ ] `elm_link.cpp`, `disconnect()`: «Desconectar» en `/esp32` solo apaga la reconexión hasta reiniciar; al encender vuelve a conectar al adaptador guardado. Decidir si debe olvidar el adaptador (borrar `elmMac`) o agregar un botón «Olvidar adaptador».
- [ ] La sesión del panel dura 12 h. Si vence con el panel abierto, el puente falla al reconectar con un mensaje genérico. Mejorar: que `Esp32Client` consulte `/api/state` en cada reintento y mande a `/login` si responde 401.

### Paso E: fase 3, funciones sin el panel abierto
Objetivo: avisar aunque el teléfono esté guardado o apagado. Esto sí va en C++, en `elm_link.cpp`, y se ejecuta solo cuando **no** hay un navegador usando el puente.

**Estado 2026-11-21:** base implementada (no bloqueante) y compilada; falta validación en auto real.
- [x] Librería `lib/kwp_decode` con decodificación de 2101 (RPM, voltaje, temp refrigerante, estado motor, acelerador).
- [x] Máquina de estados no bloqueante para alertas (`cmdBegin/cmdPoll`, `alertTick`, `beepTick`).
- [x] Umbrales iniciales: sobrecalentamiento > 110 °C, no carga < 10.0 V con RPM > 1000, batería baja < 10.5 V con motor apagado (ATRV cada 30 s).
- [x] Zumbador configurable por `BUZZER_PIN` (patrón warning/critical).
- [x] API `/api/alerts` (GET/POST) y estado en `/api/state`.
- [x] Controles en `/esp32` y persistencia en NVS (`alertsOn`, `buzzerOn`).
- [ ] Confirmar en auto real: sesión KWP activa, valores decodificados correctos, patrones de zumbador.
- [ ] Ajustar convivencia con panel (evitar doble alerta) y lectura periódica de DTC (18/FF00).
1. **Hardware:** un zumbador activo de 5 V con un transistor NPN en un GPIO libre (por ejemplo GPIO 25), y opcionalmente un LED. Definir el pin en `config.h`.
2. **Lectura periódica propia:** cada 2–5 s, inicio KWP (ya existe en `doEcuTest`) y `21 01`. Pasar a C++, en `lib/obd_text` y con pruebas nativas, **solo** los campos confirmados que hacen falta, copiando las fórmulas de `packages/core/src/ecu-profiles.js` (bloque `2101`, 78 bytes):
   - temperatura del refrigerante;
   - voltaje de la batería (ECU);
   - RPM: `le16(b, 19)`;
   - estado del motor.

   Copiar las fórmulas exactas de los `decode` de esos campos. No reimplementar el resto.
3. **Alertas mínimas:** sobrecalentamiento, batería que no carga con el motor en marcha y batería baja con el motor apagado. Usar los mismos umbrales y retardos que `packages/core/src/alerts.js` (`ALERT_DEFS`). Patrones del zumbador: 2 pitidos = advertencia, 3 rápidos = crítico.
4. **Vigilancia de batería con el contacto apagado:** solo `ATRV` cada 30 s, como `watchBattery()` del core.
5. **Convivencia con el panel:** cuando un navegador toma el puente, el ESP32 detiene su lectura (ya ocurre: la tarea Bluetooth entra en modo puente). Al soltarlo, la reanuda. Opción: que el panel informe al ESP32 las alertas activas para no sonar dos veces.
6. Lectura periódica de códigos (servicio `18`), con aviso por el zumbador si aparece un código nuevo.
7. Ajustes en `/esp32`: activar o desactivar el zumbador y los umbrales, guardados en NVS (`settings.cpp`).
8. **Espacio:** resuelto temporalmente con `huge_app.csv` (3 MB, sin OTA); uso actual 56.9 %. Si se necesita OTA, volver a `min_spiffs.csv` o usar placa con más flash.
9. Extender `tools/mock-server.mjs` con el mismo comportamiento y agregar pruebas.

### Paso F: fase 4, extras
- **OTA:** actualizar el firmware por Wi-Fi desde `/esp32`, con `Update.h` y una subida protegida con la clave. Necesita particiones con dos ranuras (`min_spiffs.csv` las tiene; `huge_app.csv` no).
- **Grabación en el ESP32:** en la ESP32-CAM, microSD con `SD_MMC`; o LittleFS en la flash, con poco espacio. Útil para grabar sin el teléfono.
- **GPS en el panel del ESP32:** requiere `https`. Opciones: un certificado propio (el teléfono mostrará una advertencia), un módulo GPS serie (NEO-6M) conectado al ESP32 que entregue la velocidad al panel, o seguir usando la PWA para calibrar.
- Voces grabadas: si se pasa a una placa con más flash o se usa la microSD, se pueden servir los WAV (convertidos a un formato comprimido).

### Paso G: cerrar el proyecto
- [ ] Android (Capacitor), según PROYECTOS_FUTUROS.md, si todavía interesa.
- [ ] Actualizar README.md, firmware/esp32-elm327/README.md y ECU_SIM2K-33.md con lo confirmado en el auto.
- [ ] Etiquetar la versión: `git tag v1.0.0 && git push --tags`.

---

## 8. Mapa rápido de archivos del ESP32 (fase 2)

| Archivo | Qué hace |
|---|---|
| `firmware/esp32-elm327/src/elm_link.cpp` | Tarea Bluetooth: búsqueda, conexión, auto-reconexión, pruebas, y el **puente de bytes** (`pumpBridge`, `bridgeAttach`, `bridgeRead/Write`) |
| `firmware/esp32-elm327/src/web.cpp` | Rutas `/`, `/esp32`, `/login`, la API, los eventos SSE, los archivos del panel con ETag y el **WebSocket** `/api/ws/elm` (`onBridgeEvent`, `serviceBridge`) |
| `firmware/esp32-elm327/tools/build-web.mjs` | Empaqueta `web/*.html`, `packages/ui`, `packages/core` y `packages/web-serial` en `include/web_assets.h` |
| `firmware/esp32-elm327/scripts/embed_web.py` | Ejecuta `build-web.mjs` antes de cada compilación de PlatformIO |
| `firmware/esp32-elm327/tools/mock-server.mjs` | Simulador del ESP32 en Node, con el puente WebSocket y `POST /api/sim/drop` |
| `packages/ui/src/clients/esp32-transport.js` | Transporte del core sobre el WebSocket (`ready` / `wait` / `lost`, códigos de cierre 4001–4003) |
| `packages/ui/src/clients/esp32-client.js` | Cliente del panel para el ESP32 (hereda de `DirectClient`) |
| `packages/ui/src/main-esp32.js` | Punto de entrada del panel servido por el ESP32 |
| `packages/ui/test/esp32-client.test.js` | Prueba de punta a punta contra el simulador |
