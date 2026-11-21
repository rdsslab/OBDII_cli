#include "web.h"

#include <ArduinoJson.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <WiFi.h>

#include "auth_core.h"
#include "config.h"
#include "elm_link.h"
#include "events.h"
#include "web_assets.h"     // generated from web/*.html by scripts/embed_web.py

namespace web {

static AsyncWebServer server(80);
static AsyncEventSource events("/api/events");
static Settings* cfg = nullptr;
static auth::LoginGuard guard(LOGIN_MAX_FAILS, LOGIN_LOCK_MS);
static auth::SessionTable<MAX_SESSIONS> sessions(SESSION_TTL_MS);
static uint32_t logCursor = 0;
static uint32_t lastStateMs = 0;
static uint32_t restartAt = 0;

// WebSocket bridge browser <-> ELM327 (one owner at a time; the newest wins)
static AsyncWebSocket ws("/api/ws/elm");
static volatile uint32_t ownerId = 0;
static volatile bool ownerReady = false;
static String ownerIp;
static uint32_t ownerWaitNoteMs = 0;
static uint32_t lastCleanupMs = 0;
static const uint16_t CLOSE_TAKEN = 4001, CLOSE_NO_ADAPTER = 4002, CLOSE_BUSY = 4003;

// ── helpers ──────────────────────────────────────────────────
static String sessionToken(AsyncWebServerRequest* r) {
    const AsyncWebHeader* h = r->getHeader("Cookie");
    if (!h) return "";
    return String(auth::cookieValue(h->value().c_str(), SESSION_COOKIE).c_str());
}

static bool authed(AsyncWebServerRequest* r) { return sessions.check(sessionToken(r).c_str(), millis()); }

static void sendJson(AsyncWebServerRequest* r, int code, const JsonDocument& doc) {
    String out;
    serializeJson(doc, out);
    AsyncWebServerResponse* res = r->beginResponse(code, "application/json; charset=utf-8", out);
    res->addHeader("Cache-Control", "no-store");
    r->send(res);
}

static void sendError(AsyncWebServerRequest* r, int code, const String& msg) {
    JsonDocument d;
    d["error"] = msg;
    sendJson(r, code, d);
}

static void sendOk(AsyncWebServerRequest* r) {
    JsonDocument d;
    d["ok"] = true;
    sendJson(r, 200, d);
}

static String param(AsyncWebServerRequest* r, const char* name) {
    const AsyncWebParameter* p = r->getParam(name, true);   // POST body (x-www-form-urlencoded)
    if (!p) p = r->getParam(name, false);
    return p ? p->value() : String("");
}

static void sendPage(AsyncWebServerRequest* r, const uint8_t* data, size_t len) {
    AsyncWebServerResponse* res = r->beginResponse(200, "text/html; charset=utf-8", data, len);
    res->addHeader("Content-Encoding", "gzip");
    res->addHeader("Cache-Control", "no-store");
    r->send(res);
}

// Panel files (JS/CSS/SVG): revalidated with an ETag that changes with every
// build, so a reload costs a 304 instead of ~90 KB over Wi-Fi.
static bool sendAsset(AsyncWebServerRequest* r) {
    const String url = r->url();
    for (size_t i = 0; i < APP_ASSETS_COUNT; i++) {
        const WebAsset& a = APP_ASSETS[i];
        if (url != a.path) continue;
        const AsyncWebHeader* inm = r->getHeader("If-None-Match");
        if (inm && inm->value() == "\"" WEB_BUILD_ID "\"") {
            r->send(304);
            return true;
        }
        AsyncWebServerResponse* res = r->beginResponse(200, a.type, a.data, a.len);
        res->addHeader("Content-Encoding", "gzip");
        res->addHeader("Cache-Control", "no-cache");
        res->addHeader("ETag", "\"" WEB_BUILD_ID "\"");
        r->send(res);
        return true;
    }
    return false;
}

// Wrap a handler so it only runs for a logged-in session.
static ArRequestHandlerFunction guarded(ArRequestHandlerFunction fn) {
    return [fn](AsyncWebServerRequest* r) {
        if (!authed(r)) return sendError(r, 401, "Sesión no iniciada");
        fn(r);
    };
}

// Run an ElmLink job request and answer 202 (queued) or 409 (refused).
template <typename F>
static void queued(AsyncWebServerRequest* r, F job) {
    String why;
    if (job(why)) {
        JsonDocument d;
        d["queued"] = true;
        sendJson(r, 202, d);
    } else {
        sendError(r, 409, why);
    }
}

static void stateJson(JsonDocument& d) {
    const ElmStatus s = elm.status();
    d["fw"] = FW_VERSION;
    d["uptimeS"] = millis() / 1000;
    d["heap"] = ESP.getFreeHeap();
    d["minHeap"] = ESP.getMinFreeHeap();
    d["wifiClients"] = WiFi.softAPgetStationNum();
    d["sessions"] = sessions.active(millis());
    d["apSsid"] = cfg->apSsid;
    JsonObject def = d["defaults"].to<JsonObject>();
    def["web"] = settings::usingDefaultWebPassword(*cfg);
    def["ap"] = settings::usingDefaultApPassword(*cfg);
    JsonObject bt = d["bt"].to<JsonObject>();
    bt["state"] = btStateName(s.bt);
    bt["mac"] = s.mac;
    bt["name"] = s.name;
    bt["error"] = s.error;
    bt["busy"] = s.busy;
    bt["job"] = s.job;
    bt["autoReconnect"] = s.autoReconnect;
    JsonObject e = d["elm"].to<JsonObject>();
    e["ready"] = s.elmReady;
    e["version"] = s.version;
    e["protocol"] = s.protocol;
    if (isnan(s.voltage)) e["voltage"] = nullptr; else e["voltage"] = roundf(s.voltage * 10) / 10;
    d["ecu"] = s.ecu;
    JsonObject br = d["bridge"].to<JsonObject>();
    br["active"] = ownerId != 0;
    br["ready"] = ownerReady;
    br["ip"] = ownerId ? ownerIp : String("");
}

static void bridgeText(uint32_t id, const JsonDocument& d) {
    String out;
    serializeJson(d, out);
    ws.text(id, out);
}

static void onBridgeEvent(AsyncWebSocket*, AsyncWebSocketClient* c, AwsEventType type, void* arg, uint8_t* data, size_t len) {
    switch (type) {
        case WS_EVT_CONNECT: {
            if (cfg->elmMac.length() != 17) {
                c->close(CLOSE_NO_ADAPTER, "El ESP32 no tiene un adaptador ELM327 guardado");
                return;
            }
            const ElmStatus s = elm.status();
            if (!elm.bridgeActive() && s.busy && s.job != "reconectar") {
                c->close(CLOSE_BUSY, "El ESP32 está ocupado con una prueba de su panel");
                return;
            }
            const uint32_t prev = ownerId;
            if (prev && prev != c->id()) {
                ws.close(prev, CLOSE_TAKEN, "Otro dispositivo tomó el control del adaptador");
                bus.info("El panel OBD2 pasa de " + ownerIp + " a " + c->remoteIP().toString());
            } else {
                bus.info("Panel OBD2 conectado desde " + c->remoteIP().toString());
            }
            ownerReady = false;
            ownerIp = c->remoteIP().toString();
            ownerWaitNoteMs = 0;
            ownerId = c->id();
            elm.bridgeAttach();
            if (s.bt != BtState::Connected) elm.kickReconnect();
            bus.stateChanged();
            break;
        }
        case WS_EVT_DISCONNECT:
            if (c->id() == ownerId) {
                ownerId = 0;
                ownerReady = false;
                elm.bridgeDetach();
                bus.info("Panel OBD2 desconectado (" + ownerIp + ")");
                bus.stateChanged();
            }
            break;
        case WS_EVT_DATA: {
            const AwsFrameInfo* info = static_cast<AwsFrameInfo*>(arg);
            if (c->id() != ownerId || !ownerReady || info->message_opcode != WS_BINARY) return;
            if (elm.bridgeWrite(data, len) != len) bus.warn("Puente: comando descartado (búfer lleno)");
            break;
        }
        default: break;
    }
}

// Called from loop(): tell the owner when bytes can flow, relay ELM327
// output, and close the bridge when Bluetooth drops (the browser reconnects).
static void serviceBridge(uint32_t now) {
    if (now - lastCleanupMs > 1000) { lastCleanupMs = now; ws.cleanupClients(); }
    const uint32_t id = ownerId;
    if (!id) return;
    const ElmStatus s = elm.status();
    const bool linkUp = s.bt == BtState::Connected && !s.busy && elm.bridgeSynced();
    if (!ownerReady) {
        if (linkUp) {
            JsonDocument d;
            d["type"] = "ready";
            d["name"] = s.name;
            d["mac"] = s.mac;
            bridgeText(id, d);
            ownerReady = true;
            bus.info("Puente listo: el panel OBD2 maneja el ELM327");
            bus.stateChanged();
        } else if (now - ownerWaitNoteMs > BRIDGE_WAIT_NOTE_MS) {
            ownerWaitNoteMs = now;
            JsonDocument d;
            d["type"] = "wait";
            d["reason"] = s.bt == BtState::Connecting ? String("conectando por Bluetooth con ") + (s.name.length() ? s.name : s.mac)
                        : s.busy ? String("el ESP32 está terminando «") + s.job + "»"
                        : s.error.length() ? s.error : String("esperando el Bluetooth del adaptador");
            bridgeText(id, d);
        }
        return;
    }
    if (s.bt != BtState::Connected) {
        JsonDocument d;
        d["type"] = "lost";
        d["reason"] = "Se perdió la conexión Bluetooth entre el ESP32 y el adaptador";
        bridgeText(id, d);
        ws.close(id, 1000, "Se perdió la conexión Bluetooth entre el ESP32 y el adaptador");
        ownerReady = false;
        return;
    }
    uint8_t buf[512];
    size_t n;
    while ((n = elm.bridgeRead(buf, sizeof buf)) > 0) ws.binary(id, buf, n);
}

static void devicesJson(JsonDocument& d) {
    JsonArray a = d.to<JsonArray>();
    for (const auto& dev : elm.devices()) {
        JsonObject o = a.add<JsonObject>();
        o["mac"] = dev.mac;
        o["name"] = dev.name;
        o["rssi"] = dev.rssi;
        o["likelyElm"] = dev.likelyElm;
    }
}

static void lineJson(JsonDocument& d, const LogLine& l) {
    d["id"] = l.id;
    d["up"] = l.uptimeMs;
    d["level"] = String(l.level);
    d["msg"] = l.msg;
}

static void sendEvent(const char* name, const JsonDocument& d, uint32_t id = 0) {
    String out;
    serializeJson(d, out);
    events.send(out.c_str(), name, id);
}

static void redirect(AsyncWebServerRequest* r, const char* to) {
    AsyncWebServerResponse* res = r->beginResponse(302);
    res->addHeader("Location", to);
    r->send(res);
}

// ── routes ───────────────────────────────────────────────────
void begin(Settings* settings) {
    cfg = settings;

    // Pages
    server.on("/login", HTTP_GET, [](AsyncWebServerRequest* r) { sendPage(r, PAGE_LOGIN_GZ, PAGE_LOGIN_GZ_LEN); });
    // "/" is the shared OBD2 panel (packages/ui); "/esp32" the adapter / Wi-Fi page
    server.on("/", HTTP_GET, [](AsyncWebServerRequest* r) {
        if (!authed(r)) return redirect(r, "/login");
        sendPage(r, PAGE_APP_GZ, PAGE_APP_GZ_LEN);
    });
    server.on("/esp32", HTTP_GET, [](AsyncWebServerRequest* r) {
        if (!authed(r)) return redirect(r, "/login");
        sendPage(r, PAGE_ESP32_GZ, PAGE_ESP32_GZ_LEN);
    });

    // Login / logout
    server.on("/api/login", HTTP_POST, [](AsyncWebServerRequest* r) {
        const uint32_t now = millis();
        const uint32_t wait = guard.lockedFor(now);
        if (wait) return sendError(r, 429, "Demasiados intentos. Espera " + String((wait + 999) / 1000) + " s.");
        const String user = param(r, "user");
        const String pass = param(r, "pass");
        if (user != cfg->webUser || !settings::checkPassword(*cfg, pass)) {
            guard.fail(now);
            bus.warn("Intento de ingreso fallido desde " + r->client()->remoteIP().toString());
            return sendError(r, 403, "Usuario o clave incorrectos");
        }
        guard.success();
        const String token = settings::randomHex(16);
        sessions.add(token.c_str(), now);
        JsonDocument d;
        d["ok"] = true;
        String out;
        serializeJson(d, out);
        AsyncWebServerResponse* res = r->beginResponse(200, "application/json; charset=utf-8", out);
        res->addHeader("Set-Cookie", String(SESSION_COOKIE) + "=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + String(SESSION_TTL_MS / 1000));
        res->addHeader("Cache-Control", "no-store");
        r->send(res);
        bus.info("Ingreso al panel desde " + r->client()->remoteIP().toString());
    });
    server.on("/api/logout", HTTP_POST, [](AsyncWebServerRequest* r) {
        sessions.remove(sessionToken(r).c_str());
        AsyncWebServerResponse* res = r->beginResponse(200, "application/json", "{\"ok\":true}");
        res->addHeader("Set-Cookie", String(SESSION_COOKIE) + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
        r->send(res);
    });

    // State and log
    server.on("/api/state", HTTP_GET, guarded([](AsyncWebServerRequest* r) {
        JsonDocument d;
        stateJson(d);
        sendJson(r, 200, d);
    }));
    server.on("/api/log", HTTP_GET, guarded([](AsyncWebServerRequest* r) {
        JsonDocument d;
        JsonArray a = d.to<JsonArray>();
        for (const auto& l : bus.history()) {
            JsonObject o = a.add<JsonObject>();
            o["id"] = l.id;
            o["up"] = l.uptimeMs;
            o["level"] = String(l.level);
            o["msg"] = l.msg;
        }
        sendJson(r, 200, d);
    }));

    // Bluetooth
    server.on("/api/bt/devices", HTTP_GET, guarded([](AsyncWebServerRequest* r) {
        JsonDocument d;
        devicesJson(d);
        sendJson(r, 200, d);
    }));
    server.on("/api/bt/scan", HTTP_POST, guarded([](AsyncWebServerRequest* r) { queued(r, [](String& w) { return elm.scan(w); }); }));
    server.on("/api/bt/connect", HTTP_POST, guarded([](AsyncWebServerRequest* r) {
        const String mac = param(r, "mac"), pin = param(r, "pin"), name = param(r, "name");
        queued(r, [&](String& w) { return elm.connect(mac, pin, name, w); });
    }));
    server.on("/api/bt/disconnect", HTTP_POST, guarded([](AsyncWebServerRequest* r) { queued(r, [](String& w) { return elm.disconnect(w); }); }));

    // ELM327
    server.on("/api/elm/init", HTTP_POST, guarded([](AsyncWebServerRequest* r) { queued(r, [](String& w) { return elm.init(w); }); }));
    server.on("/api/elm/voltage", HTTP_POST, guarded([](AsyncWebServerRequest* r) { queued(r, [](String& w) { return elm.voltage(w); }); }));
    server.on("/api/elm/ecu-test", HTTP_POST, guarded([](AsyncWebServerRequest* r) { queued(r, [](String& w) { return elm.ecuTest(w); }); }));
    server.on("/api/elm/cmd", HTTP_POST, guarded([](AsyncWebServerRequest* r) {
        const String cmd = param(r, "cmd");
        queued(r, [&](String& w) { return elm.command(cmd, w); });
    }));

    // Settings
    server.on("/api/settings", HTTP_GET, guarded([](AsyncWebServerRequest* r) {
        JsonDocument d;
        d["apSsid"] = cfg->apSsid;
        d["webUser"] = cfg->webUser;
        d["elmMac"] = cfg->elmMac;
        d["elmName"] = cfg->elmName;
        d["elmPin"] = cfg->elmPin;
        sendJson(r, 200, d);
    }));
    server.on("/api/settings", HTTP_POST, guarded([](AsyncWebServerRequest* r) {
        if (!settings::checkPassword(*cfg, param(r, "currentPass"))) return sendError(r, 403, "La clave actual no es correcta");
        const String apSsid = param(r, "apSsid"), apPass = param(r, "apPass");
        const String webUser = param(r, "webUser"), newPass = param(r, "newPass"), elmPin = param(r, "elmPin");
        if (apSsid.length() && (apSsid.length() > 32)) return sendError(r, 400, "Nombre de red: máximo 32 caracteres");
        if (apPass.length() && (apPass.length() < 8 || apPass.length() > 63)) return sendError(r, 400, "Clave de la red Wi-Fi: entre 8 y 63 caracteres");
        if (webUser.length() > 32) return sendError(r, 400, "Usuario: máximo 32 caracteres");
        if (newPass.length() && newPass.length() < 8) return sendError(r, 400, "Clave del panel: al menos 8 caracteres");
        if (elmPin.length() > 8) return sendError(r, 400, "PIN del adaptador: máximo 8 caracteres");
        bool restart = false, relogin = false;
        if (apSsid.length() && apSsid != cfg->apSsid) { cfg->apSsid = apSsid; restart = true; }
        if (apPass.length() && apPass != cfg->apPass) { cfg->apPass = apPass; restart = true; }
        if (webUser.length() && webUser != cfg->webUser) { cfg->webUser = webUser; relogin = true; }
        if (newPass.length()) { settings::setPassword(*cfg, newPass); relogin = true; }
        if (elmPin.length()) cfg->elmPin = elmPin;
        settings::save(*cfg);
        bus.info(String("Ajustes guardados") + (restart ? " (se reinicia para aplicar la red Wi-Fi)" : ""));
        if (relogin) sessions.clear();
        if (restart) restartAt = millis() + 1500;
        JsonDocument d;
        d["ok"] = true;
        d["restart"] = restart;
        d["relogin"] = relogin;
        sendJson(r, 200, d);
    }));
    server.on("/api/restart", HTTP_POST, guarded([](AsyncWebServerRequest* r) {
        restartAt = millis() + 800;
        bus.info("Reinicio solicitado desde el panel");
        sendOk(r);
    }));

    // Live events (only for logged-in sessions)
    events.setFilter([](AsyncWebServerRequest* r) { return authed(r); });
    events.onConnect([](AsyncEventSourceClient* c) {
        JsonDocument d;
        stateJson(d);
        String out;
        serializeJson(d, out);
        c->send(out.c_str(), "state", 0, 3000);
    });
    server.addHandler(&events);

    // Bridge to the ELM327 for the OBD2 panel (only for logged-in sessions)
    ws.setFilter([](AsyncWebServerRequest* r) { return authed(r); });
    ws.onEvent(onBridgeEvent);
    server.addHandler(&ws);

    // Panel files; captive portal: phones probe a few URLs after joining
    // the network, anything unknown goes to the login page.
    server.onNotFound([](AsyncWebServerRequest* r) {
        if (r->method() == HTTP_GET && sendAsset(r)) return;
        if (r->url().startsWith("/api/")) return sendError(r, 404, "No encontrado");
        redirect(r, "http://192.168.4.1/login");
    });

    server.begin();
    bus.info("Servidor web iniciado en http://192.168.4.1 (también http://obd.local)");
}

void loop() {
    const uint32_t now = millis();
    serviceBridge(now);
    if (events.count() > 0) {
        bus.drain(logCursor, [](const LogLine& l) {
            JsonDocument d;
            lineJson(d, l);
            sendEvent("log", d, l.id);
        });
        if (bus.takeState() || now - lastStateMs > 3000) {
            lastStateMs = now;
            JsonDocument d;
            stateJson(d);
            sendEvent("state", d);
        }
        if (bus.takeScan()) {
            JsonDocument d;
            devicesJson(d);
            sendEvent("scan", d);
        }
    } else {
        bus.drain(logCursor, [](const LogLine&) {});   // nobody listening: just advance
    }
    if (restartAt && static_cast<int32_t>(now - restartAt) > 0) {
        delay(100);
        ESP.restart();
    }
}

}  // namespace web
