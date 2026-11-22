// Bluetooth Classic (SPP) link to the ELM327, run in its own FreeRTOS task.
// The web server only queues jobs (scan, connect, init, command, ECU test)
// and reads status snapshots; results arrive through the EventBus log.
#pragma once
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/stream_buffer.h>

#include <vector>

#include "settings.h"

enum class BtState : uint8_t { Off, Idle, Scanning, Connecting, Connected, Error };
const char* btStateName(BtState s);

struct ScanDevice {
    String mac;
    String name;
    int rssi;
    bool likelyElm;
};

struct ElmStatus {
    BtState bt = BtState::Off;
    String mac;             // adapter in use / last tried
    String name;
    String error;
    bool busy = false;      // a job is running
    String job;             // what is running
    // ELM327
    bool elmReady = false;  // ATZ answered, basic config done
    String version;
    String protocol;
    float voltage = NAN;
    // ECU (phase 1: only a read-only test)
    String ecu = "sin probar";   // "sin probar" | "responde" | "sin respuesta"
    uint32_t lastRxMs = 0;
    bool autoReconnect = false;
    // Phase 3 alerts
    bool alertsEnabled = true;
    bool buzzerEnabled = true;
    String alert;           // last alert message, empty when none
};

class ElmLink {
public:
    void begin(Settings* settings);

    // Queue a job. false + reason if refused (busy, invalid, not connected...).
    bool scan(String& why);
    bool connect(const String& mac, const String& pin, const String& name, String& why);
    bool disconnect(String& why);
    bool init(String& why);
    bool command(const String& cmd, String& why);
    bool ecuTest(String& why);
    bool voltage(String& why);

    ElmStatus status();
    std::vector<ScanDevice> devices();

    // ── WebSocket bridge (phase 2) ─────────────────────────────
    // A browser runs the diagnostic session itself (packages/core) and the
    // ESP32 only relays bytes between the WebSocket and Bluetooth. While a
    // browser holds the bridge, the panel's own jobs are refused.
    void bridgeAttach();                                 // any task
    void bridgeDetach();                                 // any task
    bool bridgeActive() const { return bridge_; }
    // The Bluetooth task flushed old bytes after the last attach: data may flow.
    bool bridgeSynced() const { return bridge_ && syncedEpoch_ == epoch_; }
    size_t bridgeWrite(const uint8_t* data, size_t len); // browser -> ELM327 (non-blocking)
    size_t bridgeRead(uint8_t* data, size_t max);        // ELM327 -> browser (non-blocking)
    void kickReconnect();                                // try the saved adapter now

    // ── Phase 3 alerts ─────────────────────────────────────────
    void setAlerts(bool enabled, bool buzzer);           // any task (mutex-protected)

private:
    enum JobType : uint8_t { J_SCAN, J_CONNECT, J_DISCONNECT, J_INIT, J_CMD, J_ECU, J_VOLT };
    struct Job {
        JobType type;
        char arg[48];
        char arg2[12];
        char arg3[40];
    };

    bool enqueue(JobType t, const String& a, const String& b, const String& c, String& why);
    static void taskEntry(void* self);
    void taskLoop();
    void run(const Job& j);

    void doScan();
    void doConnect(const String& mac, const String& pin, const String& name, bool automatic);
    void doDisconnect(bool manual);
    bool doInit();
    void doCommand(const String& cmd);
    void doEcuTest();
    void doVoltage();

    void maintain();
    void pumpBridge();
    String sendRaw(const String& cmd, uint32_t timeoutMs);
    void setBt(BtState s, const String& error = "");
    void setLed(bool on);              // control the status LED

    // ── Non-blocking command (used by alert SM) ────────────────
    bool cmdBegin(const String& cmd, uint32_t timeoutMs);
    // 0=pending, 1=complete (out set), -1=timeout/disconnected
    int cmdPoll(String& out);

    // ── Phase 3: non-blocking alerts ───────────────────────────
    void alertTick();                  // advance alert state machine (no blocking)
    void beepStart(uint8_t pattern);   // start non-blocking beep pattern
    void beepTick();                   // advance beep pattern
    void alertSet(const String& msg);  // set/clear last alert in status

    template <typename F> void update(F fn);

    Settings* settings_ = nullptr;
    QueueHandle_t jobs_ = nullptr;
    SemaphoreHandle_t mtx_ = nullptr;
    ElmStatus st_;
    std::vector<ScanDevice> devices_;
    bool kwpFraming_ = false;     // ATH1 active: decode KWP frames for the log
    uint32_t lastAttemptMs_ = 0;
    uint16_t reconnectFails_ = 0;
    uint16_t maxReconnectFails_ = 3;  // stop auto-reconnect after this many failures
    bool ledEnabled_ = true;        // allow disable via settings
    bool reconnectGaveUp_ = false;  // logged once when max fails reached

    // Phase 3: alert config (guarded by mtx_ when written from other tasks)
    bool alertsEnabled_ = true;
    bool buzzerEnabled_ = true;

    // Non-blocking command state
    bool cmdActive_ = false;
    String cmdBuf_;
    uint32_t cmdStartMs_ = 0;
    uint32_t cmdTimeoutMs_ = 0;
    String cmdEcho_;

    // Alert state machine
    enum class AlertPhase : uint8_t { Idle, Wait2101, WaitAtrv, Cooldown };
    AlertPhase alertPhase_ = AlertPhase::Idle;
    uint32_t alertNextMs_ = 0;
    uint32_t alertCooldownUntilMs_ = 0;
    uint32_t lastBatteryWatchMs_ = 0;
    bool alertKwpInitTried_ = false;

    // Non-blocking beep state machine
    uint8_t beepRemaining_ = 0;
    bool beepOn_ = false;
    uint32_t beepNextMs_ = 0;
    uint32_t beepDurMs_ = 0;

    // bridge
    volatile bool bridge_ = false;
    volatile uint32_t epoch_ = 0;          // bumped on every attach
    volatile uint32_t syncedEpoch_ = 0;    // set by the Bluetooth task after flushing
    StreamBufferHandle_t toElm_ = nullptr;
    StreamBufferHandle_t fromElm_ = nullptr;
};

extern ElmLink elm;
