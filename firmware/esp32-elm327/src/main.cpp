// obd-esp32-elm327 — phase 1
//   - Wi-Fi access point (WPA2) + captive DNS + mDNS (obd.local)
//   - web panel with user/password login
//   - Bluetooth Classic link to the ELM327 (scan, connect by MAC + PIN,
//     auto-reconnect), ELM327 init, read-only ECU test, safe terminal
//
// Factory reset (forgotten passwords): hold the BOOT button for 5 s.
#include <Arduino.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <WiFi.h>

#include "config.h"
#include "elm_link.h"
#include "events.h"
#include "settings.h"
#include "web.h"

EventBus bus;
static Settings cfg;
static DNSServer dns;

static const int BOOT_PIN = 0;
static uint32_t bootPressedAt = 0;

static void startAccessPoint() {
    const IPAddress ip(AP_IP);
    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(ip, ip, IPAddress(255, 255, 255, 0));
    if (!WiFi.softAP(cfg.apSsid.c_str(), cfg.apPass.c_str(), AP_CHANNEL, 0, AP_MAX_CLIENTS)) {
        bus.warn("No se pudo crear la red Wi-Fi; uso los valores por defecto");
        WiFi.softAP(DEFAULT_AP_SSID, DEFAULT_AP_PASS, AP_CHANNEL, 0, AP_MAX_CLIENTS);
    }
    dns.setErrorReplyCode(DNSReplyCode::NoError);
    dns.start(53, "*", ip);
    if (MDNS.begin("obd")) MDNS.addService("http", "tcp", 80);
    bus.info("Red Wi-Fi «" + cfg.apSsid + "» en " + ip.toString());
}

static void checkFactoryReset() {
    if (digitalRead(BOOT_PIN) == LOW) {
        if (!bootPressedAt) bootPressedAt = millis();
        if (millis() - bootPressedAt > 5000) {
            Serial.println("Factory reset: borrando ajustes...");
            settings::factoryReset();
            delay(200);
            ESP.restart();
        }
    } else {
        bootPressedAt = 0;
    }
}

void setup() {
    Serial.begin(115200);
    delay(200);
    Serial.printf("\n%s %s\n", FW_NAME, FW_VERSION);
    pinMode(BOOT_PIN, INPUT_PULLUP);
    bus.begin();
    settings::load(cfg);
    if (settings::usingDefaultWebPassword(cfg)) bus.warn("Clave del panel por defecto: cámbiala en Ajustes");
    startAccessPoint();
    web::begin(&cfg);
    elm.begin(&cfg);       // Bluetooth after Wi-Fi: both share the radio
}

void loop() {
    dns.processNextRequest();
    web::loop();
    checkFactoryReset();
    delay(5);
}
