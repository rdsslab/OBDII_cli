// Pure text/byte helpers for ELM327 + KWP2000 (no Arduino dependencies, so
// they are unit-tested on the PC with `pio test -e native`).
// Ported from packages/core/src/elm327.js — keep both in sync.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace obd {

// Uppercase, trim, and for hex (non-AT) commands drop the spaces: "21 01" -> "2101".
std::string normalizeCommand(const std::string& cmd);

struct CommandCheck {
    bool ok;
    std::string reason;   // why it was refused (Spanish, shown in the UI)
};

// Allowlist for the web terminal: AT commands (except the few that change
// the adapter permanently or flood it) and READ-ONLY diagnostic services.
// Clearing DTCs (04 / 14), ECU reset (11), writes, routines and actuator
// tests are refused.
CommandCheck checkCommand(const std::string& cmd);

// Drop the '>' prompt, CR/LF noise, echo and informational lines
// (SEARCHING..., BUS INIT: OK). Lines are joined with '\n'.
std::string cleanResponse(const std::string& raw, const std::string& echo = "");

// NO DATA, UNABLE TO CONNECT, BUS INIT: ERROR, ... or TIMEOUT.
bool isElmError(const std::string& resp);

// 7F <service> <code>
bool isNegativeResponse(const std::string& resp);

// "ELM327 v1.5" (or "ELM327 (versión desconocida)")
std::string extractVersion(const std::string& resp);

// "12.3V" -> 12.3
bool parseVoltage(const std::string& resp, float& volts);

// Every "XX" hex byte found in the text.
std::vector<uint8_t> hexBytes(const std::string& text);

// Decode KWP2000 frames shown with ATH1 ([fmt] [tgt] [src] ([len]) data [cs]),
// verifying the checksum. Returns false if the bytes are not valid frames.
bool decodeKwpFrames(const std::string& text, std::vector<std::vector<uint8_t>>& messages);

std::string toHex(const std::vector<uint8_t>& bytes);

}  // namespace obd
