#include "elm_link.h"

#include <BluetoothSerial.h>

#include "config.h"
#include "events.h"
#include "obd_text.h"

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
}

void ElmLink::begin(Settings* settings) {
    settings_ = settings;
    mtx_ = xSemaphoreCreateMutex();
    jobs_ = xQueueCreate(4, sizeof(Job));
    st_.mac = settings->elmMac;
    st_.name = settings->elmName;
    st_.autoReconnect = settings->elmMac.length() == 17;
    // Core 1 (Arduino loop core); AsyncTCP runs on core 0.
    xTaskCreatePinnedToCore(taskEntry, "elm", 8192, this, 2, nullptr, 1);
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
        Job j;
        if (xQueueReceive(jobs_, &j, pdMS_TO_TICKS(500)) == pdTRUE) {
            run(j);
            continue;
        }
        // Idle maintenance: detect a dropped link, auto-reconnect to the saved adapter
        const ElmStatus s = status();
        if (s.bt == BtState::Connected && !SerialBT.connected()) {
            bus.warn("Se perdió la conexión Bluetooth con el adaptador");
            setBt(BtState::Error, "Conexión Bluetooth perdida");
            kwpFraming_ = false;
        }
        if (s.autoReconnect && s.bt != BtState::Connected && s.bt != BtState::Off &&
            settings_->elmMac.length() == 17 && millis() - lastAttemptMs_ > BT_CONNECT_RETRY_MS) {
            update([](ElmStatus& st) { st.busy = true; st.job = "reconectar"; });
            doConnect(settings_->elmMac, settings_->elmPin, settings_->elmName, true);
            update([](ElmStatus& st) { st.busy = false; st.job = ""; });
        }
    }
}

void ElmLink::run(const Job& j) {
    static const char* names[] = {"buscar adaptadores", "conectar", "desconectar", "inicializar ELM327", "comando", "probar ECU", "leer voltaje"};
    update([&](ElmStatus& st) { st.busy = true; st.job = names[j.type]; });
    switch (j.type) {
        case J_SCAN: doScan(); break;
        case J_CONNECT: reconnectFails_ = 0; doConnect(j.arg, j.arg2, j.arg3, false); break;
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
    setBt(BtState::Connected);
    bus.info("Conectado por Bluetooth a " + mac);
    // Remember this adapter and reconnect to it automatically
    if (settings_->elmMac != mac || settings_->elmPin != pin || (name.length() && settings_->elmName != name)) {
        settings_->elmMac = mac;
        settings_->elmPin = pin;
        if (name.length()) settings_->elmName = name;
        settings::save(*settings_);
    }
    update([](ElmStatus& st) { st.autoReconnect = true; });
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
