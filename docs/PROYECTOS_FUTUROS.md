# Proyectos a futuro: núcleo compartido y varias versiones

Plan para llevar la aplicación de consola actual a otras plataformas (servidor web en la laptop, PWA y app Android) sin rehacer el protocolo, que es la parte ya probada con el vehículo (ver [ECU_SIM2K-33.md](ECU_SIM2K-33.md)).

- **Estado:** propuesta, nada implementado todavía.
- **Fecha:** 2026-11-20.

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
| `obd-server` | servidor HTTP + WebSocket en la laptop | `serialport` (COM6) |
| `obd-pwa` | la interfaz publicada en HTTPS, instalable | Web Serial (Chrome) |
| `obd-android` | la interfaz empaquetada como APK (teléfono y radio del auto) | plugin nativo Bluetooth SPP (y USB opcional) |
| `obd-ui` | pantallas web compartidas: DTCs, tablero en tiempo real, ECU, exportación | ninguno: habla con el core o con el servidor |

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
| CSV y reportes quedan en la laptop | Por `http://` en la red local no se instala como PWA completa (requiere HTTPS) |
| Se puede probar con el auto desde la laptop de desarrollo | Hay que definir quién tiene el control cuando varios piden comandos |

### 4.3 `obd-pwa`: app web instalable (Chrome Android con Web Serial)
La interfaz publicada en HTTPS (p. ej. GitHub Pages) que se conecta directo al ELM327 emparejado en el teléfono.

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

---

## 5. Orden propuesto

1. **Core.** Crear el monorepo y mover el núcleo a `packages/core` con el contrato de transporte, y `index.js` a `apps/cli`.
   - **Criterio de aceptación:** la consola se comporta igual que hoy, probada con el auto (DTCs, opción 20, info de la ECU).
   - Añadir el transporte simulado con respuestas grabadas para pruebas sin el vehículo.
2. **`obd-ui` + `obd-server`.** Funciona con lo ya probado y deja lista la interfaz para el resto.
3. **`obd-pwa`.** Misma interfaz con el transporte Web Serial; probar en el teléfono (`chrome://version` ≥ 137).
4. **`obd-android`.** Capacitor + plugin Bluetooth serie; probar en el teléfono y luego en el radio.

Cada paso es usable por sí solo; si uno no da resultado (p. ej. Web Serial en Android), se salta al siguiente sin perder lo anterior.

---

## 6. Riesgos y decisiones pendientes

- [ ] **Repositorio:** monorepo (recomendado) o repositorios separados.
- [ ] **Framework de `obd-ui`:** JavaScript sin framework o Svelte.
- [ ] **Web Serial sobre Bluetooth en Android:** confirmar con el teléfono real antes de invertir en la PWA.
- [ ] **Plugin Bluetooth para Capacitor:** elegir uno mantenido que soporte SPP clásico (no solo BLE).
- [ ] **Radio del auto:** versión de Android y si permite emparejar el ELM327.
- [ ] **Seguridad en `obd-server`:** PIN para acciones de escritura (`14` borrar DTCs) y modo solo lectura para los demás clientes.
- [ ] **Ciclo de vida de la sesión KWP en móviles:** enviar `82` al cerrar y respetar los ~6 s de silencio antes de reconectar (ver [ECU_SIM2K-33.md](ECU_SIM2K-33.md)), sobre todo cuando Android suspende la app.
