// KWP2000 data block decoding for Phase 3 (alerts without panel open)
// Ported from packages/core/src/ecu-profiles.js (BLOCK_01)
// Only the fields confirmed for SIM2K-33 engine:
//   - Engine RPM (byte 19-20, little-endian)
//   - Battery voltage ECU (byte 0, 0.1V units)
//   - Coolant temp (byte 3, 0.75°C units, offset -48)
//   - Engine state (byte 71, bit field)
#pragma once

#include <Arduino.h>
#include <cstdint>
#include <string>
#include <vector>

namespace kwp {

/**
 * Little-endian 16-bit from byte array.
 * Returns 0 if index out of bounds.
 */
inline uint16_t le16(const std::vector<uint8_t>& b, size_t i) {
    if (i + 1 >= b.size()) return 0;
    return b[i] | (b[i + 1] << 8);
}

/**
 * Unsigned 8-bit from byte array.
 * Returns 0 if index out of bounds.
 */
inline uint8_t u8(const std::vector<uint8_t>& b, size_t i) {
    return i < b.size() ? b[i] : 0;
}

/**
 * Decode engine data from KWP 2101 response (78 bytes).
 * Returns a struct with decoded values.
 */
struct EngineData {
    uint16_t rpm = 0;          // Engine RPM
    float voltage = 0.0f;      // Battery voltage (V)
    float coolantTemp = 0.0f;  // Coolant temperature (°C)
    uint8_t engineState = 0; // Engine state bits
    float throttle = 0.0f;   // Throttle position (%)
    bool valid = false;      // Whether data was valid
};

/**
 * Decode 2101 block data.
 * @param data 78 bytes of DATA (without 61 01 prefix)
 * @return decoded engine data
 */
EngineData decode2101(const std::vector<uint8_t>& data);

/**
 * Decode hex string to bytes (for parsing ELM327 responses).
 * Input: "61 01 8C 3D 39 B4 51 A3 ..." (response from 2101)
 * Returns the DATA bytes (everything after 61 01).
 */
std::vector<uint8_t> hexToBytes(const std::string& hex);
std::vector<uint8_t> hexToBytes(const String& hex);  // Arduino String overload

/**
 * Check if response to 2101 contains valid data.
 */
bool isValid2101Response(const std::string& response);

}  // namespace kwp