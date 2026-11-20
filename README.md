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

El código está estructurado de manera modular y limpia:

- 📄 [**index.js**](file:///d:/edwinspire/OtrosProyectos/OBDII_cli/index.js): Punto de entrada principal que ejecuta la aplicación en Node.js.
- 📁 **src/**
  - 📄 [**index.js**](file:///d:/edwinspire/OtrosProyectos/OBDII_cli/src/index.js): Bucle interactivo de la interfaz CLI, menús de usuario y presentación de datos con colores ANSI.
  - 📄 [**elm327.js**](file:///d:/edwinspire/OtrosProyectos/OBDII_cli/src/elm327.js): Motor del protocolo ELM327. Administra colas de comandos, buffers de lectura de puerto serie, reinicios y rutinas de auto-recuperación.
  - 📄 [**bluetooth.js**](file:///d:/edwinspire/OtrosProyectos/OBDII_cli/src/bluetooth.js): Módulo de comunicación física; envuelve a la biblioteca `serialport` para buscar y abrir conexiones.
  - 📄 [**ecu-profiles.js**](file:///d:/edwinspire/OtrosProyectos/OBDII_cli/src/ecu-profiles.js): Contiene la configuración de perfiles (como la ECU SIM2K-33) y las fórmulas de decodificación de bloques de datos KWP.
  - 📄 [**obd2-commands.js**](file:///d:/edwinspire/OtrosProyectos/OBDII_cli/src/obd2-commands.js): Definición de comandos estándar OBD2, PIDs y sus respectivas ecuaciones de conversión.
  - 📄 [**dtc-database.js**](file:///d:/edwinspire/OtrosProyectos/OBDII_cli/src/dtc-database.js): Base de datos de códigos de diagnóstico y la plantilla generadora del reporte visual HTML en español.

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

La solución es trabajar con `ATH1` y desentramar nosotros cada mensaje ISO 14230 (`formato, destino, origen, [longitud], datos…, checksum`), validando el checksum. Con eso el bloque `21 01` mide siempre **78 bytes** y cada valor tiene una posición fija (ver `src/ecu-profiles.js`, donde está documentado cómo se calibró cada campo).

### Sesión KWP y `BUS INIT: ERROR`
La ECU mantiene la sesión de diagnóstico abierta hasta que pasan ~5 s **sin tráfico** en la línea K. Si el ELM327 se reinicia (`ATZ`, cierre brusco de la app, corte del Bluetooth) mientras la sesión sigue abierta, todas las inicializaciones devuelven `BUS INIT: ERROR`, y reintentar de inmediato mantiene ocupado el bus, así que la ECU nunca cierra la sesión. La app espera 6 s en silencio antes de reintentar. Con el contacto apagado la ECU no responde a nada.

### Códigos específicos de GM-Wuling
Los códigos `P15xx` dependen del fabricante. La base de datos incluye las definiciones de Wuling (`P1535`, `P1536`, `P1545`). En particular, `P1535` (sensor de temperatura del evaporador del A/C, circuito abierto o en corto a +12 V) aparece de forma permanente en vehículos **sin A/C** cuya ECU está configurada para la versión con A/C.

---

## 📚 Documentación técnica

- [docs/ECU_SIM2K-33.md](docs/ECU_SIM2K-33.md): identificación de la ECU, servicios soportados (lectura y escritura), los 29 actuadores del servicio `30` con su función probable, plan de verificación y pendientes de investigación.
- [docs/PROYECTOS_FUTUROS.md](docs/PROYECTOS_FUTUROS.md): plan para separar el núcleo y crear las versiones de consola, servidor web en la laptop, PWA y app Android (teléfono y radio del auto), con pros, contras y orden propuesto.

---

## 📄 Licencia

Este proyecto está bajo la Licencia ISC. Consúltalo en el archivo `package.json` para obtener más información.

**Creador:** edwinspire
