/**
 * UI language (Spanish / English). Independent from the alert voice language,
 * which stays in "Idioma de la voz" / "Voice language".
 *
 * Static HTML uses `data-i18n="key"` (and `data-i18n-title`, `data-i18n-aria`)
 * and is translated by applyStatic(). JavaScript strings call t('key', vars).
 * Changing the language fires `obd:lang` so open panels can re-render.
 */
export const LANGS = ['es', 'en'];

const KEY = 'obd.lang';
let lang = 'es';
try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) lang = saved;
} catch { /* ignore */ }

// [español, english]. {name} placeholders are filled by t().
const DICT = {
    // chrome / tabs
    'app.title': ['OBD2 Diagnóstico', 'OBD2 Diagnostics'],
    'status.disconnected': ['Desconectado', 'Disconnected'],
    'status.connecting': ['Conectando…', 'Connecting…'],
    'status.connected': ['Conectado', 'Connected'],
    'status.watch': ['Vigilando batería', 'Battery watch'],
    'status.reconnecting': ['Reconectando…', 'Reconnecting…'],
    'status.error': ['Error', 'Error'],
    'status.offline': ['Sin servidor', 'Server offline'],
    'tip.devices': ['Dispositivos conectados', 'Connected devices'],
    'tab.conn': ['Conexión', 'Connection'],
    'tab.live': ['Tiempo real', 'Live data'],
    'tab.charts': ['Gráficas', 'Charts'],
    'tab.dtc': ['Códigos', 'Codes'],
    'tab.ecu': ['ECU', 'ECU'],
    'tab.rec': ['Grabar', 'Record'],
    'tab.cfg': ['Ajustes', 'Settings'],
    'tab.log': ['Registro', 'Log'],
    'one.device': ['dispositivo', 'device'],
    'many.devices': ['dispositivos', 'devices'],

    // connection
    'conn.adapter': ['Adaptador ELM327', 'ELM327 adapter'],
    'conn.port': ['Puerto', 'Port'],
    'conn.refreshPorts': ['Actualizar puertos', 'Refresh ports'],
    'conn.noPorts': ['(sin puertos)', '(no ports)'],
    'conn.btOut': [' — probable ELM327', ' — likely ELM327'],
    'conn.btIn': [' — BT entrante', ' — incoming BT'],
    'conn.hintNew': ['Al conectar, el navegador te pedirá elegir el adaptador. Emparéjalo antes en los ajustes de Bluetooth (PIN 1234 o 0000).', 'On connect, the browser will ask you to pick the adapter. Pair it first in Bluetooth settings (PIN 1234 or 0000).'],
    'conn.hintOut': ['Bluetooth saliente {mac}: este es normalmente el ELM327.', 'Outgoing Bluetooth {mac}: this is normally the ELM327.'],
    'conn.hintIn': ['Puerto Bluetooth entrante: normalmente NO responde. Elige el saliente.', 'Incoming Bluetooth port: it normally does NOT answer. Choose the outgoing one.'],
    'conn.esp32': ['Buscar o cambiar el adaptador, claves y red Wi-Fi: ', 'Find or change the adapter, keys and Wi-Fi network: '],
    'conn.esp32Link': ['Ajustes del ESP32', 'ESP32 settings'],
    'conn.unsupported': ['Este navegador no soporta Web Serial. Abre esta página en Chrome o Edge (en Android, Chrome actualizado) y empareja antes el ELM327 en los ajustes de Bluetooth.', 'This browser does not support Web Serial. Open this page in Chrome or Edge (updated Chrome on Android) and pair the ELM327 in Bluetooth settings first.'],
    'conn.profile': ['Perfil de ECU', 'ECU profile'],
    'conn.autoProfile': ['Detección automática', 'Automatic detection'],
    'conn.connect': ['Conectar', 'Connect'],
    'conn.disconnect': ['Desconectar', 'Disconnect'],
    'conn.connected': ['Conectado', 'Connected'],
    'conn.watchBattery': ['Vigilar batería (contacto apagado)', 'Watch battery (ignition off)'],
    'conn.watchBatteryDone': ['Vigilando la batería cada 30 s', 'Watching the battery every 30 s'],
    'conn.watchHint': ['Vigilar batería mide solo el voltaje con el ELM327 cada 30 s, sin hablar con la ECU, y avisa si baja del umbral. El ELM327 conectado también consume batería.', 'Battery watch reads voltage only with the ELM327 every 30 s, without talking to the ECU, and warns below the threshold. A connected ELM327 also drains the battery.'],
    'conn.session': ['Sesión', 'Session'],
    'conn.state': ['Estado', 'Status'],
    'conn.adapter2': ['Adaptador', 'Adapter'],
    'conn.protocol': ['Protocolo', 'Protocol'],
    'conn.profile2': ['Perfil', 'Profile'],
    'conn.battery': ['Batería (ATRV)', 'Battery (ATRV)'],
    'conn.reconnecting': ['Reconectando automáticamente (intento {n}{when})', 'Automatically reconnecting (attempt {n}{when})'],
    'conn.reconnectNext': [', en {n} s', ', in {n} s'],
    'conn.reconnectTrying': [', probando…', ', trying…'],
    'conn.reconnectLost': ['Se perdió la conexión', 'Connection lost'],
    'conn.reconnectHint': ['. Reintentando solo; «Desconectar» lo cancela.', '. Retrying automatically; "Disconnect" cancels it.'],
    'conn.noData': ['Sin datos nuevos hace {n} s · {why}…', 'No new data for {n} s · {why}…'],
    'conn.whyReconnect': ['reconectando', 'reconnecting'],
    'conn.whyRecover': ['recuperando la comunicación', 'recovering communication'],
    'conn.sessionShared': ['Pon el contacto en ON antes de conectar. La conexión es compartida: todos los dispositivos ven la misma sesión.', 'Turn the ignition ON before connecting. The session is shared: every device sees the same session.'],
    'conn.sessionEsp32': ['Pon el contacto en ON antes de conectar. El ESP32 mantiene el Bluetooth con el ELM327; un solo dispositivo a la vez maneja el adaptador (si otro se conecta, toma el control).', 'Turn the ignition ON before connecting. The ESP32 keeps Bluetooth with the ELM327; only one device controls the adapter at a time (a new device takes over).'],
    'conn.sessionDirect': ['Pon el contacto en ON antes de conectar. Este dispositivo se conecta directo al ELM327.', 'Turn the ignition ON before connecting. This device connects directly to the ELM327.'],
    'mode.kwp2000': ['KWP2000 (ISO 14230)', 'KWP2000 (ISO 14230)'],
    'mode.obd2': ['OBD2 estándar', 'Standard OBD2'],
    'mode.unknown': ['sin respuesta', 'no response'],

    // live
    'live.start': ['Iniciar', 'Start'],
    'live.stop': ['Detener', 'Stop'],
    'live.dash': ['Tablero', 'Dashboard'],
    'live.record': ['Grabar', 'Record'],
    'live.recording': ['● Grabando ({n})', '● Recording ({n})'],
    'live.empty': ['Conéctate e inicia el tiempo real para ver los sensores.', 'Connect and start live data to see the sensors.'],
    'live.raw': ['Bytes crudos', 'Raw bytes'],
    'live.readings': ['{src} · {hz} lecturas/s', '{src} · {hz} readings/s'],
    'live.unconfirmed': ['sin confirmar', 'unconfirmed'],
    'live.minmax': ['mín {min} · máx {max}', 'min {min} · max {max}'],
    'live.sourceEcu': ['ECU', 'ECU'],
    'live.sourceGps': ['GPS', 'GPS'],
    'live.speedEcu': ['Velocidad (ECU)', 'Speed (ECU)'],
    'live.speedGps': ['Velocidad (GPS)', 'Speed (GPS)'],
    'live.noSpeed': ['sin dato de velocidad', 'no speed data'],

    // charts
    'charts.window': ['Ventana', 'Window'],
    'charts.clear': ['Limpiar', 'Clear'],
    'charts.liveMode': ['Tiempo real', 'Live data'],
    'charts.loadCsv': ['Cargar CSV', 'Load CSV'],
    'charts.fromTrip': ['Grabación guardada', 'Saved recording'],
    'charts.selectTrip': ['Elegir grabación…', 'Choose recording…'],
    'charts.empty': ['Conéctate e inicia el tiempo real para ver la evolución de los sensores.', 'Connect and start live data to see how the sensors evolve.'],
    'charts.hint': ['«Iniciar» muestra los datos en tiempo real. «Cargar CSV» o una grabación guardada muestran el histórico; «Tiempo real» o «Limpiar» vuelven a las muestras en vivo. El color de la traza indica la zona: azul (frío), verde (normal), ámbar (cerca del máximo) y rojo (peligro).', '\"Start\" shows live data. \"Load CSV\" or a saved recording show history; \"Live data\" or \"Clear\" return to live samples. Line colour shows the zone: blue (cold), green (normal), amber (near maximum) and red (danger).'],
    'charts.hintHistory': ['Modo histórico: {name}. Se muestran todas las muestras del archivo con sus fechas reales. «Limpiar» vuelve al tiempo real.', 'History mode: {name}. All samples are shown with their real timestamps. "Clear" returns to live data.'],
    'charts.info': ['{n} s de histórico · {c} sensores', '{n} s of history · {c} sensors'],
    'charts.infoHistory': ['{c} sensores · {n} muestras', '{c} sensors · {n} samples'],
    'charts.stopped': ['Tiempo real detenido. El histórico se conserva hasta que lo limpies.', 'Live data stopped. History is kept until you clear it.'],
    'charts.noData': ['sin datos', 'no data'],
    'charts.timeAxis': ['tiempo (s) → 0', 'time (s) → 0'],
    'charts.timeAxisHistory': ['fecha y hora →', 'date and time →'],
    'charts.badCsv': ['CSV no válido: no se encontraron muestras de sensores.', 'Invalid CSV: no sensor samples found.'],

    // codes, ECU
    'dtc.read': ['Leer códigos', 'Read codes'],
    'dtc.report': ['Reporte HTML', 'HTML report'],
    'dtc.clear': ['Borrar códigos', 'Clear codes'],
    'dtc.readAt': ['Leído a las {t}{src}', 'Read at {t}{src}'],
    'dtc.prompt': ['Toca «Leer códigos» con el vehículo conectado.', 'Press "Read codes" with the vehicle connected.'],
    'dtc.none': ['Sin códigos de error.', 'No trouble codes.'],
    'dtc.unknown': ['Código sin descripción en la base de datos', 'Code not found in the database'],
    'dtc.present': ['presente ahora', 'present now'],
    'dtc.stored': ['memorizado', 'stored'],
    'dtc.mil': ['MIL encendida', 'MIL on'],
    'dtc.explain': ['Explicación y soluciones', 'Explanation and solutions'],
    'dtc.causes': ['Causas comunes', 'Common causes'],
    'dtc.check': ['Qué revisar', 'What to check'],
    'dtc.risks': ['Riesgos', 'Risks'],
    'dtc.clearDisabled': ['Borrar códigos está deshabilitado: inicia el servidor con --pin para habilitarlo.', 'Clearing codes is disabled: start the server with --pin to enable it.'],
    'dtc.clearPin': ['Borrar códigos pide el PIN del servidor y solo funciona con el motor apagado.', 'Clearing codes asks for the server PIN and only works with the engine off.'],
    'dtc.clearConfirm': ['Borrar códigos pide confirmación y solo funciona con el motor apagado.', 'Clearing codes asks for confirmation and only works with the engine off.'],
    'dtc.dlgTitle': ['Borrar códigos de error', 'Clear trouble codes'],
    'dtc.dlgText': ['Se enviará a la ECU la orden de borrar todos los códigos memorizados.', 'The ECU will be told to clear all stored codes.'],
    'dtc.dlg1': ['Motor apagado y contacto en ON. Si el motor está en marcha, se rechaza.', 'Engine off and ignition ON. If the engine is running, the request is rejected.'],
    'dtc.dlg2': ['Los códigos memorizados se pierden. Guarda antes el reporte HTML si los necesitas.', 'Stored codes are lost. Save the HTML report first if needed.'],
    'dtc.dlg3': ['Si la falla sigue presente, el código vuelve cuando la ECU lo detecta de nuevo, normalmente con el motor en marcha. En este auto se espera que P1535 vuelva, porque no tiene A/C.', 'If the fault is still present, the code returns when the ECU detects it again, usually with the engine running. On this car P1535 is expected to return because it has no A/C.'],
    'dtc.pin': ['PIN', 'PIN'],
    'dtc.cancel': ['Cancelar', 'Cancel'],
    'dtc.delete': ['Borrar', 'Clear'],
    'dtc.deleting': ['Borrando…', 'Clearing…'],
    'dtc.deleted': ['Códigos borrados. Sin códigos.', 'Codes cleared. No codes.'],
    'dtc.cameBack': ['Códigos borrados. Volvió a aparecer: {codes}', 'Codes cleared. Came back: {codes}'],
    'dtc.notConfirmed': ['La ECU no confirmó el borrado', 'The ECU did not confirm clearing'],
    'ecu.read': ['Leer identificación', 'Read identification'],
    'ecu.readAt': ['Leído a las {t}', 'Read at {t}'],
    'ecu.prompt': ['Toca «Leer identificación».', 'Press "Read identification".'],
    'ecu.noInfo': ['La ECU no devolvió identificación.', 'The ECU returned no identification.'],
    'ecu.notProgrammed': ['sin programar', 'not programmed'],
    'ecu.profile': ['Perfil', 'Profile'],

    // recording
    'rec.title': ['Grabación de datos', 'Data recording'],
    'rec.hint': ['Guarda todos los sensores, el bloque crudo de la ECU, las alertas, los códigos y los cortes de comunicación, y el GPS si está disponible. Después descargas cada grabación como CSV.', 'Stores all sensors, the raw ECU block, alerts, codes and communication drops, plus GPS when available. Each recording can then be downloaded as CSV.'],
    'rec.unsupported': ['Este navegador no permite guardar datos localmente.', 'This browser cannot store data locally.'],
    'rec.rate': ['Muestreo', 'Sampling'],
    'rec.rateAll': ['Todas las muestras', 'Every sample'],
    'rec.rate1s': ['1 muestra por segundo', '1 sample per second'],
    'rec.gps': ['Incluir GPS (velocidad, rumbo, altitud)', 'Include GPS (speed, heading, altitude)'],
    'rec.coords': ['Incluir coordenadas', 'Include coordinates'],
    'rec.start': ['Iniciar grabación', 'Start recording'],
    'rec.stop': ['Detener grabación', 'Stop recording'],
    'rec.idle': ['Sin grabación en curso.', 'No recording in progress.'],
    'rec.active': ['Grabando · {dur} · {n} muestras{gps}{ev}{spikes}', 'Recording · {dur} · {n} samples{gps}{ev}{spikes}'],
    'rec.gpsCount': [' · {n} con GPS', ' · {n} with GPS'],
    'rec.events': [' · {n} eventos', ' · {n} events'],
    'rec.spikes': [' · ⚠ {n} picos de velocidad', ' · ⚠ {n} speed spikes'],
    'rec.list': ['Grabaciones', 'Recordings'],
    'rec.refresh': ['Actualizar', 'Refresh'],
    'rec.empty': ['Todavía no hay grabaciones.', 'No recordings yet.'],
    'rec.delete': ['Borrar', 'Delete'],
    'rec.confirmDelete': ['¿Borrar esta grabación? No se puede deshacer.', 'Delete this recording? This cannot be undone.'],
    'rec.pinPrompt': ['PIN del servidor', 'Server PIN'],
    'rec.deleted': ['Grabación borrada', 'Recording deleted'],
    'rec.saved': ['Grabación guardada: {n} muestras, {dur}', 'Recording saved: {n} samples, {dur}'],
    'rec.stopped': ['Grabación detenida', 'Recording stopped'],
    'rec.interrupted': ['interrumpida', 'interrupted'],
    'rec.recordingTag': ['grabando', 'recording'],
    'rec.whereServer': ['Graba el servidor en la carpeta logs/ del portátil, aunque cierres el navegador. Cualquier dispositivo de la red puede iniciarla, detenerla y descargarla. No incluye GPS (los navegadores solo dan la ubicación por HTTPS).', 'The server records to the logs/ folder on the laptop, even if you close the browser. Any device on the network can start, stop and download it. No GPS (browsers only provide location over HTTPS).'],
    'rec.whereLocal': ['Graba este dispositivo en el almacenamiento del navegador; se guarda cada {s} s, así que sobrevive a un cierre inesperado. Mantén la app abierta y en primer plano: si el teléfono la suspende, la lectura del ELM327 se detiene.', 'Records on this device in browser storage, saved every {s} s so it survives an unexpected close. Keep the app open and in the foreground: if the phone suspends it, ELM327 reading stops.'],
    'rec.whereNoGps': [' El GPS solo está disponible en la PWA publicada (HTTPS).', ' GPS is only available in the published PWA (HTTPS).'],
    'rec.started': ['Grabando. Los sensores se registran cuando haya conexión y tiempo real.', 'Recording. Sensors are logged once connected and live data is running.'],
    'rec.already': ['Ya hay una grabación en curso', 'A recording is already in progress'],
    'rec.gpsDenied': ['permiso de ubicación denegado', 'location permission denied'],
    'rec.gpsNoSignal': ['sin señal', 'no signal'],
    'rec.gpsTimeout': ['sin señal (tiempo agotado)', 'no signal (timed out)'],
    'rec.gpsRecovered': ['GPS recuperado', 'GPS recovered'],
    'rec.gpsProblem': ['GPS {msg}', 'GPS: {msg}'],
    'rec.logStart': ['Grabación iniciada: {id}', 'Recording started: {id}'],
    'rec.logStop': ['Grabación detenida: {id} ({n} muestras)', 'Recording stopped: {id} ({n} samples)'],
    'rec.storage': ['Espacio usado por esta app: {used} de {quota} disponibles.', 'Storage used by this app: {used} of {quota} available.'],

    // settings: sound, alerts, calibration, display
    'cfg.sound': ['Sonido y avisos', 'Sound and alerts'],
    'cfg.soundMode': ['Sonido de las alertas', 'Alert sound'],
    'cfg.soundVoice': ['Pitidos + voz', 'Beeps + voice'],
    'cfg.soundBeep': ['Solo pitidos', 'Beeps only'],
    'cfg.soundOff': ['Silencio', 'Silent'],
    'cfg.voiceLang': ['Idioma de la voz', 'Voice language'],
    'cfg.uiLang': ['Idioma de la interfaz', 'Interface language'],
    'cfg.spanish': ['Español', 'Spanish'],
    'cfg.english': ['English', 'English'],
    'cfg.volume': ['Volumen', 'Volume'],
    'cfg.soundTest': ['Probar sonido', 'Test sound'],
    'cfg.notify': ['Permitir notificaciones', 'Allow notifications'],
    'cfg.notifyOn': ['Notificaciones permitidas', 'Notifications allowed'],
    'cfg.notifyOff': ['Notificaciones bloqueadas', 'Notifications blocked'],
    'cfg.notifyNA': ['Notificaciones no disponibles', 'Notifications unavailable'],
    'cfg.wake': ['Mantener la pantalla encendida durante el tiempo real', 'Keep the screen on during live data'],
    'cfg.soundHint': ['El navegador solo permite sonido después de tocar la página: cualquier toque lo activa.', 'Browsers only allow sound after you interact with the page: any tap enables it.'],
    'cfg.soundUnlocked': ['Sonido activado en este dispositivo.', 'Sound enabled on this device.'],
    'cfg.soundTestVoice': ['Se reprodujo la voz grabada.', 'Recorded voice played.'],
    'cfg.soundTestTts': ['No se pudo cargar el audio grabado; se usó la voz del navegador.', 'Recorded audio unavailable; browser speech synthesis was used.'],
    'cfg.soundTestBeep': ['Solo pitidos (sin voz disponible o modo «Solo pitidos»).', 'Beeps only (no voice available or "Beeps only" mode).'],
    'cfg.soundTestOff': ['El sonido está en silencio.', 'Sound is muted.'],
    'cfg.alerts': ['Alertas', 'Alerts'],
    'cfg.alertsReset': ['Restaurar valores', 'Restore defaults'],
    'cfg.alertsHint': ['Cada dispositivo guarda sus propios umbrales. Las alertas se evalúan con cada lectura en tiempo real.', 'Each device stores its own thresholds. Alerts are checked on every live reading.'],
    'cfg.resetDone': ['Umbrales restaurados', 'Thresholds restored'],
    'cfg.test': ['Probar', 'Test'],
    'cfg.sevInfo': ['informativa', 'informational'],
    'cfg.sevWarning': ['advertencia', 'warning'],
    'cfg.sevCritical': ['crítica', 'critical'],
    'cfg.sevOverheat': ['advertencia / crítica', 'warning / critical'],
    'cfg.enabled': ['activada', 'enabled'],
    'cfg.calTitle': ['Calibración de velocidad (GPS)', 'Speed calibration (GPS)'],
    'cfg.calHint': ['Compara la velocidad de la ECU con la del GPS del teléfono mientras conduces y genera un archivo para ajustar la escala. Necesita la PWA (HTTPS), el tiempo real activo y permiso de ubicación. Conduce a velocidades variadas y estables; la pantalla se mantiene encendida.', 'Compare ECU speed with phone GPS speed while driving and export a file to adjust the scale. Needs the PWA (HTTPS), active live data and location permission. Drive at varied, steady speeds; the screen stays on.'],
    'cfg.calUnsupported': ['La ubicación GPS solo está disponible en la PWA publicada (HTTPS) o en localhost. Desde el servidor de la red local no funciona.', 'GPS location is only available in the published PWA (HTTPS) or on localhost. It does not work from the local network server.'],
    'cfg.calStart': ['Iniciar calibración', 'Start calibration'],
    'cfg.calStop': ['Detener calibración', 'Stop calibration'],
    'cfg.calDownload': ['Descargar CSV', 'Download CSV'],
    'cfg.calCoords': ['Incluir coordenadas en el archivo', 'Include coordinates in the file'],
    'cfg.calGps': ['GPS', 'GPS'],
    'cfg.calEcu': ['ECU', 'ECU'],
    'cfg.calRatio': ['Proporción GPS / ECU', 'GPS / ECU ratio'],
    'cfg.calAcc': ['Precisión GPS', 'GPS accuracy'],
    'cfg.calPoints': ['Puntos', 'Points'],
    'cfg.calFit': ['Ajuste actual', 'Current fit'],
    'cfg.calConnect': ['Conéctate al vehículo primero', 'Connect to the vehicle first'],
    'cfg.calStopped': ['Calibración detenida: {n} puntos', 'Calibration stopped: {n} points'],
    'cfg.calStarted': ['Calibración de velocidad iniciada (GPS)', 'Speed calibration started (GPS)'],
    'cfg.calLost': ['Calibración detenida: se perdió la conexión', 'Calibration stopped: connection lost'],
    'cfg.calValid': ['{n} ({v} válidos, {u} usados{o})', '{n} ({v} valid, {u} used{o})'],
    'cfg.calOutliers': [', {n} atípicos', ', {n} outliers'],
    'cfg.calNoSpeed': ['sin velocidad (calculada {n} km/h)', 'no speed (calculated {n} km/h)'],
    'cfg.calNeed': ['faltan puntos válidos (precisión ≤ 20 m y ≥ 5 km/h)', 'need valid points (accuracy ≤ 20 m and ≥ 5 km/h)'],
    'cfg.sensors': ['Sensores visibles y escalas', 'Visible sensors and ranges'],
    'cfg.sensorsHint': ['Elige qué sensores aparecen en Tiempo real y Gráficas y ajusta la escala y las zonas de color a tu vehículo. Velocidad por defecto: 0–150 km/h. Los umbrales de Alertas también Influyen en el color.', 'Choose which sensors appear in Live data and Charts and adjust the scale and colour zones for your vehicle. Default speed: 0–150 km/h. Alert thresholds also affect the colour.'],
    'cfg.sensorsReset': ['Restaurar sensores', 'Restore sensors'],
    'cfg.visible': ['Visible', 'Visible'],
    'cfg.min': ['Mín', 'Min'],
    'cfg.max': ['Máx', 'Max'],
    'cfg.ok': ['Normal desde', 'Normal from'],
    'cfg.warn': ['Aviso desde', 'Warning from'],
    'cfg.bad': ['Peligro desde', 'Danger from'],
    'cfg.lowWarn': ['Aviso bajo', 'Low warning'],
    'cfg.lowBad': ['Peligro bajo', 'Low danger'],
    'cfg.sensorsResetDone': ['Sensores restaurados', 'Sensors restored'],

    // log / misc
    'log.alertClear': ['Alerta despejada: {t}', 'Alert cleared: {t}'],
    'log.alert': ['ALERTA {sev}: {t}. {m}', 'ALERT {sev}: {t}. {m}'],
    'alert.ack': ['Entendido', 'Got it'],
    'toast.ok': ['Aceptar', 'OK'],
};

export const getLang = () => lang;

export function t(key, vars) {
    const entry = DICT[key];
    let text = entry ? entry[lang === 'en' ? 1 : 0] : key;
    if (vars) text = text.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
    return text;
}

export function setLang(next) {
    const value = LANGS.includes(next) ? next : 'es';
    if (value === lang) return;
    lang = value;
    try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
    if (typeof document !== 'undefined') {
        document.documentElement.lang = lang;
        applyStatic();
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('obd:lang', { detail: { lang } }));
}

export function onLang(fn) {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener('obd:lang', fn);
    return () => window.removeEventListener('obd:lang', fn);
}

/** Translate every element marked with data-i18n in the document. */
export function applyStatic(root = document) {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = lang;
    document.title = t('app.title');
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
}
