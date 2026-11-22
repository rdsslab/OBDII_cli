#include "kwp_decode.h"
#include <Arduino.h>
#include <cctype>
#include <sstream>

namespace kwp {

std::vector<uint8_t> hexToBytes(const std::string& hex) {
    std::vector<uint8_t> out;
    for (size_t i = 0; i + 1 < hex.length(); i++) {
        // Skip non-hex characters
        if (!isxdigit(static_cast<unsigned char>(hex[i])) || !isxdigit(static_cast<unsigned char>(hex[i + 1]))) continue;
        char buf[3] = {hex[i], hex[i + 1], 0};
        out.push_back(static_cast<uint8_t>(std::strtol(buf, nullptr, 16)));
        i++; // Skip next since we consumed 2 chars
    }
    // Strip positive KWP response prefix 61 01 (response to 21 01)
    if (out.size() >= 2 && out[0] == 0x61 && out[1] == 0x01) {
        out.erase(out.begin(), out.begin() + 2);
    }
    return out;
}

std::vector<uint8_t> hexToBytes(const String& hex) {
    return hexToBytes(std::string(hex.c_str()));
}

bool isValid2101Response(const std::string& response) {
    // Look for 61 01 pattern indicating positive response to 2101
    std::string upper = response;
    for (auto& c : upper) c = static_cast<char>(std::toupper(c));
    return upper.find("61 01") != std::string::npos;
}

EngineData decode2101(const std::vector<uint8_t>& data) {
    EngineData result;
    
    if (data.size() < 78) {
        result.valid = false;
        return result;
    }
    
    // Engine RPM: bytes 19-20 (little-endian), 1 RPM = 1 count
    // From ecu-profiles.js: le16(b, 19)
    result.rpm = le16(data, 19);
    
    // Battery voltage ECU: byte 0, 0.1V per count
    // From ecu-profiles.js: u8(b, 0) / 10
    result.voltage = u8(data, 0) / 10.0f;
    
    // Coolant temp: byte 3
    // From ecu-profiles.js: Math.round((v * 0.75 - 48) * 10) / 10
    // Formula: temp = byte * 0.75 - 48
    uint8_t ctRaw = u8(data, 3);
    result.coolantTemp = (ctRaw * 0.75f - 48.0f);
    
    // Engine state: byte 71 (bit field)
    // From ecu-profiles.js ENGINE_STATE_BITS:
    // 0x01 = stopped (parado)
    // 0x04 = idle (ralentí)
    // 0x08 = partial load (carga parcial)
    // 0x10 = fuel cut (corte combustible)
    // 0x28 = full load (plena carga)
    result.engineState = u8(data, 71);
    
    // Throttle position: bytes 6-7 (little-endian)
    // From ecu-profiles.js: (v - THROTTLE_CLOSED) / (THROTTLE_WOT - THROTTLE_CLOSED) * 100
    // THROTTLE_CLOSED = 13, THROTTLE_WOT = 49100
    uint16_t thrRaw = le16(data, 6);
    if (thrRaw >= 13 && thrRaw <= 49100) {
        result.throttle = ((thrRaw - 13) * 100.0f) / (49100 - 13);
    }
    
    result.valid = true;
    return result;
}

}  // namespace kwp