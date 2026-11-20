// Login rate limiting, session table and cookie parsing (pure, header-only;
// unit-tested on the PC). Time and random tokens are injected by the caller.
#pragma once
#include <cstdint>
#include <string>

namespace auth {

// 5 wrong passwords -> locked for 60 s (same policy as the @obdii/server PIN).
class LoginGuard {
public:
    LoginGuard(uint8_t maxFails = 5, uint32_t lockMs = 60000) : maxFails_(maxFails), lockMs_(lockMs) {}

    // Remaining lock time in ms (0 = may try).
    uint32_t lockedFor(uint32_t now) const {
        return (lockedUntil_ && static_cast<int32_t>(lockedUntil_ - now) > 0) ? lockedUntil_ - now : 0;
    }
    void fail(uint32_t now) {
        if (++fails_ >= maxFails_) {
            fails_ = 0;
            lockedUntil_ = now + lockMs_;
            if (lockedUntil_ == 0) lockedUntil_ = 1;
        }
    }
    void success() { fails_ = 0; lockedUntil_ = 0; }

private:
    uint8_t maxFails_;
    uint32_t lockMs_;
    uint8_t fails_ = 0;
    uint32_t lockedUntil_ = 0;
};

// Fixed-size table of session tokens with sliding expiry. When full, the
// oldest session is replaced.
template <size_t N>
class SessionTable {
public:
    explicit SessionTable(uint32_t ttlMs) : ttl_(ttlMs) {}

    void add(const std::string& token, uint32_t now) {
        size_t slot = N, oldest = 0;
        uint32_t maxAge = 0;
        for (size_t i = 0; i < N; i++) {
            if (s_[i].token.empty() || expired(s_[i], now)) { slot = i; break; }
            const uint32_t age = now - s_[i].lastSeen;
            if (age >= maxAge) { maxAge = age; oldest = i; }
        }
        if (slot == N) slot = oldest;
        s_[slot].token = token;
        s_[slot].lastSeen = now;
    }

    bool check(const std::string& token, uint32_t now) {
        if (token.size() < 16) return false;
        for (auto& s : s_) {
            if (!s.token.empty() && constEq(s.token, token)) {
                if (expired(s, now)) { s.token.clear(); return false; }
                s.lastSeen = now;
                return true;
            }
        }
        return false;
    }

    void remove(const std::string& token) {
        for (auto& s : s_) if (!s.token.empty() && constEq(s.token, token)) s.token.clear();
    }
    void clear() { for (auto& s : s_) s.token.clear(); }

    size_t active(uint32_t now) const {
        size_t n = 0;
        for (auto& s : s_) if (!s.token.empty() && !expired(s, now)) n++;
        return n;
    }

private:
    struct Slot { std::string token; uint32_t lastSeen = 0; };
    bool expired(const Slot& s, uint32_t now) const { return now - s.lastSeen > ttl_; }
    static bool constEq(const std::string& a, const std::string& b) {
        if (a.size() != b.size()) return false;
        uint8_t d = 0;
        for (size_t i = 0; i < a.size(); i++) d |= static_cast<uint8_t>(a[i] ^ b[i]);
        return d == 0;
    }
    uint32_t ttl_;
    Slot s_[N];
};

// Value of a cookie in a "Cookie:" header ("a=1; obd_sess=abc") or "".
inline std::string cookieValue(const std::string& header, const std::string& name) {
    size_t pos = 0;
    while (pos < header.size()) {
        while (pos < header.size() && (header[pos] == ' ' || header[pos] == ';')) pos++;
        size_t eq = header.find('=', pos);
        size_t end = header.find(';', pos);
        if (end == std::string::npos) end = header.size();
        if (eq != std::string::npos && eq < end && header.compare(pos, eq - pos, name) == 0) {
            return header.substr(eq + 1, end - eq - 1);
        }
        pos = end + 1;
    }
    return "";
}

// Constant-time comparison of two hex digests.
inline bool digestEq(const std::string& a, const std::string& b) {
    if (a.size() != b.size() || a.empty()) return false;
    uint8_t d = 0;
    for (size_t i = 0; i < a.size(); i++) d |= static_cast<uint8_t>(a[i] ^ b[i]);
    return d == 0;
}

}  // namespace auth
