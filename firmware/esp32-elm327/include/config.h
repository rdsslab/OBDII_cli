// Defaults and limits. Everything marked "default" can be changed from the
// web page (Ajustes) and is stored in NVS (survives reboots and re-flashing
// unless the flash is erased).
#pragma once

#define FW_NAME "obd-esp32-elm327"
#define FW_VERSION "0.1.0 (fase 1)"

// Wi-Fi access point (default)
#define DEFAULT_AP_SSID "OBD2-ESP32"
#define DEFAULT_AP_PASS "obd2esp32"        // WPA2: 8-63 characters
#define AP_CHANNEL 6
#define AP_MAX_CLIENTS 4
#define AP_IP 192, 168, 4, 1

// Web login (default; the page warns while the defaults are in use)
#define DEFAULT_WEB_USER "admin"
#define DEFAULT_WEB_PASS "obd2admin"
#define SESSION_COOKIE "obd_sess"
#define SESSION_TTL_MS (12UL * 3600UL * 1000UL)
#define MAX_SESSIONS 6
#define LOGIN_MAX_FAILS 5
#define LOGIN_LOCK_MS 60000UL

// Bluetooth Classic (SPP) to the ELM327
#define BT_LOCAL_NAME "OBD2-ESP32"
#define DEFAULT_ELM_PIN "1234"             // most clones: 1234 or 0000
#define BT_SCAN_MS 8000
#define BT_CONNECT_RETRY_MS 15000          // auto-reconnect to the saved adapter

// ELM327 timing (same as packages/core/src/elm327.js)
#define ELM_TIMEOUT_MS 6000
#define ELM_INIT_TIMEOUT_MS 12000
#define KLINE_IDLE_RECOVERY_MS 6000

// Event log kept for the page (newest last)
#define LOG_LINES 120
