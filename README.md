# OBD2 ELM327 Bluetooth Scanner 🚗🔧

Una aplicación interactiva en línea de comandos (CLI) desarrollada en **Node.js** para realizar diagnósticos vehiculares en tiempo real utilizando un adaptador ELM327 Bluetooth. Soporta tanto el protocolo estándar **OBD2** (Mode 01-0A) como el protocolo **KWP2000** (ISO 14230-4) mediante inicializaciones específicas y perfiles de ECU optimizados.

---

## 🌟 Características Principales

- **Conexión Serial/COM:** Detección automática y selección interactiva de los puertos serie y COM (Bluetooth SPP).
- **Soporte KWP2000 Completo:**
  - Inicialización rápida (Fast Init, `ATSP5`) e inicialización de 5 baudios (`ATSP4`).
  - Direccionamiento físico de ECU configurable mediante cabeceras personalizadas (Headers).
  - Envío automático y en segundo plano de la señal **Tester Present** (`3E`) para mantener activa la sesión de diagnóstico.
- **Perfiles de ECU Personalizados:**
  - Incluye un perfil preconfigurado para la ECU **Siemens VDO SIM2K-33** (motor de gasolina SAIC Wuling 2008), con cabeceras `81 11 F1` y sesiones de diagnóstico avanzadas.
  - Decodificación inteligente basada en patrones de anclaje dinámicos para lidiar con respuestas de longitud variable de clones ELM327 v1.5.
- **Lectura y Decodificación de Sensores:**
  - Lectura en tiempo real de RPM del motor, velocidad del vehículo, temperatura del refrigerante, carga del motor, posición de la mariposa, voltaje de la batería, nivel de combustible y tiempo de funcionamiento del motor.
  - Modo KWP de lectura de bloques de datos primarios y secundarios.
- **Gestión Avanzada de DTCs (Códigos de Error):**
  - Lectura mediante el Modo 03 estándar de OBD2 o a través de los Servicios KWP2000 18 (lectura por máscara de estado), 13 y 17.
  - Borrado seguro de códigos de error (Modo 04 de OBD2 o Servicio KWP 14).
  - **Base de Datos Local en Español:** Identifica la causa, explicación, soluciones recomendadas y riesgos asociados de cada código.
  - **Generación de Reportes HTML:** Exporta un reporte visual interactivo y auto-contenido con los fallos detectados y sus guías de reparación paso a paso.
- **Robustez y Auto-Recuperación:**
  - Sistema inteligente de recuperación ante fallos de conexión común como `BUS INIT: ERROR`.
  - Intenta automáticamente re-inicializar el canal y aplicar reinicios por hardware/software (`ATZ`) al ELM327 para continuar con el diagnóstico sin interrumpir la experiencia.
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
3. **Selección del Puerto COM:** La aplicación listará los puertos seriales detectados. Selecciona el número correspondiente a tu adaptador Bluetooth emparejado.
4. **Inicialización:**
   - La aplicación detectará el protocolo del coche automáticamente.
   - Si la ECU requiere configuraciones especiales (como KWP2000), el motor intentará asociar un perfil predefinido o probará diferentes cabeceras físicas.
5. **Menú Interactivo:** Utiliza las opciones numéricas del `0` al `19` para interactuar con los sistemas del vehículo.

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
| `0` | **Disconnect & Exit**: Cierra la sesión de diagnóstico, restablece el ELM327 a su modo por defecto (`ATZ`) y sale limpiamente. |

---

## 🔧 Detalles Técnicos de KWP2000 y el Perfil SIM2K-33

### El Desafío de los Clones ELM327 v1.5
Muchos adaptadores baratos en el mercado (clones v1.5) no siguen el estándar estricto al procesar respuestas del protocolo ISO 14230-4 (KWP2000). En la ECU **Siemens VDO SIM2K-33**, las lecturas del bloque `21 01` (Primary Engine Data) cambian constantemente de tamaño (variando entre 9, 21, 25 y hasta 35 bytes). Esto causa que las posiciones de los bytes se desplacen y los decodificadores tradicionales fallen.

### Nuestra Solución: Decodificación por Patrón de Anclaje
Para resolver este problema, en `src/ecu-profiles.js` implementamos un algoritmo que busca un **patrón de anclaje constante (`52 03 FF 00`)** dentro del flujo de bytes retornado. Una vez localizado el patrón en memoria, calculamos las posiciones de manera relativa a él:
- **RPM reales del motor:** 2 bytes inmediatamente anteriores al ancla (en formato Little-Endian).
- **RPM objetivo de ralentí:** Los 2 primeros bytes del ancla (`03 52` equivalente a 850 RPM).
- **Temperatura del refrigerante (ECT):** 7 bytes adelante del ancla.

Este enfoque asegura lecturas 100% estables e inmunes al desajuste de longitud del buffer del chip clonado.

---

## 📄 Licencia

Este proyecto está bajo la Licencia ISC. Consúltalo en el archivo `package.json` para obtener más información.

**Creador:** edwinspire
