// Thread-safe hand-off of log lines and "something changed" flags from the
// Bluetooth task to the web task (which turns them into Server-Sent Events).
#pragma once
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <deque>
#include <functional>

#include "config.h"

struct LogLine {
    uint32_t id;
    uint32_t uptimeMs;
    char level;          // 'i' info, 'w' warn, 't' TX, 'r' RX
    String msg;
};

class EventBus {
public:
    void begin() { mtx_ = xSemaphoreCreateMutex(); }

    void log(char level, const String& msg) {
        Serial.printf("[%c] %s\n", level, msg.c_str());
        lock();
        history_.push_back({++lastId_, millis(), level, msg});
        while (history_.size() > LOG_LINES) history_.pop_front();
        unlock();
    }
    void info(const String& m) { log('i', m); }
    void warn(const String& m) { log('w', m); }

    void stateChanged() { stateDirty_ = true; }
    void scanChanged() { scanDirty_ = true; }

    // Called from the web task: every line newer than *cursor, then flags.
    // Callback runs under lock to avoid heap allocations on fragmented heaps.
    void drain(uint32_t& cursor, const std::function<void(const LogLine&)>& onLine) {
        lock();
        for (const auto& l : history_) {
            if (l.id > cursor) { onLine(l); cursor = l.id; }
        }
        unlock();
    }
    bool takeState() { bool d = stateDirty_; stateDirty_ = false; return d; }
    bool takeScan() { bool d = scanDirty_; scanDirty_ = false; return d; }

    // Snapshot of the whole history (GET /api/log).
    std::deque<LogLine> history() {
        lock();
        std::deque<LogLine> copy = history_;
        unlock();
        return copy;
    }

private:
    void lock() { if (mtx_) xSemaphoreTake(mtx_, portMAX_DELAY); }
    void unlock() { if (mtx_) xSemaphoreGive(mtx_); }
    SemaphoreHandle_t mtx_ = nullptr;
    std::deque<LogLine> history_;
    uint32_t lastId_ = 0;
    volatile bool stateDirty_ = true;
    volatile bool scanDirty_ = false;
};

extern EventBus bus;
