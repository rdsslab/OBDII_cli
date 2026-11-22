// Persistent settings (NVS via Preferences) and password hashing.
#pragma once
#include <Arduino.h>

struct Settings {
    String apSsid;
    String apPass;
    String webUser;
    String webSalt;      // hex, random per password change
    String webHash;      // sha256(salt + password), hex
    String elmMac;       // "AA:BB:CC:DD:EE:FF" or empty
    String elmName;      // name seen when scanning (display only)
    String elmPin;
    bool alertsEnabled = true;   // Phase 3: alerts without panel open
    bool buzzerEnabled = true;   // Phase 3: buzzer output
};

namespace settings {

void load(Settings& s);
void save(const Settings& s);
void factoryReset();

String sha256Hex(const String& text);
String randomHex(size_t bytes);
void setPassword(Settings& s, const String& password);
bool checkPassword(const Settings& s, const String& password);

bool usingDefaultWebPassword(const Settings& s);
bool usingDefaultApPassword(const Settings& s);

}  // namespace settings
