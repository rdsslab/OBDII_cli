# OBD2 ELM327 Bluetooth Scanner 🚗🔧

Una aplicación interactiva en línea de comandos (CLI) desarrollada en **Node.js** para realizar diagnósticos vehiculares en tiempo real utilizando un adaptador ELM327 Bluetooth. Soporta tanto el protocolo estándar **OBD2** (Mode 01-0A) como el protocolo **KWP2000** (ISO 14230-4) mediante inicializaciones específicas y perfiles de ECU optimizados.

---

## 🌟 Características Principales

- **Conexión Serial/COM:** Detección automática y selección interactiva de los puertos serie y COM (Bluetooth SPP).
- **Soporte KWP2000 Completo:**
  - Inicialización rápida (Fast Init, `ATSP5`) e inicialización de 5 baudios (`ATSP4`).
  - Direccionamiento físico de ECU configurable mediante cabeceras personalizadas (Headers).
  - Mantenimiento de la sesión con el keep-alive nativo del ELM327 (`AT WM <header> 3E`), que solo se envía con el bus libre y no choca con los comandos.
  - Cabeceras activadas (`ATH1`) y desentramado KWP propio con validación de checksum.
- **Perfiles de ECU Personalizados:**
  - Incluye un perfil preconfigurado para la ECU **Siemens VDO SIM2K-33** (motor de gasolina SAIC Wuling 2008), con cabeceras `81 11 F1` y sesiones de diagnóstico avanzadas.
  - Bloque `2101` decodificado en posiciones fijas y calibrado con capturas reales (RPM, mariposa, MAP, temperatura del refrigerante, voltaje, estado del motor, sensor de oxígeno); además velocidad, corrección de mezcla e inyección marcados como "por calibrar".
  - Identificación de la ECU (servicio `1A`) a partir del directorio `1A81` que reporta la propia ECU; los campos sin programar se muestran como tales.
- **Lectura y Decodificación de Sensores:**
  - Lectura en tiempo real de RPM del motor, velocidad del vehículo, temperatura del refrigerante, carga del motor, posición de la mariposa, voltaje de la batería, nivel de combustible y tiempo de funcionamiento del motor.
  - Modo KWP de lectura de bloques de datos primarios y secundarios.
- **Gestión Avanzada de DTCs (Códigos de Error):**
  - Lectura mediante el Modo 03 estándar de OBD2 o a través de los Servicios KWP2000 18 (lectura por máscara de estado), 13 y 17.
  - Borrado seguro de códigos de error (Modo 04 de OBD2 o Servicio KWP 14).
  - **Base de Datos Local en Español:** Identifica la causa, explicación, soluciones recomendadas y riesgos asociados de cada código.
  - **Generación de Reportes HTML:** Exporta un reporte visual interactivo y auto-contenido con los fallos detectados y sus guías de reparación paso a paso.
- **Robustez y Auto-Recuperación:**
  - Recuperación ante `BUS INIT: ERROR`: espera 6 s de silencio en la línea K (para que la ECU cierre la sesión anterior) y reintenta.
  - Cierre limpio de la sesión KWP (`82`) al salir, para que el siguiente arranque conecte de inmediato.
  - Los comandos al puerto serie se envían en cola, uno a la vez.
- **Consola de Comandos Personalizados:** Envío directo de tramas hexadecimales personalizadas y comandos AT/OBD/KWP para depuración avanzada.
- **Escaneo de Servicios del Módulo:** Comprobación rápida para descubrir qué servicios específicos (OBD2/KWP/UDS) admite la ECU conectada.

---

## 📁 Estructura del Proyecto

Monorepo con *npm workspaces*: un núcleo independiente de la plataforma y una aplicación por plataforma (ver [docs/PROYECTOS_FUTUROS.md](docs/PROYECTOS_FUTUROS.md)).

- 📄 [**index.js**](index.js): punto de entrada de compatibilidad; `npm start` desde la raíz sigue abriendo la consola.
- 📁 **packages/core/** (`@obdii/core`): núcleo sin dependencias de Node ni del navegador.
  - 📄 [**elm327.js**](packages/core/src/elm327.js): motor del protocolo ELM327 / KWP2000. Cola de comandos, desentramado KWP con checksum, reinicios y auto-recuperación. Recibe un *transporte* (la forma de conectarse al adaptador) y un *logger* opcional.
  - 📄 [**ecu-profiles.js**](packages/core/src/ecu-profiles.js): perfiles de ECU (como la SIM2K-33) y fórmulas de decodificación de los bloques KWP.
  - 📄 [**obd2-commands.js**](packages/core/src/obd2-commands.js): comandos OBD2 estándar, PIDs y sus fórmulas de conversión.
  - 📄 [**dtc-database.js**](packages/core/src/dtc-database.js): base de datos de códigos de error y plantilla del reporte HTML en español.
  - 📁 [**test/**](packages/core/test/): pruebas con un ELM327 + ECU simulados a partir de capturas reales del vehículo (`npm test`).
  - 📄 [**diagnostics.js**](packages/core/src/diagnostics.js): lógica de alto nivel (DTCs con su explicación, muestreo en tiempo real, identificación de la ECU) que devuelve JSON; la usan el servidor web y, más adelante, la PWA y la app Android.
  - 📄 [**session.js**](packages/core/src/session.js): `ObdSession`, la sesión compartida (conexión, tiempo real con recuperación escalonada, borrado). La usan el servidor y la PWA.
  - 📄 [**sim-transport.js**](packages/core/src/sim-transport.js): ELM327 + ECU SIM2K-33 simulados con capturas reales, para pruebas y demostraciones sin el auto.
- 📁 **packages/serial-node/** (`@obdii/serial-node`): transporte para Node.js con `serialport` (puerto COM / Bluetooth SPP). Lo usan la consola y el servidor web.
- 📁 **packages/ui/** (`@obdii/ui`): interfaz web común, sin paso de compilación (HTML + CSS + JavaScript). Pantallas de conexión, tiempo real (con modo tablero), códigos, ECU y registro.
- 📁 **packages/web-serial/** (`@obdii/web-serial`): transporte Web Serial para el navegador (Chrome / Edge; adaptador USB o Bluetooth emparejado).
- 📁 **apps/server/** (`@obdii/server`): servidor web local; se conecta al ELM327 y sirve la interfaz a todos los dispositivos de la red.
- 📁 **apps/pwa/** (`@obdii/pwa`): app web instalable (PWA) que se conecta directo al ELM327 con Web Serial; se publica en GitHub Pages.
- 📁 **apps/cli/** (`@obdii/cli`): la aplicación de consola.
  - 📄 [**src/index.js**](apps/cli/src/index.js): menús interactivos, monitor en tiempo real, CSV y presentación con colores ANSI.

---

## 🛠️ Requisitos e Instalación

### Requisitos Previos
1. **Node.js** v18 o superior instalado en el equipo.
2. Un adaptador **ELM327 Bluetooth** conectado al puerto OBD2 del vehículo.
3. El adaptador debe estar emparejado con tu sistema operativo antes de iniciar la aplicación. Esto creará un puerto COM virtual de entrada/salida (comúnmente visible en el Administrador de Dispositivos de Windows).

### Instalación

1. Clona el repositorio o descarga los archivos en una carpeta local:
   ```bash
   git clone <url-del-repositorio>
   cd OBDII_cli
   ```

2. Instala las dependencias necesarias:
   ```bash
   npm install
   ```
   Desde la raíz instala todos los proyectos del monorepo y enlaza `@obdii/core` y `@obdii/serial-node`.

3. (Opcional) Ejecuta las pruebas del núcleo, que no necesitan el auto:
   ```bash
   npm test
   ```

---

## 🚀 Instrucciones de Uso

1. Conecta tu escáner ELM327 al puerto OBD2 del coche y pon el **contacto en posición ON** (o enciende el motor).
2. Ejecuta la aplicación desde la consola:
   ```bash
   npm start
   ```
3. **Selección del Puerto COM:** La aplicación listará los puertos seriales detectados. Windows crea **dos** puertos por adaptador Bluetooth emparejado: el *entrante* (dirección `000000000000`) nunca responde; elige el *saliente*, que la app marca como "probable ELM327" junto a la dirección MAC del adaptador.
4. **Inicialización:**
   - La aplicación detectará el protocolo del coche automáticamente.
   - Si la ECU requiere configuraciones especiales (como KWP2000), el motor intentará asociar un perfil predefinido o probará diferentes cabeceras físicas.
5. **Menú Interactivo:** Utiliza las opciones numéricas del `0` al `20` para interactuar con los sistemas del vehículo.

---

## 🌐 Servidor web local (varios dispositivos a la vez)

La laptop se conecta al ELM327 y publica una aplicación web en la red local. Teléfonos, tablets, otra PC o el navegador del radio del auto la abren al mismo tiempo y ven la misma sesión.

```bash
npm run server                      # elige el puerto desde la página
npm run server -- --com COM6        # conecta al arrancar
npm run server -- --sim             # agrega un puerto "SIM" para probar sin el auto
npm run server -- --port 8080       # otro puerto HTTP (por defecto 3000)
npm run server -- --pin 1234        # habilita «Borrar códigos» protegido con ese PIN
```

Al arrancar muestra las direcciones para abrir desde otros dispositivos (por ejemplo `http://192.168.1.20:3000`). Todos deben estar en la misma red: el Wi-Fi de casa o el hotspot de la laptop o del teléfono dentro del auto. Si otro dispositivo no puede abrir la página, permite Node.js en el firewall de Windows para redes privadas.

**Funciones:**
- **Conexión:** elegir puerto (marca el Bluetooth saliente como "probable ELM327") y perfil de ECU.
- **Tiempo real:** el servidor lee la ECU **una sola vez** y envía cada muestra a todos los dispositivos (Server-Sent Events). Tarjetas con valor, barra y mín/máx. Las escalas sin confirmar llevan la marca "sin confirmar".
  - **Modo tablero:** pocos valores en grande, pensado para el radio del auto. Se abre directo con `http://<ip>:3000/?tablero#live`.
  - **Grabar CSV:** guarda las muestras en el dispositivo que lo pide, incluida la columna de bytes crudos.
- **Códigos:** DTCs con su estado (presente/memorizado, MIL) y la explicación, causas y soluciones de la base de datos. Botón para abrir el reporte HTML.
  - **Borrar códigos:** solo aparece si el servidor se inició con `--pin` (o la variable `OBD_PIN`). Pide confirmación y el PIN en cada borrado, se niega si el motor está en marcha y vuelve a leer los códigos después. Tras 5 PIN incorrectos se bloquea 60 s.
- **ECU:** identificación del servicio `1A`.
- **Registro:** mensajes de la conexión en vivo.

**Escrituras en la ECU:** la única es «Borrar códigos» (servicio `14 FF 00` / OBD2 `04`), y solo con PIN. No hay funciones para reiniciar la ECU ni activar actuadores. Si se cae la conexión con la ECU durante el tiempo real, recupera la sesión sola (≈6 s de silencio en la línea K, igual que la consola). `Ctrl+C` cierra la sesión con la ECU (`82`) antes de salir.

La pestaña inicial se puede elegir en la URL: `#conn`, `#live`, `#dtc`, `#ecu`, `#log`.

---

## 📱 App web instalable (PWA)

La misma interfaz, pero el navegador se conecta **directo** al ELM327 con Web Serial: no hace falta la laptop ni el servidor. Funciona en **Chrome o Edge**: en escritorio, y en Android con un Chrome reciente que soporte Web Serial por Bluetooth. No funciona en Firefox, en iPhone ni dentro de otras apps.

1. Empareja el ELM327 en los ajustes de Bluetooth del dispositivo (PIN habitual `1234` o `0000`).
2. Abre la PWA y, en **Conexión**, elige «Elegir adaptador…» y pulsa **Conectar**. El navegador muestra la lista de adaptadores; elige el ELM327. La próxima vez aparece como «usado antes».
3. Para instalarla, usa la opción «Instalar app» o «Agregar a la pantalla principal» de Chrome. Después funciona sin internet.

**Probar en esta computadora** (localhost cuenta como contexto seguro, así que Web Serial funciona):

```bash
npm run pwa          # compila apps/pwa/dist y la sirve en http://localhost:5173
npm run pwa:build    # solo compila
```

En Windows, el ELM327 emparejado aparece en el selector como su puerto COM (el saliente, p. ej. COM6).

**Publicación:** el workflow [.github/workflows/pages.yml](.github/workflows/pages.yml) prueba el núcleo, compila y publica `apps/pwa/dist` en GitHub Pages en cada push a `main` que toque la PWA, la interfaz o el núcleo. La compilación no usa dependencias: copia la interfaz y el núcleo y resuelve los módulos con un *import map*.

Diferencias con el servidor: la sesión es de un solo dispositivo, y «Borrar códigos» pide confirmación pero no PIN.

---

## 📋 Opciones del Menú Interactiva

| Opción | Descripción |
| :--- | :--- |
| `1` | **Read All Sensors**: Lee y muestra los valores de todos los sensores configurados. |
| `2` - `9` | **Lectura Individual de Sensores**: RPM, velocidad, temperatura del motor, carga, acelerador, batería, nivel de gasolina y tiempo encendido. |
| `10` | **Read DTCs**: Busca códigos de error almacenados en la ECU. |
| `11` / `18`| **Clear DTCs**: Borra los fallos almacenados y apaga la luz MIL (Check Engine). |
| `12` | **Read VIN**: Recupera el número de chasis del vehículo. |
| `13` | **Send Custom Command**: Consola directa para ingresar cualquier comando OBD, KWP o comandos AT de configuración del integrado ELM327. |
| `14` | **Read Supported PIDs**: Muestra qué identificadores OBD2 estándar soporta la ECU. |
| `15` | **Scan ECU Services**: Verifica qué modos de servicio (OBD2/KWP/UDS) están activos. |
| `16` | **Read ECU Info (KWP 1A)**: Muestra información del hardware, software, proveedor y número de parte grabados en la ECU. |
| `17` | **Read KWP Data Blocks**: Muestra un volcado hexadecimal y decimal estructurado de los bloques de datos KWP en vivo. |
| `19` | **Guardar DTCs en HTML**: Genera un archivo `.html` auto-contenido con el diagnóstico detallado. |
| `20` | **Datos en tiempo real (monitor)**: Tablero que se actualiza en el mismo lugar (~3–4 lecturas/s en KWP) con valor, barra, mínimo y máximo de cada sensor. Opcionalmente graba un archivo `live_<fecha>.csv`. Se detiene con Enter; si se pierde la sesión, reconecta solo. |
| `0` | **Disconnect & Exit**: Cierra la sesión de diagnóstico, restablece el ELM327 a su modo por defecto (`ATZ`) y sale limpiamente. |

---

## 🔧 Detalles Técnicos de KWP2000 y el Perfil SIM2K-33

### El problema de los clones ELM327 v1.5
Con las cabeceras desactivadas (`ATH0`), los clones v1.5 **truncan las respuestas KWP que ocupan varias líneas**: al quitar las cabeceras de cada línea descartan también bytes de datos. Por eso el bloque `21 01` parecía tener longitud variable (9–35 bytes) y la respuesta del Servicio 18 perdía códigos de error.

La solución es trabajar con `ATH1` y desentramar nosotros cada mensaje ISO 14230 (`formato, destino, origen, [longitud], datos…, checksum`), validando el checksum. Con eso el bloque `21 01` mide siempre **78 bytes** y cada valor tiene una posición fija (ver `packages/core/src/ecu-profiles.js`, donde está documentado cómo se calibró cada campo).

### Sesión KWP y `BUS INIT: ERROR`
La ECU mantiene la sesión de diagnóstico abierta hasta que pasan ~5 s **sin tráfico** en la línea K. Si el ELM327 se reinicia (`ATZ`, cierre brusco de la app, corte del Bluetooth) mientras la sesión sigue abierta, todas las inicializaciones devuelven `BUS INIT: ERROR`, y reintentar de inmediato mantiene ocupado el bus, así que la ECU nunca cierra la sesión. La app espera 6 s en silencio antes de reintentar. Con el contacto apagado la ECU no responde a nada.

### Códigos específicos de GM-Wuling
Los códigos `P15xx` dependen del fabricante. La base de datos incluye las definiciones de Wuling (`P1535`, `P1536`, `P1545`). En particular, `P1535` (sensor de temperatura del evaporador del A/C, circuito abierto o en corto a +12 V) aparece de forma permanente en vehículos **sin A/C** cuya ECU está configurada para la versión con A/C.

---

## 📚 Documentación técnica

- [docs/ECU_SIM2K-33.md](docs/ECU_SIM2K-33.md): identificación de la ECU, servicios soportados (lectura y escritura), los 29 actuadores del servicio `30` con su función probable, plan de verificación y pendientes de investigación.
- [docs/PROYECTOS_FUTUROS.md](docs/PROYECTOS_FUTUROS.md): plan para separar el núcleo y crear las versiones de consola, servidor web en la laptop, PWA, app Android (teléfono y radio del auto) y un ESP32 conectado directo al OBD2 sin ELM327, con pros, contras y orden propuesto.

---

## 📄 Licencia

Este proyecto está bajo la Licencia ISC. Consúltalo en el archivo `package.json` para obtener más información.

**Creador:** edwinspire
