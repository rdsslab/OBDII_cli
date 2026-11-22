#include "settings.h"

#include <Preferences.h>
#include <esp_system.h>
#include <mbedtls/md.h>
#if __has_include(<esp_random.h>)
#include <esp_random.h>
#endif

#include "auth_core.h"
#include "config.h"

namespace settings {

static const char* NS = "obd";

String sha256Hex(const String& text) {
    uint8_t out[32];
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
    mbedtls_md_starts(&ctx);
    mbedtls_md_update(&ctx, reinterpret_cast<const unsigned char*>(text.c_str()), text.length());
    mbedtls_md_finish(&ctx, out);
    mbedtls_md_free(&ctx);
    char hex[65];
    for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", out[i]);
    return String(hex);
}

String randomHex(size_t bytes) {
    uint8_t buf[32];
    if (bytes > sizeof buf) bytes = sizeof buf;
    esp_fill_random(buf, bytes);
    String s;
    char h[3];
    for (size_t i = 0; i < bytes; i++) {
        sprintf(h, "%02x", buf[i]);
        s += h;
    }
    return s;
}

void setPassword(Settings& s, const String& password) {
    s.webSalt = randomHex(16);
    s.webHash = sha256Hex(s.webSalt + password);
}

bool checkPassword(const Settings& s, const String& password) {
    const String h = sha256Hex(s.webSalt + password);
    return auth::digestEq(std::string(h.c_str()), std::string(s.webHash.c_str()));
}

bool usingDefaultWebPassword(const Settings& s) { return checkPassword(s, DEFAULT_WEB_PASS); }
bool usingDefaultApPassword(const Settings& s) { return s.apPass == DEFAULT_AP_PASS; }

void load(Settings& s) {
    Preferences p;
    p.begin(NS, true);
    s.apSsid = p.getString("apSsid", DEFAULT_AP_SSID);
    s.apPass = p.getString("apPass", DEFAULT_AP_PASS);
    s.webUser = p.getString("webUser", DEFAULT_WEB_USER);
    s.webSalt = p.getString("webSalt", "");
    s.webHash = p.getString("webHash", "");
    s.elmMac = p.getString("elmMac", "");
    s.elmName = p.getString("elmName", "");
    s.elmPin = p.getString("elmPin", DEFAULT_ELM_PIN);
    s.alertsEnabled = p.getBool("alertsOn", true);
    s.buzzerEnabled = p.getBool("buzzerOn", true);
    p.end();
    if (s.webHash.isEmpty()) {          // first boot
        setPassword(s, DEFAULT_WEB_PASS);
        save(s);
    }
}

void save(const Settings& s) {
    Preferences p;
    p.begin(NS, false);
    p.putString("apSsid", s.apSsid);
    p.putString("apPass", s.apPass);
    p.putString("webUser", s.webUser);
    p.putString("webSalt", s.webSalt);
    p.putString("webHash", s.webHash);
    p.putString("elmMac", s.elmMac);
    p.putString("elmName", s.elmName);
    p.putString("elmPin", s.elmPin);
    p.putBool("alertsOn", s.alertsEnabled);
    p.putBool("buzzerOn", s.buzzerEnabled);
    p.end();
}

void factoryReset() {
    Preferences p;
    p.begin(NS, false);
    p.clear();
    p.end();
}

}  // namespace settings
