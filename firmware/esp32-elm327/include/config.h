// Defaults and limits. Everything marked "default" can be changed from the
// web page (Ajustes) and is stored in NVS (survives reboots and re-flashing
// unless the flash is erased).
#pragma once

#define FW_NAME "obd-esp32-elm327"
#define FW_VERSION "0.2.0 (fase 2)"

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
#define MAX_SESSIONS 4
#define LOGIN_MAX_FAILS 5
#define LOGIN_LOCK_MS 60000UL

// Bluetooth Classic (SPP) to the ELM327
#define BT_LOCAL_NAME "OBD2-ESP32"
#define DEFAULT_ELM_PIN "1234"             // most clones: 1234 or 0000
#define BT_SCAN_MS 8000
#define BT_CONNECT_RETRY_MS 15000          // auto-reconnect to the saved adapter
#define BT_MAX_AUTO_RECONNECT_FAILS 3      // stop auto-reconnect after 3 failures

// Optional LED feedback for Bluetooth state (GPIO 2 is the onboard LED on most DevKits)
// Set to 0 to disable LED feedback
#define BT_STATUS_LED_PIN 2                // blue LED on ESP32 DevKit (active LOW)

// ELM327 timing (same as packages/core/src/elm327.js)
#define ELM_TIMEOUT_MS 6000
#define ELM_INIT_TIMEOUT_MS 12000
#define KLINE_IDLE_RECOVERY_MS 6000

// WebSocket bridge browser <-> ELM327 (phase 2)
#define BRIDGE_BUF_BYTES 1024              // each direction
#define BRIDGE_WAIT_NOTE_MS 4000           // "still waiting for Bluetooth" note to the browser

// Event log kept for the page (newest last)
#define LOG_LINES 30

// Fase 3: Alertas sin panel abierto
// Buzzer configuration (GPIO 25 = onboard LED on ESP32-CAM, or GPIO 18 on DevKit)
// Set to 0 to disable buzzer alerts
#define BUZZER_PIN 25                    // active buzzer + transistor NPN

// Alert thresholds (match packages/core/src/alerts.js)
#define ALERT_COOLANT_MAX_C 110            // sobrecalentamiento
#define ALERT_VOLTAGE_NO_CHARGE_MIN 10.0   // no carga con motor en marcha
#define ALERT_VOLTAGE_LOW_COLD_MIN 10.5    // batería baja con motor apagado

// Alert patterns (in milliseconds)
#define BEEP_WARNING_MS 300                // 2 quick beeps
#define BEEP_CRITICAL_MS 300               // 3 quick beeps
#define BEEP_INTERVAL_MS 100               // interval between beeps

// Fase 3: lectura periódica
#define FASE3_READ_INTERVAL_MS 3000        // cada 3 s sin conexión del panel
#define FASE3_BATTERY_WATCH_INTERVAL_MS 30000  // cada 30 s para ATRV
