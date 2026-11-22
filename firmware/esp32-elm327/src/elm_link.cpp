#include "elm_link.h"

#include <BluetoothSerial.h>

#include "config.h"
#include "events.h"
#include "obd_text.h"
#include "kwp_decode.h"

#if BUZZER_PIN > 0
#include <Arduino.h>
#endif

#if !defined(CONFIG_BT_ENABLED) || !defined(CONFIG_BLUEDROID_ENABLED)
#error "Bluetooth Classic is not enabled: use a classic ESP32 (WROOM-32 / WROVER), not S2/S3/C3/C6."
#endif

ElmLink elm;
static BluetoothSerial SerialBT;

const char* btStateName(BtState s) {
    switch (s) {
        case BtState::Off: return "off";
        case BtState::Idle: return "idle";
        case BtState::Scanning: return "scanning";
        case BtState::Connecting: return "connecting";
        case BtState::Connected: return "connected";
        case BtState::Error: return "error";
    }
    return "?";
}

static bool parseMac(const String& mac, uint8_t out[6]) {
    if (mac.length() != 17) return false;
    for (int i = 0; i < 6; i++) {
        const String part = mac.substring(i * 3, i * 3 + 2);
        if (!isxdigit(part[0]) || !isxdigit(part[1])) return false;
        if (i < 5 && mac[i * 3 + 2] != ':') return false;
        out[i] = static_cast<uint8_t>(strtol(part.c_str(), nullptr, 16));
    }
    return true;
}

static bool looksLikeElm(const String& name) {
    String n = name;
    n.toUpperCase();
    static const char* hints[] = {"OBD", "ELM", "V-LINK", "VLINK", "VGATE", "KONNWEI", "ICAR", "SCAN"};
    for (auto* h : hints) if (n.indexOf(h) >= 0) return true;
    return false;
}

template <typename F>
void ElmLink::update(F fn) {
    xSemaphoreTake(mtx_, portMAX_DELAY);
    fn(st_);
    xSemaphoreGive(mtx_);
    bus.stateChanged();
}

void ElmLink::setBt(BtState s, const String& error) {
    update([&](ElmStatus& st) {
        st.bt = s;
        st.error = error;
        if (s != BtState::Connected) { st.elmReady = false; st.ecu = "sin probar"; }
    });
    // Update LED feedback
    if (BT_STATUS_LED_PIN && ledEnabled_) {
        switch (s) {
            case BtState::Connecting:
                // Fast blink while connecting
                for (int i = 0; i < 3; i++) {
                    digitalWrite(BT_STATUS_LED_PIN, LOW);
                    delay(50);
                    digitalWrite(BT_STATUS_LED_PIN, HIGH);
                    delay(50);
                }
                break;
            case BtState::Connected:
                // Solid on when connected
                digitalWrite(BT_STATUS_LED_PIN, LOW);
                break;
            case BtState::Idle:
            case BtState::Scanning:
                // Medium blink for idle/scanning
                digitalWrite(BT_STATUS_LED_PIN, LOW);
                delay(100);
                digitalWrite(BT_STATUS_LED_PIN, HIGH);
                break;
            default:
                // Off for error/off states
                digitalWrite(BT_STATUS_LED_PIN, HIGH);
                break;
        }
    }
}

void ElmLink::begin(Settings* settings) {
    settings_ = settings;
    mtx_ = xSemaphoreCreateMutex();
    jobs_ = xQueueCreate(4, sizeof(Job));
    toElm_ = xStreamBufferCreate(BRIDGE_BUF_BYTES, 1);
    fromElm_ = xStreamBufferCreate(BRIDGE_BUF_BYTES, 1);
    st_.mac = settings->elmMac;
    st_.name = settings->elmName;
    st_.autoReconnect = settings->elmMac.length() == 17;
    st_.alertsEnabled = settings->alertsEnabled;
    st_.buzzerEnabled = settings->buzzerEnabled;
    maxReconnectFails_ = BT_MAX_AUTO_RECONNECT_FAILS;
    alertsEnabled_ = settings->alertsEnabled;
    buzzerEnabled_ = settings->buzzerEnabled;
    reconnectFails_ = 0;
    reconnectGaveUp_ = false;
    alertPhase_ = AlertPhase::Idle;
    alertNextMs_ = 0;
    alertCooldownUntilMs_ = 0;
    lastBatteryWatchMs_ = 0;
    alertKwpInitTried_ = false;
    cmdActive_ = false;
    beepRemaining_ = 0;
    beepOn_ = false;
    // Initialize status LED if configured
    if (BT_STATUS_LED_PIN) {
        pinMode(BT_STATUS_LED_PIN, OUTPUT);
        digitalWrite(BT_STATUS_LED_PIN, HIGH);  // LED OFF (active LOW on most boards)
    }
    ledEnabled_ = true;
    // Initialize buzzer if configured
#if defined(BUZZER_PIN) && BUZZER_PIN > 0
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);  // Buzzer off (active HIGH)
#endif
    // Core 1 (Arduino loop core); AsyncTCP runs on core 0.
    xTaskCreatePinnedToCore(taskEntry, "elm", 8192, this, 2, nullptr, 1);
}

void ElmLink::setLed(bool on) {
    ledEnabled_ = on;
    if (BT_STATUS_LED_PIN && ledEnabled_) {
        digitalWrite(BT_STATUS_LED_PIN, on ? LOW : HIGH);
    }
}

bool ElmLink::cmdBegin(const String& cmd, uint32_t timeoutMs) {
    if (!SerialBT.connected()) return false;
    while (SerialBT.available()) SerialBT.read();     // drop stale bytes
    cmdBuf_ = "";
    cmdEcho_ = cmd;
    cmdStartMs_ = millis();
    cmdTimeoutMs_ = timeoutMs;
    cmdActive_ = true;
    bus.log('t', cmd);
    SerialBT.print(cmd);
    SerialBT.print('\r');
    return true;
}

int ElmLink::cmdPoll(String& out) {
    if (!cmdActive_) return -1;
    if (!SerialBT.connected()) {
        cmdActive_ = false;
        out = "TIMEOUT";
        return -1;
    }
    while (SerialBT.available()) {
        const char c = static_cast<char>(SerialBT.read());
        if (c == '>') {
            cmdActive_ = false;
            out = String(obd::cleanResponse(cmdBuf_.c_str(), cmdEcho_.c_str()).c_str());
            update([](ElmStatus& st) { st.lastRxMs = millis(); });
            String shown = out;
            shown.replace("\n", " | ");
            bus.log('r', shown.length() ? shown : String("(vacío)"));
            return 1;
        }
        if (cmdBuf_.length() < 2048) cmdBuf_ += c;
    }
    if (millis() - cmdStartMs_ >= cmdTimeoutMs_) {
        cmdActive_ = false;
        out = "TIMEOUT";
        String shown = out;
        bus.log('r', shown);
        return -1;
    }
    return 0;
}

ElmStatus ElmLink::status() {
    xSemaphoreTake(mtx_, portMAX_DELAY);
    ElmStatus copy = st_;
    xSemaphoreGive(mtx_);
    return copy;
}

std::vector<ScanDevice> ElmLink::devices() {
    xSemaphoreTake(mtx_, portMAX_DELAY);
    auto copy = devices_;
    xSemaphoreGive(mtx_);
    return copy;
}

bool ElmLink::enqueue(JobType t, const String& a, const String& b, const String& c, String& why) {
    if (bridge_) { why = "El panel OBD2 está usando el adaptador. Desconéctalo en ese panel (pestaña Conexión) primero."; return false; }
    const ElmStatus s = status();
    if (s.busy || uxQueueMessagesWaiting(jobs_) > 0) { why = "El adaptador está ocupado: espera a que termine «" + s.job + "»"; return false; }
    Job j{};
    j.type = t;
    strlcpy(j.arg, a.c_str(), sizeof j.arg);
    strlcpy(j.arg2, b.c_str(), sizeof j.arg2);
    strlcpy(j.arg3, c.c_str(), sizeof j.arg3);
    if (xQueueSend(jobs_, &j, 0) != pdTRUE) { why = "Cola llena"; return false; }
    return true;
}

bool ElmLink::scan(String& why) {
    if (status().bt == BtState::Connected) { why = "Desconecta el adaptador antes de buscar"; return false; }
    return enqueue(J_SCAN, "", "", "", why);
}

bool ElmLink::connect(const String& mac, const String& pin, const String& name, String& why) {
    uint8_t tmp[6];
    String m = mac;
    m.toUpperCase();
    if (!parseMac(m, tmp)) { why = "MAC inválida (formato AA:BB:CC:DD:EE:FF)"; return false; }
    if (pin.length() > 8) { why = "PIN demasiado largo"; return false; }
    if (status().bt == BtState::Connected) { why = "Ya hay un adaptador conectado"; return false; }
    return enqueue(J_CONNECT, m, pin.length() ? pin : String(DEFAULT_ELM_PIN), name, why);
}

bool ElmLink::disconnect(String& why) {
    // Always allowed (also cancels auto-reconnect), but still serialized.
    update([](ElmStatus& st) { st.autoReconnect = false; });
    return enqueue(J_DISCONNECT, "", "", "", why);
}

bool ElmLink::init(String& why) {
    if (status().bt != BtState::Connected) { why = "Conecta el adaptador primero"; return false; }
    return enqueue(J_INIT, "", "", "", why);
}

bool ElmLink::command(const String& cmd, String& why) {
    if (status().bt != BtState::Connected) { why = "Conecta el adaptador primero"; return false; }
    const obd::CommandCheck c = obd::checkCommand(cmd.c_str());
    if (!c.ok) { why = c.reason.c_str(); return false; }
    return enqueue(J_CMD, String(obd::normalizeCommand(cmd.c_str()).c_str()), "", "", why);
}

bool ElmLink::ecuTest(String& why) {
    if (status().bt != BtState::Connected) { why = "Conecta el adaptador primero"; return false; }
    return enqueue(J_ECU, "", "", "", why);
}

bool ElmLink::voltage(String& why) {
    if (status().bt != BtState::Connected) { why = "Conecta el adaptador primero"; return false; }
    return enqueue(J_VOLT, "", "", "", why);
}

// ── Task ───────────────────────────────────────────────────────
void ElmLink::taskEntry(void* self) { static_cast<ElmLink*>(self)->taskLoop(); }

void ElmLink::taskLoop() {
    if (!SerialBT.begin(BT_LOCAL_NAME, true)) {       // true = master (we connect to the ELM327)
        setBt(BtState::Error, "No se pudo iniciar Bluetooth");
        bus.warn("No se pudo iniciar Bluetooth Classic");
        vTaskDelete(nullptr);
        return;
    }
    setBt(BtState::Idle);
    bus.info("Bluetooth listo (modo maestro)");

    for (;;) {
        if (bridge_) {
            if (cmdActive_) cmdActive_ = false;   // bridge owns the link
            alertPhase_ = AlertPhase::Idle;
            pumpBridge();                 // waits up to a few ms for browser bytes
            maintain();
            continue;
        }
        Job j;
        const uint32_t waitMs = cmdActive_ ? 20 : 200;
        if (xQueueReceive(jobs_, &j, pdMS_TO_TICKS(waitMs)) == pdTRUE) {
            if (cmdActive_) cmdActive_ = false;   // job takes priority
            alertPhase_ = AlertPhase::Idle;
            run(j);
            continue;
        }
        maintain();
    }
}

// Detect a dropped link; auto-reconnect to the saved adapter.
void ElmLink::maintain() {
    {
        const ElmStatus s = status();
        if (s.bt == BtState::Connected && !SerialBT.connected()) {
            bus.warn("Se perdió la conexión Bluetooth con el adaptador");
            setBt(BtState::Error, "Conexión Bluetooth perdida");
            kwpFraming_ = false;
            cmdActive_ = false;
            alertPhase_ = AlertPhase::Idle;
        }
        if (s.autoReconnect && s.bt != BtState::Connected && s.bt != BtState::Off &&
            settings_->elmMac.length() == 17 && millis() - lastAttemptMs_ > BT_CONNECT_RETRY_MS) {
            if (reconnectFails_ < maxReconnectFails_) {
                update([](ElmStatus& st) { st.busy = true; st.job = "reconectar"; });
                doConnect(settings_->elmMac, settings_->elmPin, settings_->elmName, true);
                update([](ElmStatus& st) { st.busy = false; st.job = ""; });
            } else if (!reconnectGaveUp_) {
                reconnectGaveUp_ = true;
                update([](ElmStatus& st) { st.autoReconnect = false; st.error = "Auto-reconexión detenida tras varios fallos"; });
                bus.warn("Auto-reconexión detenida tras " + String(maxReconnectFails_) + " intentos. Conecta manualmente desde el panel.");
            }
        }
        beepTick();
        alertTick();
    }
}

// ── Bridge ─────────────────────────────────────────────────────
void ElmLink::bridgeAttach() {
    epoch_ = epoch_ + 1;          // the Bluetooth task flushes, then bridgeSynced()
    bridge_ = true;
}

void ElmLink::bridgeDetach() { bridge_ = false; }

size_t ElmLink::bridgeWrite(const uint8_t* data, size_t len) {
    if (!bridgeSynced()) return 0;
    return xStreamBufferSend(toElm_, data, len, 0);
}

size_t ElmLink::bridgeRead(uint8_t* data, size_t max) {
    return xStreamBufferReceive(fromElm_, data, max, 0);
}

void ElmLink::kickReconnect() {
    if (settings_->elmMac.length() != 17) return;
    reconnectFails_ = 0;
    reconnectGaveUp_ = false;
    update([](ElmStatus& st) { st.autoReconnect = true; st.error = ""; });
    lastAttemptMs_ = millis() - BT_CONNECT_RETRY_MS - 1;
}

void ElmLink::pumpBridge() {
    if (syncedEpoch_ != epoch_) {
        // New browser: drop whatever the previous one (or the ELM327) left behind.
        const uint32_t e = epoch_;
        xStreamBufferReset(toElm_);
        xStreamBufferReset(fromElm_);
        while (SerialBT.available()) SerialBT.read();
        kwpFraming_ = false;
        update([](ElmStatus& st) { st.elmReady = false; st.ecu = "en el panel OBD2"; });
        syncedEpoch_ = e;
    }
    uint8_t buf[256];
    const size_t n = xStreamBufferReceive(toElm_, buf, sizeof buf, pdMS_TO_TICKS(3));
    if (n && SerialBT.connected()) SerialBT.write(buf, n);
    size_t got = 0;
    while (got < sizeof buf && SerialBT.available()) buf[got++] = static_cast<uint8_t>(SerialBT.read());
    if (got && xStreamBufferSend(fromElm_, buf, got, 0) != got) {
        bus.warn("Puente: el navegador no lee a tiempo, se perdieron datos");
    }
}

void ElmLink::run(const Job& j) {
    static const char* names[] = {"buscar adaptadores", "conectar", "desconectar", "inicializar ELM327", "comando", "probar ECU", "leer voltaje"};
    update([&](ElmStatus& st) { st.busy = true; st.job = names[j.type]; });
    switch (j.type) {
        case J_SCAN: doScan(); break;
        case J_CONNECT: reconnectFails_ = 0; reconnectGaveUp_ = false; doConnect(j.arg, j.arg2, j.arg3, false); break;
        case J_DISCONNECT: doDisconnect(true); break;
        case J_INIT: doInit(); break;
        case J_CMD: doCommand(j.arg); break;
        case J_ECU: doEcuTest(); break;
        case J_VOLT: doVoltage(); break;
    }
    update([](ElmStatus& st) { st.busy = false; st.job = ""; });
}

void ElmLink::doScan() {
    setBt(BtState::Scanning);
    bus.info("Buscando dispositivos Bluetooth (" + String(BT_SCAN_MS / 1000) + " s)...");
    std::vector<ScanDevice> found;
    BTScanResults* r = SerialBT.discover(BT_SCAN_MS);
    if (r) {
        for (int i = 0; i < r->getCount(); i++) {
            BTAdvertisedDevice* d = r->getDevice(i);
            if (!d) continue;
            ScanDevice sd;
            sd.mac = String(d->getAddress().toString().c_str());
            sd.mac.toUpperCase();
            sd.name = d->haveName() ? String(d->getName().c_str()) : String("");
            sd.rssi = d->haveRSSI() ? d->getRSSI() : 0;
            sd.likelyElm = looksLikeElm(sd.name);
            found.push_back(sd);
        }
        SerialBT.discoverClear();
    }
    xSemaphoreTake(mtx_, portMAX_DELAY);
    devices_ = found;
    xSemaphoreGive(mtx_);
    bus.scanChanged();
    bus.info(String("Búsqueda terminada: ") + found.size() + " dispositivo(s)");
    setBt(BtState::Idle);
}

void ElmLink::doConnect(const String& mac, const String& pin, const String& name, bool automatic) {
    uint8_t addr[6];
    if (!parseMac(mac, addr)) return;
    lastAttemptMs_ = millis();
    update([&](ElmStatus& st) { st.mac = mac; if (name.length()) st.name = name; });
    setBt(BtState::Connecting);
    const bool quiet = automatic && reconnectFails_ > 0;   // log only the first failed retry
    if (!quiet) bus.info(String(automatic ? "Reconectando" : "Conectando") + " con " + (name.length() ? name + " " : String("")) + mac + "...");
    SerialBT.setPin(pin.c_str());                     // legacy pairing PIN (1234 / 0000)
    const bool ok = SerialBT.connect(addr);
    if (!ok || !SerialBT.connected()) {
        setBt(BtState::Error, "No se pudo conectar. ¿Adaptador encendido (en el conector OBD) y PIN correcto?");
        if (!quiet) bus.warn("No se pudo conectar con " + mac + (automatic ? String(". Reintento cada ") + (BT_CONNECT_RETRY_MS / 1000) + " s" : String("")));
        reconnectFails_++;
        return;
    }
    kwpFraming_ = false;
    reconnectFails_ = 0;
    reconnectGaveUp_ = false;
    alertKwpInitTried_ = false;
    setBt(BtState::Connected);
    bus.info("Conectado por Bluetooth a " + mac);
    // Remember this adapter and reconnect to it automatically
    if (settings_->elmMac != mac || settings_->elmPin != pin || (name.length() && settings_->elmName != name)) {
        settings_->elmMac = mac;
        settings_->elmPin = pin;
        if (name.length()) settings_->elmName = name;
        settings::save(*settings_);
    }
    update([](ElmStatus& st) { st.autoReconnect = true; st.error = ""; });
    doInit();
}

void ElmLink::doDisconnect(bool manual) {
    if (SerialBT.connected()) SerialBT.disconnect();
    kwpFraming_ = false;
    setBt(BtState::Idle);
    if (manual) bus.info("Adaptador desconectado (sin reconexión automática hasta que vuelvas a conectar)");
}

String ElmLink::sendRaw(const String& cmd, uint32_t timeoutMs) {
    if (!SerialBT.connected()) return "TIMEOUT";
    while (SerialBT.available()) SerialBT.read();     // drop stale bytes
    bus.log('t', cmd);
    SerialBT.print(cmd);
    SerialBT.print('\r');
    String buf;
    bool prompt = false;
    const uint32_t start = millis();
    while (millis() - start < timeoutMs) {
        while (SerialBT.available()) {
            const char c = static_cast<char>(SerialBT.read());
            if (c == '>') { prompt = true; break; }
            if (buf.length() < 2048) buf += c;
        }
        if (prompt) break;
        if (!SerialBT.connected()) break;
        vTaskDelay(pdMS_TO_TICKS(2));
    }
    String clean = prompt ? String(obd::cleanResponse(buf.c_str(), cmd.c_str()).c_str()) : String("TIMEOUT");
    if (prompt) update([](ElmStatus& st) { st.lastRxMs = millis(); });
    String shown = clean;
    shown.replace("\n", " | ");
    bus.log('r', shown.length() ? shown : String("(vacío)"));
    return clean;
}

bool ElmLink::doInit() {
    update([](ElmStatus& st) { st.elmReady = false; st.ecu = "sin probar"; });
    String r = sendRaw("ATZ", ELM_INIT_TIMEOUT_MS);
    if (r == "TIMEOUT") r = sendRaw("ATZ", ELM_INIT_TIMEOUT_MS);   // slow clones right after pairing
    if (r == "TIMEOUT") {
        bus.warn("El adaptador no responde como un ELM327 (sin respuesta a ATZ)");
        update([](ElmStatus& st) { st.error = "Sin respuesta a ATZ"; });
        return false;
    }
    const String version = obd::extractVersion(r.c_str()).c_str();
    kwpFraming_ = false;
    for (const char* c : {"ATE0", "ATL0", "ATS1", "ATH0", "ATAT2", "ATST 96"}) sendRaw(c, ELM_TIMEOUT_MS);
    float v = NAN;
    float parsed;
    if (obd::parseVoltage(sendRaw("ATRV", ELM_TIMEOUT_MS).c_str(), parsed)) v = parsed;
    update([&](ElmStatus& st) { st.elmReady = true; st.version = version; st.voltage = v; st.error = ""; });
    bus.info("ELM327 listo: " + version + (isnan(v) ? String("") : " · " + String(v, 1) + " V"));
    return true;
}

void ElmLink::doVoltage() {
    float v;
    if (obd::parseVoltage(sendRaw("ATRV", ELM_TIMEOUT_MS).c_str(), v)) update([&](ElmStatus& st) { st.voltage = v; });
}

void ElmLink::doCommand(const String& cmd) {
    const bool isAt = cmd.startsWith("AT");
    // 81 (start communication) and 10 xx (session) can take a K-line init
    const uint32_t timeout = (cmd.startsWith("81") || cmd.startsWith("10")) ? ELM_INIT_TIMEOUT_MS : ELM_TIMEOUT_MS;
    const String r = sendRaw(cmd, timeout);
    if (isAt) {
        String a = cmd;
        a.replace(" ", "");
        if (a == "ATH1") kwpFraming_ = true;
        if (a == "ATH0" || a == "ATZ" || a == "ATD" || a == "ATWS") kwpFraming_ = false;
        float v;
        if (a == "ATRV" && obd::parseVoltage(r.c_str(), v)) update([&](ElmStatus& st) { st.voltage = v; });
        if (a == "ATZ" || a == "ATD" || a == "ATWS") update([](ElmStatus& st) { st.elmReady = false; });
        return;
    }
    if (kwpFraming_ && !obd::isElmError(r.c_str())) {
        std::vector<std::vector<uint8_t>> msgs;
        if (obd::decodeKwpFrames(r.c_str(), msgs)) {
            for (auto& m : msgs) bus.info("Datos KWP (" + String(m.size()) + " bytes): " + String(obd::toHex(m).c_str()));
        }
    }
}

// Read-only check that the ECU answers: KWP2000 fast init (ISO 14230),
// header 81 11 F1, session 10 81 (fallback 10 89), then one 21 01 read.
// Same sequence as ELM327._initWithProfile() for the SIM2K-33 profile.
void ElmLink::doEcuTest() {
    if (!status().elmReady && !doInit()) return;
    bus.info("Probando la ECU (KWP2000, solo lectura)...");
    sendRaw("ATSP5", ELM_TIMEOUT_MS);
    sendRaw("ATH1", ELM_TIMEOUT_MS);
    kwpFraming_ = true;
    vTaskDelay(pdMS_TO_TICKS(200));
    sendRaw("AT SH 81 11 F1", ELM_TIMEOUT_MS);
    sendRaw("AT WM 81 11 F1 3E", ELM_TIMEOUT_MS);      // ELM keeps the session alive while idle

    std::vector<std::vector<uint8_t>> msgs;
    for (int attempt = 1; attempt <= 3; attempt++) {
        bool busInitError = false;
        for (const char* session : {"1081", "1089"}) {
            const String r = sendRaw(session, ELM_INIT_TIMEOUT_MS);
            if (r.indexOf("BUS INIT: ERROR") >= 0 || r.indexOf("BUS INIT: ...ERROR") >= 0) { busInitError = true; break; }
            if (!obd::decodeKwpFrames(r.c_str(), msgs) || msgs.empty() || msgs[0].empty() || msgs[0][0] != 0x50) continue;
            bus.info(String("Sesión iniciada (") + session + ")");
            const String d = sendRaw("2101", ELM_TIMEOUT_MS);
            if (obd::decodeKwpFrames(d.c_str(), msgs) && !msgs.empty() && !msgs[0].empty() && msgs[0][0] == 0x61) {
                bus.info("La ECU responde: bloque 21 01 con " + String(msgs[0].size()) + " bytes");
            } else {
                bus.warn("Sesión activa, pero 21 01 no respondió como se esperaba");
            }
            alertKwpInitTried_ = false;
            update([](ElmStatus& st) { st.ecu = "responde"; st.protocol = "ISO 14230-4 KWP (fast init)"; });
            return;
        }
        if (!busInitError || attempt == 3) break;
        bus.warn("BUS INIT: ERROR. Esperando 6 s de bus en silencio antes de reintentar (" + String(attempt) + "/2)...");
        vTaskDelay(pdMS_TO_TICKS(KLINE_IDLE_RECOVERY_MS));
    }
    update([](ElmStatus& st) { st.ecu = "sin respuesta"; });
    bus.warn("La ECU no respondió. ¿Contacto en ON?");
}

// ── Phase 3: non-blocking alerts ────────────────────────────

void ElmLink::alertSet(const String& msg) {
    update([&](ElmStatus& st) { st.alert = msg; });
}

void ElmLink::setAlerts(bool enabled, bool buzzer) {
    xSemaphoreTake(mtx_, portMAX_DELAY);
    alertsEnabled_ = enabled;
    buzzerEnabled_ = buzzer;
    st_.alertsEnabled = enabled;
    st_.buzzerEnabled = buzzer;
    if (!enabled) st_.alert = "";
    xSemaphoreGive(mtx_);
    if (!enabled) {
        cmdActive_ = false;
        alertPhase_ = AlertPhase::Idle;
        beepRemaining_ = 0;
        beepOn_ = false;
#if defined(BUZZER_PIN) && BUZZER_PIN > 0
        digitalWrite(BUZZER_PIN, LOW);
#endif
    }
    bus.stateChanged();
}

void ElmLink::beepStart(uint8_t pattern) {
#if defined(BUZZER_PIN) && BUZZER_PIN > 0
    if (!buzzerEnabled_) return;
    // pattern 1 = warning (2 beeps), 2 = critical (3 beeps)
    beepRemaining_ = (pattern >= 2) ? 3 : 2;
    beepDurMs_ = (pattern >= 2) ? BEEP_CRITICAL_MS : BEEP_WARNING_MS;
    beepOn_ = true;
    beepNextMs_ = millis() + beepDurMs_;
    digitalWrite(BUZZER_PIN, HIGH);
#else
    (void)pattern;
#endif
}

void ElmLink::beepTick() {
#if defined(BUZZER_PIN) && BUZZER_PIN > 0
    if (beepRemaining_ == 0) return;
    const uint32_t now = millis();
    if (static_cast<int32_t>(now - beepNextMs_) < 0) return;
    if (beepOn_) {
        digitalWrite(BUZZER_PIN, LOW);
        beepOn_ = false;
        beepRemaining_--;
        if (beepRemaining_ == 0) return;
        beepNextMs_ = now + BEEP_INTERVAL_MS;
    } else {
        digitalWrite(BUZZER_PIN, HIGH);
        beepOn_ = true;
        beepNextMs_ = now + beepDurMs_;
    }
#endif
}

void ElmLink::alertTick() {
    if (bridge_) return;

    const ElmStatus s = status();
    if (s.bt != BtState::Connected || !s.elmReady) {
        if (cmdActive_ || alertPhase_ != AlertPhase::Idle) { cmdActive_ = false; alertPhase_ = AlertPhase::Idle; }
        return;
    }
    if (!alertsEnabled_) {
        if (cmdActive_) { cmdActive_ = false; alertPhase_ = AlertPhase::Idle; }
        return;
    }
    if (s.busy) {
        if (cmdActive_) { cmdActive_ = false; alertPhase_ = AlertPhase::Idle; }
        return;
    }

    const uint32_t now = millis();

    // Poll pending alert command
    if (cmdActive_) {
        String out;
        const int r = cmdPoll(out);
        if (r == 0) return;  // still waiting, non-blocking

        if (alertPhase_ == AlertPhase::Wait2101) {
            alertPhase_ = AlertPhase::Idle;
            const bool ecuWasResponding = (s.ecu == "responde");
            alertNextMs_ = now + (ecuWasResponding ? FASE3_READ_INTERVAL_MS : 30000);
            if (r == 1 && kwp::isValid2101Response(std::string(out.c_str()))) {
                std::vector<uint8_t> data = kwp::hexToBytes(out);  // strips 61 01 prefix
                if (data.size() >= 78) {
                    kwp::EngineData eng = kwp::decode2101(data);
                    if (eng.valid) {
                        if (!ecuWasResponding) {
                            update([](ElmStatus& st) { if (st.ecu != "responde") st.ecu = "responde"; });
                            alertNextMs_ = now + FASE3_READ_INTERVAL_MS;
                        }
                        if (eng.rpm > 1000 && eng.coolantTemp > ALERT_COOLANT_MAX_C) {
                            const String msg = "Sobrecalentamiento: " + String(eng.coolantTemp, 1) + " °C";
                            bus.warn(msg);
                            alertSet(msg);
                            beepStart(2);
                            alertCooldownUntilMs_ = now + 10000;  // cooldown 10s
                            return;
                        }
                        if (eng.rpm > 1000 && eng.voltage > 0 && eng.voltage < ALERT_VOLTAGE_NO_CHARGE_MIN) {
                            const String msg = "Batería no cargando: " + String(eng.voltage, 1) + " V";
                            bus.warn(msg);
                            alertSet(msg);
                            beepStart(2);
                            alertCooldownUntilMs_ = now + 10000;
                            return;
                        }
                        // Clear recoverable alerts if readings are back to normal
                        if (s.alert.length() > 0 && !s.alert.startsWith("Batería baja")) alertSet("");
                    }
                }
            }
            return;
        }

        if (alertPhase_ == AlertPhase::WaitAtrv) {
            alertPhase_ = AlertPhase::Idle;
            lastBatteryWatchMs_ = now;
            if (r == 1) {
                float v = 0;
                if (obd::parseVoltage(out.c_str(), v)) {
                    if (v > 0 && v < ALERT_VOLTAGE_LOW_COLD_MIN) {
                        const String msg = "Batería baja: " + String(v, 1) + " V";
                        bus.warn(msg);
                        alertSet(msg);
                        beepStart(1);
                        alertCooldownUntilMs_ = now + 30000;
                        return;
                    }
                    if (s.alert.startsWith("Batería baja")) alertSet("");
                }
            }
            return;
        }

        alertPhase_ = AlertPhase::Idle;
        return;
    }

    // Cooldown after an alert fired
    if (alertCooldownUntilMs_ && static_cast<int32_t>(now - alertCooldownUntilMs_) < 0) return;
    alertCooldownUntilMs_ = 0;

    // Schedule: engine data check. If ECU not confirmed yet, probe less often
    // to avoid spamming the bus; a valid 61 01 response will mark it as responding.
    const uint32_t interval = (s.ecu == "responde") ? FASE3_READ_INTERVAL_MS : 30000;
    if (static_cast<int32_t>(now - alertNextMs_) >= 0) {
        alertPhase_ = AlertPhase::Wait2101;
        if (!cmdBegin("2101", ELM_TIMEOUT_MS)) { alertPhase_ = AlertPhase::Idle; alertNextMs_ = now + interval; }
        return;
    }

    // Battery watch with ATRV every 30s (lower priority than 2101 schedule)
    if (static_cast<int32_t>(now - lastBatteryWatchMs_) >= static_cast<int32_t>(FASE3_BATTERY_WATCH_INTERVAL_MS)) {
        alertPhase_ = AlertPhase::WaitAtrv;
        if (!cmdBegin("ATRV", ELM_TIMEOUT_MS)) { alertPhase_ = AlertPhase::Idle; lastBatteryWatchMs_ = now; }
        return;
    }
}
