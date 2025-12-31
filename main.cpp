#include <Arduino.h>
#include "driver/gpio.h"
#include "HX711.h"
#include <WiFi.h>
#include <WebServer.h>

#include <FS.h>
#include <LittleFS.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"

// =======================================================
// ======================= FW INFO =======================
// =======================================================
const char* FW_PROGRAM     = "HANWOOL FLASH";
const char* FW_PROG_VER    = "v6";
const char* FW_PROG_BUILD  = "B0.3";

const char* FW_VER_BUILD   = "FLASH-F v1 · B0";
const char* FW_BOARD       = "ESP32-S3 FLASH-G Board1";
const char* FW_PROTOCOL    = "FLASH JSON v1.0";

// =======================================================
// ======================== PINS =========================
// =======================================================
int piezo        = 11;
int led1         = 4;
int led2         = 5;
int switch1      = 14;
int rly1         = 16;
int rly2         = 17;
int ig_sens      = 21;
int pressure_sig = 7;
int hx711_dt     = 6;
int hx711_clk    = 9;
int ign_adc_pin  = 15;

// =======================================================
// ===================== CONFIG/STATE ====================
// =======================================================
static constexpr float ADC_TO_V = 3.3f / 4095.0f;

// 샘플 루프(스냅샷 갱신) 주기: UI/로깅용
static constexpr uint32_t SAMPLE_PERIOD_MS = 10; // 100Hz 스냅샷

// ✅ RelaySafe 오탐 방지: OFF 명령 후 실제 핀 HIGH가 이 시간 이상 지속될 때만 LOCKOUT
static constexpr uint32_t RELAYSAFE_CONFIRM_MS = 120;

// -------------------- igs 모드 --------------------
volatile int igs = 1;

// -------------------- RelaySafe --------------------
// switch가 OFF인데 릴레이 핀이 HIGH(비정상)면 LOCKOUT(재부팅 전까지 해제 불가)
volatile int relaySafe = 1;          // ✅ 기본 ON
volatile int relayFault = 0;         // 0/1 (latched)
volatile uint8_t relayFaultMask = 0; // bit0=rly1, bit1=rly2

// -------------------- (옵션) 시리얼 JSON 스트림 --------------------
volatile int serialStream = 1;       // 1=JSON 계속 출력, 0=출력 중지 (/set?stream=0|1)

// -------------------- 로드셀 --------------------
HX711 hx711;
float thrust_cal_factor = 6510.0f;
volatile float currentThrust = 0.0f;

// -------------------- SoftAP --------------------
const char* ap_ssid     = "HANWOOL_TMS_BOARD";
const char* ap_password = "12345678";
unsigned long systemStartTime = 0;

WebServer server(80);
bool fsReady = false;

// -------------------- 상태 머신 --------------------
enum SystemState : uint8_t { ST_IDLE = 0, ST_COUNTDOWN = 1, ST_FIRING = 2 };
volatile SystemState currentState = ST_IDLE;

volatile uint32_t stateStartTimeMs    = 0;
volatile uint32_t countdownDurationMs = 10000; // 3~30s
volatile uint32_t ignitionDurationMs  = 5000;  // 1~10s

// 🔁 대시보드 동기화 상태
volatile int webUserWaiting = 0;
volatile int webAbortFlag   = 0;
volatile uint32_t webPrecountMs = 10000;

static portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;

// =======================================================
// ====================== FAST IO =========================
// =======================================================
static inline int fastRead(int pin) {
  return gpio_get_level((gpio_num_t)pin);
}
static inline void fastWrite(int pin, int level) {
  gpio_set_level((gpio_num_t)pin, level);
}

// =======================================================
// =================== SAMPLE SNAPSHOT ====================
// =======================================================
struct SampleSnap {
  float t;          // thrust
  float p;          // pressure (V)
  float iv;         // igniter sense (V)
  uint32_t ut;      // uptime ms
  uint16_t lt;      // 샘플 주기(ms)
  uint16_t ct;      // SamplerTask 계산시간(us)
  uint16_t hz;      // HX711 update Hz
  uint8_t  s;       // switch
  uint8_t  ic;      // ign_ok
  uint8_t  r;       // relay mask (bit0=rly1 bit1=rly2)
  uint8_t  gs;      // igs
  uint8_t  st;      // state
  uint16_t cd;      // countdown remaining ms
  uint8_t  uw;      // user waiting
  uint8_t  ab;      // abort flag
  uint8_t  m;       // mode (0=SERIAL, 1=WIFI station connected)
  uint8_t  rs;      // relaySafe enabled
  uint8_t  rf;      // relayFault latched (LOCKOUT)
  uint8_t  rm;      // relayFaultMask
  uint8_t  ss;      // serialStream
};

static portMUX_TYPE sampleMux = portMUX_INITIALIZER_UNLOCKED;
static SampleSnap lastSnap = {0};

static inline SampleSnap getLastSnapCopy() {
  SampleSnap s;
  portENTER_CRITICAL(&sampleMux);
  s = lastSnap;
  portEXIT_CRITICAL(&sampleMux);
  return s;
}

static inline bool isLocked(uint8_t* outMask = nullptr) {
  bool locked;
  uint8_t mask;
  portENTER_CRITICAL(&stateMux);
  locked = (relayFault != 0);
  mask = relayFaultMask;
  portEXIT_CRITICAL(&stateMux);
  if (outMask) *outMask = mask;
  return locked;
}

// =======================================================
// =================== FILE SERVE HELPERS =================
// =======================================================
void serveFile(const char* path, const char* contentType) {
  if (!LittleFS.exists(path)) {
    server.send(404, "text/plain", String("File not found: ") + path);
    return;
  }
  File file = LittleFS.open(path, "r");
  if (!file) {
    server.send(500, "text/plain", "Failed to open file");
    return;
  }
  server.streamFile(file, contentType);
  file.close();
}

// =======================================================
// ======================= WEB PAGES ======================
// =======================================================
void handleRoot()      { serveFile("/home.html",      "text/html; charset=utf-8"); }
void dashboard()       { serveFile("/dashboard.html", "text/html; charset=utf-8"); }
void overlay()         { serveFile("/overlay.html",   "text/html; charset=utf-8"); }

// =======================================================
// ====================== JSON OUTPUT =====================
// =======================================================
static void buildJson(char* out, size_t outLen, const SampleSnap& s) {
  snprintf(out, outLen,
           "{\"t\":%.3f,\"p\":%.3f,\"iv\":%.3f,\"ut\":%lu,\"lt\":%u,\"ct\":%u,\"hz\":%u,"
           "\"s\":%u,\"ic\":%u,\"r\":%u,\"gs\":%u,"
           "\"st\":%u,\"cd\":%u,\"uw\":%u,\"ab\":%u,\"m\":%u,"
           "\"rs\":%u,\"rf\":%u,\"rm\":%u,\"ss\":%u,"
           "\"fw_program\":\"%s\",\"fw_ver\":\"%s\",\"fw_build\":\"%s\","
           "\"fw_ver_build\":\"%s\",\"fw_board\":\"%s\",\"fw_protocol\":\"%s\"}",
           s.t, s.p, s.iv, (unsigned long)s.ut, (unsigned)s.lt, (unsigned)s.ct, (unsigned)s.hz,
           (unsigned)s.s, (unsigned)s.ic, (unsigned)s.r, (unsigned)s.gs,
           (unsigned)s.st, (unsigned)s.cd, (unsigned)s.uw, (unsigned)s.ab, (unsigned)s.m,
           (unsigned)s.rs, (unsigned)s.rf, (unsigned)s.rm, (unsigned)s.ss,
           FW_PROGRAM, FW_PROG_VER, FW_PROG_BUILD, FW_VER_BUILD, FW_BOARD, FW_PROTOCOL);
}

void handleData() {
  static char json[768];
  const SampleSnap s = getLastSnapCopy();
  buildJson(json, sizeof(json), s);
  server.send(200, "application/json", json);
}

void handleGraphicData() {
  static char json[768];
  const SampleSnap s = getLastSnapCopy();
  buildJson(json, sizeof(json), s);
  server.send(200, "application/json", json);
}

// =======================================================
// ===================== CORE LOGIC =======================
// =======================================================
static inline void startCountdownNow(uint32_t now) {
  currentState = ST_COUNTDOWN;
  stateStartTimeMs = now;
  webAbortFlag = 0;
  webUserWaiting = 0;
}

static inline void startFiringNow(uint32_t now) {
  currentState = ST_FIRING;
  stateStartTimeMs = now;
  webAbortFlag = 0;
  webUserWaiting = 0;
}

static inline void setIdleAbort() {
  currentState = ST_IDLE;
  webAbortFlag = 1;
  webUserWaiting = 0;
}

static inline void applySetKV(const String& key, const String& val) {
  if (key == "igs") {
    int v = val.toInt();
    v = (v != 0) ? 1 : 0;
    igs = v;
  } else if (key == "rs") {
    int v = val.toInt();
    v = (v != 0) ? 1 : 0;
    relaySafe = v;
  } else if (key == "stream") {
    int v = val.toInt();
    v = (v != 0) ? 1 : 0;
    serialStream = v;
  } else if (key == "ign_ms") {
    long v = val.toInt();
    if (v < 1000)  v = 1000;
    if (v > 10000) v = 10000;
    ignitionDurationMs = (uint32_t)v;
  } else if (key == "cd_ms") {
    long v = val.toInt();
    if (v < 3000)  v = 3000;
    if (v > 30000) v = 30000;
    countdownDurationMs = (uint32_t)v;
    if (webUserWaiting == 0) webPrecountMs = (uint32_t)v;
  }
}

static inline void applyQueryLike(const String& queryPart) {
  int start = 0;
  while (start < (int)queryPart.length()) {
    int amp = queryPart.indexOf('&', start);
    if (amp < 0) amp = queryPart.length();
    String pair = queryPart.substring(start, amp);
    int eq = pair.indexOf('=');
    if (eq > 0) {
      String k = pair.substring(0, eq);
      String v = pair.substring(eq + 1);
      k.trim(); v.trim();
      applySetKV(k, v);
    }
    start = amp + 1;
  }
}

// =======================================================
// ===================== API HANDLERS =====================
// =======================================================
static inline void sendLockedHttp() {
  uint8_t mask = 0;
  isLocked(&mask);
  server.send(423, "text/plain", String("LOCKED_REBOOT_REQUIRED RM=") + (int)mask);
}

void handleSetIGS() {
  if (isLocked()) { sendLockedHttp(); return; }

  bool anyParam = false;
  String resp;

  if (server.hasArg("igs")) {
    int v = server.arg("igs").toInt();
    v = (v != 0) ? 1 : 0;
    portENTER_CRITICAL(&stateMux);
    igs = v;
    portEXIT_CRITICAL(&stateMux);
    resp += "IGS=" + String(v);
    anyParam = true;
  }

  if (server.hasArg("rs")) {
    int v = server.arg("rs").toInt();
    v = (v != 0) ? 1 : 0;
    portENTER_CRITICAL(&stateMux);
    relaySafe = v;
    portEXIT_CRITICAL(&stateMux);
    if (resp.length()) resp += ", ";
    resp += "RS=" + String(v);
    anyParam = true;
  }

  if (server.hasArg("stream")) {
    int v = server.arg("stream").toInt();
    v = (v != 0) ? 1 : 0;
    portENTER_CRITICAL(&stateMux);
    serialStream = v;
    portEXIT_CRITICAL(&stateMux);
    if (resp.length()) resp += ", ";
    resp += "STREAM=" + String(v);
    anyParam = true;
  }

  if (server.hasArg("ign_ms")) {
    long v = server.arg("ign_ms").toInt();
    if (v < 1000)  v = 1000;
    if (v > 10000) v = 10000;

    portENTER_CRITICAL(&stateMux);
    ignitionDurationMs = (uint32_t)v;
    portEXIT_CRITICAL(&stateMux);

    if (resp.length()) resp += ", ";
    resp += "IGN_MS=" + String((uint32_t)v);
    anyParam = true;
  }

  if (server.hasArg("cd_ms")) {
    long v = server.arg("cd_ms").toInt();
    if (v < 3000)  v = 3000;
    if (v > 30000) v = 30000;

    portENTER_CRITICAL(&stateMux);
    countdownDurationMs = (uint32_t)v;
    if (webUserWaiting == 0) webPrecountMs = (uint32_t)v;
    portEXIT_CRITICAL(&stateMux);

    if (resp.length()) resp += ", ";
    resp += "CD_MS=" + String((uint32_t)v);
    anyParam = true;
  }

  if (!anyParam) server.send(400, "text/plain", "NO PARAM");
  else server.send(200, "text/plain", resp);
}

void handleIgnite() {
  if (isLocked()) { sendLockedHttp(); return; }
  const uint32_t now = millis();
  portENTER_CRITICAL(&stateMux);
  startFiringNow(now);
  portEXIT_CRITICAL(&stateMux);
  server.send(200, "text/plain", "IGNITION_IMMEDIATE");
}

void handleForceIgnite() {
  if (isLocked()) { sendLockedHttp(); return; }
  const uint32_t now = millis();
  portENTER_CRITICAL(&stateMux);
  startFiringNow(now);
  portEXIT_CRITICAL(&stateMux);
  server.send(200, "text/plain", "FORCE_IGNITION_OK");
}

void handleCountdownStart() {
  if (isLocked()) { sendLockedHttp(); return; }
  const uint32_t now = millis();
  bool ok = false;
  portENTER_CRITICAL(&stateMux);
  if (currentState == ST_IDLE) {
    startCountdownNow(now);
    ok = true;
  }
  portEXIT_CRITICAL(&stateMux);

  if (ok) server.send(200, "text/plain", "COUNTDOWN_STARTED");
  else    server.send(400, "text/plain", "BUSY");
}

void handleAbort() {
  if (isLocked()) { sendLockedHttp(); return; }

  portENTER_CRITICAL(&stateMux);
  setIdleAbort();
  portEXIT_CRITICAL(&stateMux);

  fastWrite(rly1, LOW);
  fastWrite(rly2, LOW);
  noTone(piezo);

  server.send(200, "text/plain", "ABORTED");
}

void handlePrecount() {
  if (isLocked()) { sendLockedHttp(); return; }

  if (!server.hasArg("uw")) {
    server.send(400, "text/plain", "NO PARAM");
    return;
  }

  int v = server.arg("uw").toInt();
  v = (v != 0) ? 1 : 0;

  portENTER_CRITICAL(&stateMux);
  webUserWaiting = v;

  if (server.hasArg("cd")) {
    long cdVal = server.arg("cd").toInt();
    if (cdVal < 0) cdVal = 0;
    if (cdVal > 30000) cdVal = 30000;
    webPrecountMs = (uint32_t)cdVal;
  } else {
    if (webUserWaiting == 1 && webPrecountMs == 0) webPrecountMs = countdownDurationMs;
    if (webUserWaiting == 0) webPrecountMs = 0;
  }

  uint32_t cd = webPrecountMs;
  int uw = webUserWaiting;
  portEXIT_CRITICAL(&stateMux);

  server.send(200, "text/plain", String("UW=") + uw + ", CD=" + cd);
}

void handleHelp() {
  String msg = R"rawliteral(
<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>HANWOOL TMS 도움말</title></head>
<body style="font-family:system-ui;padding:18px">
<h2>HANWOOL TMS HELP</h2>
<ul>
<li>/data</li>
<li>/graphic_data</li>
<li>/dashboard</li>
<li>/countdown_start</li>
<li>/ignite</li>
<li>/force_ignite</li>
<li>/abort</li>
<li>/set?igs=0|1</li>
<li>/set?rs=0|1</li>
<li>/set?stream=0|1</li>
<li>/set?ign_ms=1000~10000</li>
<li>/set?cd_ms=3000~30000</li>
<li>/precount?uw=0|1&cd=ms</li>
</ul>
<a href="/">HOME</a>
</body></html>
)rawliteral";
  server.send(200, "text/html; charset=utf-8", msg);
}

// =======================================================
// ===================== SERIAL CMD =======================
// =======================================================
static void serialReply(const String& s) {
  Serial.print("ACK ");
  Serial.println(s);
}
static void serialErr(const String& s) {
  Serial.print("ERR ");
  Serial.println(s);
}

static void handleSerialCommand(String line) {
  line.trim();
  if (line.length() == 0) return;

  if (!line.startsWith("/")) return;

  uint8_t mask = 0;
  if (isLocked(&mask)) {
    serialErr(String("LOCKED_REBOOT_REQUIRED RM=") + (int)mask);
    return;
  }

  const uint32_t now = millis();

  if (line.startsWith("/set")) {
    int q = line.indexOf('?');
    if (q < 0 || q == (int)line.length() - 1) { serialErr("NO_QUERY"); return; }
    String query = line.substring(q + 1);
    portENTER_CRITICAL(&stateMux);
    applyQueryLike(query);
    portEXIT_CRITICAL(&stateMux);
    serialReply("SET_OK");
    return;
  }

  if (line.startsWith("/countdown_start")) {
    bool ok = false;
    portENTER_CRITICAL(&stateMux);
    if (currentState == ST_IDLE) { startCountdownNow(now); ok = true; }
    portEXIT_CRITICAL(&stateMux);
    if (ok) serialReply("COUNTDOWN_STARTED");
    else serialErr("BUSY");
    return;
  }

  if (line.startsWith("/ignite")) {
    portENTER_CRITICAL(&stateMux);
    startFiringNow(now);
    portEXIT_CRITICAL(&stateMux);
    serialReply("IGNITION_IMMEDIATE");
    return;
  }

  if (line.startsWith("/force_ignite")) {
    portENTER_CRITICAL(&stateMux);
    startFiringNow(now);
    portEXIT_CRITICAL(&stateMux);
    serialReply("FORCE_IGNITION_OK");
    return;
  }

  if (line.startsWith("/abort")) {
    portENTER_CRITICAL(&stateMux);
    setIdleAbort();
    portEXIT_CRITICAL(&stateMux);
    fastWrite(rly1, LOW);
    fastWrite(rly2, LOW);
    noTone(piezo);
    serialReply("ABORTED");
    return;
  }

  if (line.startsWith("/precount")) {
    int q = line.indexOf('?');
    if (q < 0) { serialErr("NO_QUERY"); return; }
    String query = line.substring(q + 1);
    int uwPos = query.indexOf("uw=");
    if (uwPos < 0) { serialErr("NO_UW"); return; }

    int uwVal = 0;
    {
      int start = uwPos + 3;
      int end = query.indexOf('&', start);
      if (end < 0) end = query.length();
      uwVal = query.substring(start, end).toInt();
      uwVal = (uwVal != 0) ? 1 : 0;
    }

    uint32_t cdVal = 0;
    int cdPos = query.indexOf("cd=");
    if (cdPos >= 0) {
      int start = cdPos + 3;
      int end = query.indexOf('&', start);
      if (end < 0) end = query.length();
      long tmp = query.substring(start, end).toInt();
      if (tmp < 0) tmp = 0;
      if (tmp > 30000) tmp = 30000;
      cdVal = (uint32_t)tmp;
    }

    portENTER_CRITICAL(&stateMux);
    webUserWaiting = uwVal;
    if (cdPos >= 0) {
      webPrecountMs = cdVal;
    } else {
      if (webUserWaiting == 1 && webPrecountMs == 0) webPrecountMs = countdownDurationMs;
      if (webUserWaiting == 0) webPrecountMs = 0;
    }
    uint32_t cd = webPrecountMs;
    int uw = webUserWaiting;
    portEXIT_CRITICAL(&stateMux);

    serialReply(String("UW=") + uw + " CD=" + cd);
    return;
  }

  serialErr("UNKNOWN_CMD");
}

static void pollSerialCommands() {
  static String buf;
  static uint32_t lastRxMs = 0;

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    lastRxMs = millis();

    // ✅ CR/LF 둘 다 종료로 인정
    if (c == '\n' || c == '\r') {
      if (buf.length() > 0) handleSerialCommand(buf);
      buf = "";
    } else {
      if (buf.length() < 240) buf += c;
    }
  }

  // ✅ "줄바꿈 없음(No line ending)"에서도 동작하도록 타임아웃 처리
  // (Serial Monitor는 보통 Send 누르면 한번에 다 들어오니 60ms면 충분)
  if (buf.length() > 0 && buf[0] == '/') {
    if (millis() - lastRxMs >= 60) {
      handleSerialCommand(buf);
      buf = "";
    }
  }
}

// =======================================================
// ===================== TASK: SAMPLER ===================
// =======================================================
static void SamplerTask(void* arg) {
  (void)arg;

  const TickType_t periodTicks = pdMS_TO_TICKS(SAMPLE_PERIOD_MS);
  TickType_t lastWake = xTaskGetTickCount();

  uint64_t lastWakeUs = esp_timer_get_time();

  uint32_t hzWindowStartMs = millis();
  uint32_t thrustCount = 0;
  uint16_t thrustHz = 0;

  uint8_t modeWifi = 0;
  uint32_t lastStaCheckMs = 0;

  for (;;) {
    vTaskDelayUntil(&lastWake, periodTicks);

    const uint32_t nowMs = millis();

    const uint64_t nowWakeUs = esp_timer_get_time();
    const uint32_t periodUs  = (uint32_t)(nowWakeUs - lastWakeUs);
    lastWakeUs = nowWakeUs;

    uint16_t ltMs = (uint16_t)((periodUs + 500ULL) / 1000ULL);
    if (ltMs == 0) ltMs = 1;
    if (ltMs > 1000) ltMs = 1000;

    const uint64_t calcStartUs = esp_timer_get_time();

    if (hx711.is_ready()) {
      float v = hx711.get_units(1);
      if (!isnan(v) && !isinf(v)) currentThrust = v;
      thrustCount++;
    }

    const uint32_t elapsedHzMs = nowMs - hzWindowStartMs;
    if (elapsedHzMs >= 1000) {
      float hzF = (elapsedHzMs > 0) ? (thrustCount * 1000.0f / elapsedHzMs) : 0.0f;
      if (hzF < 0) hzF = 0;
      if (hzF > 500) hzF = 500;
      thrustHz = (uint16_t)(hzF + 0.5f);

      hzWindowStartMs = nowMs;
      thrustCount = 0;
    }

    const float pV   = analogRead(pressure_sig) * ADC_TO_V;
    const float ignV = analogRead(ign_adc_pin) * ADC_TO_V;

    const uint8_t sw = (uint8_t)fastRead(switch1);

    uint8_t relayMask = 0;
    relayMask |= (fastRead(rly1) ? 1 : 0);
    relayMask |= (fastRead(rly2) ? 2 : 0);

    uint8_t st, uw, ab, gsLocal, rsLocal, rfLocal, rmLocal, ssLocal;
    uint32_t ss, cdDur;
    uint32_t cd = 0;

    portENTER_CRITICAL(&stateMux);
    st = (uint8_t)currentState;
    uw = (uint8_t)webUserWaiting;
    ab = (uint8_t)webAbortFlag;
    gsLocal = (uint8_t)igs;
    rsLocal = (uint8_t)relaySafe;
    rfLocal = (uint8_t)relayFault;
    rmLocal = (uint8_t)relayFaultMask;
    ssLocal = (uint8_t)serialStream;

    ss = stateStartTimeMs;
    cdDur = countdownDurationMs;

    if (st == ST_COUNTDOWN) {
      uint32_t elapsed = nowMs - ss;
      cd = (elapsed < cdDur) ? (cdDur - elapsed) : 0;
    } else if (st == ST_IDLE && uw == 1) {
      cd = webPrecountMs;
    } else {
      cd = 0;
    }
    portEXIT_CRITICAL(&stateMux);

    if (cd > 30000) cd = 30000;

    bool ign_ok = (ignV < 0.5f);

    if ((nowMs - lastStaCheckMs) >= 200) {
      lastStaCheckMs = nowMs;
      modeWifi = (WiFi.softAPgetStationNum() > 0) ? 1 : 0;
    }

    const uint64_t calcEndUs = esp_timer_get_time();
    uint32_t ctUs = (uint32_t)(calcEndUs - calcStartUs);
    if (ctUs > 65535) ctUs = 65535;

    SampleSnap snap;
    snap.t  = (isnan(currentThrust) || isinf(currentThrust)) ? 0.0f : currentThrust;
    snap.p  = (isnan(pV) || isinf(pV)) ? 0.0f : pV;
    snap.iv = (isnan(ignV) || isinf(ignV)) ? 0.0f : ignV;
    snap.ut = nowMs - systemStartTime;
    snap.lt = ltMs;
    snap.ct = (uint16_t)ctUs;
    snap.hz = thrustHz;

    snap.s  = sw ? 1 : 0;
    snap.ic = ign_ok ? 1 : 0;
    snap.r  = relayMask;
    snap.gs = gsLocal;
    snap.st = st;
    snap.cd = (uint16_t)cd;
    snap.uw = uw;
    snap.ab = ab;
    snap.m  = modeWifi;

    snap.rs = rsLocal;
    snap.rf = rfLocal;
    snap.rm = rmLocal;
    snap.ss = ssLocal;

    portENTER_CRITICAL(&sampleMux);
    lastSnap = snap;
    portEXIT_CRITICAL(&sampleMux);
  }
}

// =======================================================
// ===================== TASK: CONTROL ===================
// =======================================================
static void ControlTask(void* arg) {
  (void)arg;

  uint32_t lastBeepTime = 0;
  bool beepToggle = false;

  bool relayOn = false;  // ✅ "명령한" 릴레이 상태(ON/OFF)
  bool toneOn  = false;

  auto setRelays = [&](bool on) {
    if (relayOn == on) return;
    relayOn = on;
    fastWrite(rly1, on ? HIGH : LOW);
    fastWrite(rly2, on ? HIGH : LOW);
  };

  auto stopTone = [&]() {
    if (!toneOn) return;
    toneOn = false;
    noTone(piezo);
  };

  uint32_t lastBlinkMs = 0;
  bool blinkPhase = false;

  // ✅ RelaySafe 오탐 방지용 지속시간 체크
  uint32_t offMismatchSinceMs = 0;

  TickType_t lastWake = xTaskGetTickCount();

  for (;;) {
    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(5));

    const uint32_t now = millis();
    const SampleSnap s = getLastSnapCopy();

    // ---- 최신 설정/상태 읽기 ----
    uint8_t rsLocal = 0;
    uint8_t rfLocal = 0;

    SystemState st;
    uint32_t stStart, ignDur, cdDur;
    int ab;

    portENTER_CRITICAL(&stateMux);
    rsLocal = (uint8_t)relaySafe;
    rfLocal = (uint8_t)relayFault;

    st = currentState;
    stStart = stateStartTimeMs;
    ignDur = ignitionDurationMs;
    cdDur  = countdownDurationMs;
    ab = webAbortFlag;
    portEXIT_CRITICAL(&stateMux);

    // ✅ 스위치는 스냅샷 말고 "직접" 읽어서 전환 순간 오탐/지연 제거
    const bool swNow = (fastRead(switch1) != 0);

    // ---- LOCKOUT 모드(래치) ----
    if (rfLocal == 1) {
      setRelays(false);

      if (now - lastBlinkMs >= 220) {
        lastBlinkMs = now;
        blinkPhase = !blinkPhase;
        fastWrite(led1, blinkPhase ? HIGH : LOW);
        fastWrite(led2, blinkPhase ? LOW  : HIGH);
      }

      if (now - lastBeepTime >= 200) {
        lastBeepTime = now;
        beepToggle = !beepToggle;
        tone(piezo, beepToggle ? 2000 : 1200, 160);
        toneOn = true;
      }

      continue;
    }

    // 정상 모드 LED
    fastWrite(led1, LOW);
    fastWrite(led2, HIGH);

    // ---- 상태 머신 ----
    if (st == ST_IDLE) {
      if (swNow) {
        if (relayOn || s.ic == 1) {
          setRelays(true);
          if (now - lastBeepTime >= 140) {
            lastBeepTime = now;
            beepToggle = !beepToggle;
            tone(piezo, beepToggle ? 1800 : 1400, 120);
            toneOn = true;
          }
        } else {
          setRelays(false);
          if (now - lastBeepTime > 200) {
            lastBeepTime = now;
            tone(piezo, 300, 100);
            toneOn = true;
          }
        }
      } else {
        setRelays(false);
        stopTone();
        if (s.gs == 1 && s.ic == 1) {
          if (now - lastBeepTime >= 1500) {
            lastBeepTime = now;
            tone(piezo, 750, 120);
            toneOn = true;
          }
        }
      }
    }
    else if (st == ST_COUNTDOWN) {
      setRelays(false);
      stopTone();

      if (!s.ic) {
        portENTER_CRITICAL(&stateMux);
        setIdleAbort();
        portEXIT_CRITICAL(&stateMux);
      }
      else if (ab) {
        portENTER_CRITICAL(&stateMux);
        currentState = ST_IDLE;
        portEXIT_CRITICAL(&stateMux);
      }
      else if (now - stStart >= cdDur) {
        portENTER_CRITICAL(&stateMux);
        currentState = ST_FIRING;
        stateStartTimeMs = now;
        portEXIT_CRITICAL(&stateMux);

      }
    }
    else if (st == ST_FIRING) {
      if (ab || (now - stStart >= ignDur)) {
        portENTER_CRITICAL(&stateMux);
        currentState = ST_IDLE;
        portEXIT_CRITICAL(&stateMux);

        setRelays(false);
        stopTone();
      } else {
        setRelays(true);
        if (now - lastBeepTime >= 140) {
          lastBeepTime = now;
          beepToggle = !beepToggle;
          tone(piezo, beepToggle ? 1800 : 1400, 120);
          toneOn = true;
        }
      }
    }

    // ===================================================
    // ✅ RelaySafe(오탐 방지 버전)
    //   - "릴레이를 OFF로 명령했는데도"
    //   - 실제 핀 레벨이 HIGH가 "RELAYSAFE_CONFIRM_MS 이상" 지속되면 LOCKOUT 래치
    // ===================================================
    if (rsLocal == 1) {
      const uint8_t actualMask =
        (fastRead(rly1) ? 1 : 0) |
        (fastRead(rly2) ? 2 : 0);

      const bool shouldBeOff = (!relayOn); // 우리가 OFF 명령 중인 상태

      if (shouldBeOff && actualMask != 0) {
        if (offMismatchSinceMs == 0) offMismatchSinceMs = now;

        if ((now - offMismatchSinceMs) >= RELAYSAFE_CONFIRM_MS) {
          // LOCKOUT 래치
          portENTER_CRITICAL(&stateMux);
          relayFault = 1;
          relayFaultMask = actualMask;

          currentState = ST_IDLE;
          webAbortFlag = 1;
          webUserWaiting = 0;
          portEXIT_CRITICAL(&stateMux);

          // 즉시 안전 상태
          setRelays(false);
          stopTone();
        }
      } else {
        offMismatchSinceMs = 0;
      }
    } else {
      offMismatchSinceMs = 0;
    }
  }
}

// =======================================================
// ========================= SETUP ========================
// =======================================================
void setup() {
  Serial.begin(460800);

  pinMode(led1, OUTPUT);
  pinMode(led2, OUTPUT);
  pinMode(rly1, OUTPUT);
  pinMode(rly2, OUTPUT);
  pinMode(switch1, INPUT);   // 필요하면 INPUT_PULLUP 고려(배선에 따라)
  pinMode(ig_sens, INPUT);
  pinMode(piezo, OUTPUT);

  pinMode(pressure_sig, INPUT);
  pinMode(ign_adc_pin, INPUT);

  analogReadResolution(12);

  hx711.begin(hx711_dt, hx711_clk);
  hx711.set_gain(128);
  hx711.set_scale(thrust_cal_factor);
  hx711.tare();

  digitalWrite(led2, HIGH);

  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);
  WiFi.softAP(ap_ssid, ap_password);

  if (!LittleFS.begin(false)) {
    Serial.println("[LittleFS] mount failed");
    fsReady = false;
  } else {
    Serial.println("[LittleFS] mounted");
    fsReady = true;
  }

  server.serveStatic("/img/", LittleFS, "/img/");
  server.serveStatic("/dashboard.js", LittleFS, "/dashboard.js");

  server.on("/",                handleRoot);
  server.on("/help",            handleHelp);
  server.on("/dashboard",       dashboard);
  server.on("/data",            handleData);
  server.on("/graphic_data",    handleGraphicData);
  server.on("/overlay",         overlay);

  server.on("/set",             handleSetIGS);
  server.on("/ignite",          handleIgnite);
  server.on("/force_ignite",    handleForceIgnite);
  server.on("/abort",           handleAbort);
  server.on("/countdown_start", handleCountdownStart);
  server.on("/precount",        handlePrecount);

  server.begin();

  tone(piezo, 900, 120);  delay(180);
  tone(piezo, 1300, 160); delay(220);
  tone(piezo, 1700, 200); delay(260);
  noTone(piezo);

  systemStartTime = millis();

  portENTER_CRITICAL(&stateMux);
  webPrecountMs = countdownDurationMs;
  portEXIT_CRITICAL(&stateMux);

  const BaseType_t CORE_APP = 1;
  xTaskCreatePinnedToCore(SamplerTask, "SamplerTask", 4096, nullptr, 2, nullptr, CORE_APP);
  xTaskCreatePinnedToCore(ControlTask, "ControlTask", 4096, nullptr, 3, nullptr, CORE_APP);

  Serial.println("[BOOT] Ready.");
}

// =======================================================
// ========================== LOOP ========================
// =======================================================
void loop() {
  server.handleClient();

  pollSerialCommands();

  // JSON 스트림은 필요할 때만 (Serial Monitor로 조작할 땐 /set?stream=0 추천)
  static uint32_t lastPrintMs = 0;
  const uint32_t now = millis();
  if (serialStream == 1 && (now - lastPrintMs) >= 12) { // ~80Hz
    lastPrintMs = now;
    static char json[768];
    const SampleSnap s = getLastSnapCopy();
    buildJson(json, sizeof(json), s);
    Serial.println(json);
  }

  delay(0);
}
