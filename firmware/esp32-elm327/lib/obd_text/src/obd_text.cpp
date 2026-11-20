#include "obd_text.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>

namespace obd {

namespace {

std::string upper(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return s;
}

std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) a++;
    while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) b--;
    return s.substr(a, b - a);
}

bool startsWith(const std::string& s, const char* p) { return s.rfind(p, 0) == 0; }

bool isHexChar(char c) { return std::isxdigit(static_cast<unsigned char>(c)) != 0; }

bool isInfoLine(const std::string& lineUpper) {
    if (startsWith(lineUpper, "SEARCHING")) return true;
    if (startsWith(lineUpper, "BUS INIT")) {
        // "BUS INIT: OK" / "BUS INIT: ..." are informational, "BUS INIT: ...ERROR" is not
        return lineUpper.find("ERROR") == std::string::npos;
    }
    return false;
}

}  // namespace

std::string normalizeCommand(const std::string& cmd) {
    std::string c = upper(trim(cmd));
    if (startsWith(c, "AT")) {
        // collapse runs of spaces
        std::string out;
        for (char ch : c) {
            if (ch == ' ' && !out.empty() && out.back() == ' ') continue;
            out += ch;
        }
        return out;
    }
    std::string out;
    for (char ch : c) if (ch != ' ') out += ch;
    return out;
}

CommandCheck checkCommand(const std::string& cmdIn) {
    const std::string c = normalizeCommand(cmdIn);
    if (c.empty()) return {false, "Comando vacío"};
    if (c.size() > 40) return {false, "Comando demasiado largo"};
    for (char ch : c) {
        if (ch < 0x20 || ch > 0x7E) return {false, "Caracteres no válidos"};
    }

    if (startsWith(c, "AT")) {
        std::string a;
        for (char ch : c.substr(2)) if (ch != ' ') a += ch;
        // Permanent adapter changes, baud-rate changes, bus monitors (never end)
        static const char* blocked[] = {"PP", "BRD", "BRT", "MA", "MR", "MT", "CSM", "SD", "PB"};
        for (auto* b : blocked) {
            if (startsWith(a, b)) return {false, "Comando AT bloqueado: cambia el adaptador de forma permanente o monitorea el bus sin fin"};
        }
        return {true, ""};
    }

    // Diagnostic request: hex bytes only
    if (c.size() % 2 != 0) return {false, "Los comandos de diagnóstico van en bytes hexadecimales (por ejemplo 2101)"};
    for (char ch : c) if (!isHexChar(ch)) return {false, "Los comandos de diagnóstico van en bytes hexadecimales (por ejemplo 2101)"};

    const int sid = std::strtol(c.substr(0, 2).c_str(), nullptr, 16);
    const int sub = c.size() >= 4 ? std::strtol(c.substr(2, 2).c_str(), nullptr, 16) : -1;
    switch (sid) {
        // OBD2 read-only modes
        case 0x01: case 0x02: case 0x03: case 0x05: case 0x06: case 0x07: case 0x09: case 0x0A:
        // KWP2000 read-only services
        case 0x13: case 0x17: case 0x18:      // read DTCs / status
        case 0x1A:                             // read ECU identification
        case 0x21: case 0x22:                  // read data by local id / common id
        case 0x3E:                             // tester present
        case 0x81: case 0x82:                  // start / stop communication
            return {true, ""};
        case 0x10:
            // only the normal sessions; 0x85 is ECU programming mode
            if (sub == 0x81 || sub == 0x89 || sub == 0xC0) return {true, ""};
            return {false, "Solo se permiten las sesiones 10 81, 10 89 y 10 C0 (10 85 es programación de la ECU)"};
        case 0x04: case 0x14:
            return {false, "Borrar códigos solo se hace desde la función con confirmación y PIN (fase 3)"};
        case 0x11:
            return {false, "El reinicio de la ECU (11) está bloqueado"};
        default:
            return {false, "Servicio bloqueado: solo se permiten lecturas (sin escrituras, rutinas ni pruebas de actuadores)"};
    }
}

std::string cleanResponse(const std::string& raw, const std::string& echo) {
    std::string text;
    text.reserve(raw.size());
    for (char ch : raw) {
        if (ch == '>') continue;
        text += (ch == '\r') ? '\n' : ch;
    }
    const std::string echoUp = upper(trim(echo));
    std::string out;
    size_t pos = 0;
    while (pos <= text.size()) {
        size_t nl = text.find('\n', pos);
        if (nl == std::string::npos) nl = text.size();
        const std::string line = trim(text.substr(pos, nl - pos));
        const std::string up = upper(line);
        if (!line.empty() && !isInfoLine(up) && !(echoUp.size() && up == echoUp)) {
            if (!out.empty()) out += '\n';
            out += line;
        }
        pos = nl + 1;
    }
    return out;
}

bool isElmError(const std::string& resp) {
    const std::string u = upper(resp);
    static const char* errors[] = {"NO DATA", "UNABLE TO CONNECT", "BUS INIT: ERROR", "BUS ERROR", "CAN ERROR",
                                   "ERROR", "STOPPED", "<DATA ERROR", "TIMEOUT"};
    for (auto* e : errors) if (u.find(e) != std::string::npos) return true;
    return trim(u) == "?";
}

bool isNegativeResponse(const std::string& resp) {
    const std::vector<uint8_t> b = hexBytes(resp);
    for (size_t i = 0; i + 2 < b.size(); i++) if (b[i] == 0x7F) return true;
    return false;
}

std::string extractVersion(const std::string& resp) {
    const std::string u = upper(resp);
    const size_t p = u.find("ELM327");
    if (p == std::string::npos) return "ELM327 (versión desconocida)";
    size_t v = u.find('V', p + 6);
    if (v == std::string::npos || v > p + 8) return "ELM327";
    size_t e = v + 1;
    while (e < u.size() && (std::isdigit(static_cast<unsigned char>(u[e])) || u[e] == '.')) e++;
    return "ELM327 v" + resp.substr(v + 1, e - v - 1);
}

bool parseVoltage(const std::string& resp, float& volts) {
    for (size_t i = 0; i < resp.size(); i++) {
        if (std::isdigit(static_cast<unsigned char>(resp[i]))) {
            char* end = nullptr;
            const float v = std::strtof(resp.c_str() + i, &end);
            if (end && (*end == 'V' || *end == 'v') && v > 0.0f && v < 40.0f) {
                volts = v;
                return true;
            }
            while (i < resp.size() && (std::isdigit(static_cast<unsigned char>(resp[i])) || resp[i] == '.')) i++;
        }
    }
    return false;
}

std::vector<uint8_t> hexBytes(const std::string& text) {
    std::vector<uint8_t> out;
    const size_t n = text.size();
    for (size_t i = 0; i + 1 < n; i++) {
        const bool leftOk = i == 0 || !std::isalnum(static_cast<unsigned char>(text[i - 1]));
        const bool rightOk = i + 2 >= n || !std::isalnum(static_cast<unsigned char>(text[i + 2]));
        if (leftOk && rightOk && isHexChar(text[i]) && isHexChar(text[i + 1])) {
            out.push_back(static_cast<uint8_t>(std::strtol(text.substr(i, 2).c_str(), nullptr, 16)));
            i++;
        }
    }
    return out;
}

bool decodeKwpFrames(const std::string& text, std::vector<std::vector<uint8_t>>& messages) {
    messages.clear();
    const std::vector<uint8_t> b = hexBytes(text);
    if (b.empty()) return false;
    size_t i = 0;
    while (i < b.size()) {
        const size_t start = i;
        const uint8_t fmt = b[i++];
        if ((fmt & 0xC0) != 0) i += 2;             // target + source
        size_t len = fmt & 0x3F;
        if (len == 0) {
            if (i >= b.size()) return false;
            len = b[i++];                           // extra length byte
        }
        if (i + len >= b.size()) return false;      // incomplete (no checksum)
        std::vector<uint8_t> data(b.begin() + i, b.begin() + i + len);
        i += len;
        uint8_t sum = 0;
        for (size_t k = start; k < i; k++) sum = static_cast<uint8_t>(sum + b[k]);
        if (b[i++] != sum) return false;
        messages.push_back(data);
    }
    return true;
}

std::string toHex(const std::vector<uint8_t>& bytes) {
    std::string out;
    char buf[4];
    for (size_t i = 0; i < bytes.size(); i++) {
        std::snprintf(buf, sizeof buf, i ? " %02X" : "%02X", bytes[i]);
        out += buf;
    }
    return out;
}

}  // namespace obd
