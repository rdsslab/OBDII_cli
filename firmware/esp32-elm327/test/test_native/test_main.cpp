// Unit tests for the pure logic, run on the PC:  pio test -e native
#include <unity.h>

#include "auth_core.h"
#include "obd_text.h"

using namespace obd;

void setUp() {}
void tearDown() {}

static void test_normalize() {
    TEST_ASSERT_EQUAL_STRING("2101", normalizeCommand(" 21 01 ").c_str());
    TEST_ASSERT_EQUAL_STRING("AT SH 81 11 F1", normalizeCommand("at  sh 81 11 f1").c_str());
}

static void test_allowlist() {
    const char* ok[] = {"ATZ", "ATRV", "AT SH 81 11 F1", "ATSP5", "0100", "03", "2101", "1A90", "1081", "1089", "18FF00", "3E", "81", "0902"};
    for (auto* c : ok) TEST_ASSERT_TRUE_MESSAGE(checkCommand(c).ok, c);
    const char* bad[] = {"14FF00", "04", "1101", "1085", "2E0101", "3101", "3001", "2F0101", "2701", "3B90", "08", "ATPP 0C SV 23", "ATMA", "ATBRD 23", "21 0", "21G1", ""};
    for (auto* c : bad) TEST_ASSERT_FALSE_MESSAGE(checkCommand(c).ok, c);
}

static void test_clean_and_errors() {
    TEST_ASSERT_EQUAL_STRING("ELM327 v1.5", cleanResponse("ATZ\r\r\rELM327 v1.5\r\r>", "ATZ").c_str());
    TEST_ASSERT_EQUAL_STRING("83 F1 11 C1 EF 8F C4", cleanResponse("BUS INIT: ...OK\r83 F1 11 C1 EF 8F C4\r\r>").c_str());
    TEST_ASSERT_TRUE(isElmError("BUS INIT: ...ERROR"));
    TEST_ASSERT_TRUE(isElmError("NO DATA"));
    TEST_ASSERT_TRUE(isElmError("?"));
    TEST_ASSERT_FALSE(isElmError("41 00 BE 3E B8 11"));
    TEST_ASSERT_TRUE(isNegativeResponse("7F 21 12"));
    TEST_ASSERT_FALSE(isNegativeResponse("61 01 7C"));
}

static void test_version_voltage() {
    TEST_ASSERT_EQUAL_STRING("ELM327 v1.5", extractVersion("ELM327 v1.5").c_str());
    TEST_ASSERT_EQUAL_STRING("ELM327 (versión desconocida)", extractVersion("OK").c_str());
    float v = 0;
    TEST_ASSERT_TRUE(parseVoltage("12.3V", v));
    TEST_ASSERT_FLOAT_WITHIN(0.01, 12.3, v);
    TEST_ASSERT_FALSE(parseVoltage("NO DATA", v));
}

static void test_kwp_frames() {
    // 83 F1 11 | C1 EF 8F | checksum = 0x83+0xF1+0x11+0xC1+0xEF+0x8F = 0x3C4 -> C4
    std::vector<std::vector<uint8_t>> m;
    TEST_ASSERT_TRUE(decodeKwpFrames("83 F1 11 C1 EF 8F C4", m));
    TEST_ASSERT_EQUAL(1, m.size());
    TEST_ASSERT_EQUAL_STRING("C1 EF 8F", toHex(m[0]).c_str());
    // positive session response 50 81, two frames on separate lines
    TEST_ASSERT_TRUE(decodeKwpFrames("82 F1 11 50 81 55\n83 F1 11 C1 EF 8F C4", m));
    TEST_ASSERT_EQUAL(2, m.size());
    TEST_ASSERT_EQUAL_HEX8(0x50, m[0][0]);
    // bad checksum / incomplete
    TEST_ASSERT_FALSE(decodeKwpFrames("83 F1 11 C1 EF 8F C5", m));
    TEST_ASSERT_FALSE(decodeKwpFrames("83 F1 11 C1 EF", m));
    // length byte form: fmt 80, len 03
    TEST_ASSERT_TRUE(decodeKwpFrames("80 F1 11 03 61 01 7C 63", m));
    TEST_ASSERT_EQUAL_STRING("61 01 7C", toHex(m[0]).c_str());
}

static void test_auth() {
    auth::LoginGuard g(3, 1000);
    g.fail(10); g.fail(20);
    TEST_ASSERT_EQUAL(0, g.lockedFor(30));
    g.fail(30);
    TEST_ASSERT_TRUE(g.lockedFor(40) > 0);
    TEST_ASSERT_EQUAL(0, g.lockedFor(1100));

    auth::SessionTable<2> t(1000);
    t.add("aaaaaaaaaaaaaaaa", 0);
    t.add("bbbbbbbbbbbbbbbb", 10);
    TEST_ASSERT_TRUE(t.check("aaaaaaaaaaaaaaaa", 500));   // refreshes a
    t.add("cccccccccccccccc", 600);                       // replaces the oldest (b)
    TEST_ASSERT_FALSE(t.check("bbbbbbbbbbbbbbbb", 600));
    TEST_ASSERT_TRUE(t.check("cccccccccccccccc", 700));
    TEST_ASSERT_FALSE(t.check("aaaaaaaaaaaaaaaa", 2000)); // expired
    TEST_ASSERT_FALSE(t.check("short", 0));

    TEST_ASSERT_EQUAL_STRING("abc", auth::cookieValue("x=1; obd_sess=abc; y=2", "obd_sess").c_str());
    TEST_ASSERT_EQUAL_STRING("", auth::cookieValue("obd_sessx=1", "obd_sess").c_str());
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_normalize);
    RUN_TEST(test_allowlist);
    RUN_TEST(test_clean_and_errors);
    RUN_TEST(test_version_voltage);
    RUN_TEST(test_kwp_frames);
    RUN_TEST(test_auth);
    return UNITY_END();
}
