    // =====================
    // 상태/버퍼
    // =====================

    let logLines = [];
    let logData = [];
    let eventLog = [];
    let thrustBaseHistory = [];
    let pressureBaseHistory = [];
    let sampleHistory = [];
    const SAMPLE_HISTORY_MAX = 10000;
    const EVENT_LOG_MAX = 5000;
    const RAW_LOG_MAX   = 20000;

    const IGN_THRUST_THRESHOLD = 2.0;  // kgf
    const IGN_PRE_WINDOW_MS    = 1000;
    const IGN_POST_WINDOW_MS   = 1000;

    let prevStForIgn = 0;
    let ignitionAnalysis = {hasData:false,ignStartMs:null,thresholdMs:null,lastAboveMs:null,windowStartMs:null,windowEndMs:null,delaySec:null,durationSec:null,endNotified:false};

    const MAX_POINTS         = 300;

    // ✅ 너무 빡센 폴링(30ms)은 ESP 쪽 응답 흔들림(간헐 타임아웃/큐 적체)을 만들 수 있어서 완화
    const POLL_INTERVAL      = 80;

    const UI_SAMPLE_SKIP     = 2;
    const CHART_MIN_INTERVAL = 50;

    let lastChartRedraw = 0;
    let sampleCounter = 0;
    let isUpdating = false;
    let chartView = { start: 0, window: 150 };
    let autoScrollChart = true;
    let disconnectedLogged = false;
    let lastStatusCode = -1;
    let currentSt = 0;
    let lastSnapHzUiMs = 0;
    let rxWindowStartMs = 0;
    let rxWindowCount = 0;
    let rxHzWindow = 0;

    let prevSwState = null;
    let prevIcState = null;
    let prevGsState = null;
    let st2StartMs = null;
    let igniterAbortSent = false;
    let firstSampleMs = null;

    // ✅ RelaySafe/LOCKOUT
    let relaySafeEnabled = true;
    let lockoutLatched = false;
    let lockoutRelayMask = 0; // bit0=rly1, bit1=rly2
    let lastLockoutToastMs = 0;

    // ✅ LOCKOUT modal
    let lockoutModalShown = false;

    // ✅ WebSerial
    let serialEnabled = false;
    let serialRxEnabled = true;
    let serialTxEnabled = true;
    let serialPort = null;
    let serialReader = null;
    let serialWriter = null;
    let serialReadAbort = null;
    let serialLineBuf = "";
    let serialConnected = false;

    // ✅ 설비 점검/제어 권한
    let controlAuthority = false;
    let inspectionState = "idle";
    let inspectionRunning = false;
    let latestTelemetry = {sw:null, ic:null, rly:null, mode:null};
    const INSPECTION_STEPS = [
      {key:"link",    check:()=>connOk},
      {key:"serial",  check:()=>(!serialEnabled) || serialConnected},
      {key:"igniter", check:()=> (uiSettings && uiSettings.igs) ? (latestTelemetry.ic===1) : true},
      {key:"switch",  check:()=>latestTelemetry.sw===0},
      {key:"relay",   check:()=>!lockoutLatched},
    ];

    // ✅ DOM 캐시
    const el = {};
    const MAX_VISIBLE_LOG = 500;

    // ✅ 연결 상태 안정화(히스테리시스) - CONNECT/DISCONNECT 깜빡임 방지
    let connOk = false;
    let lastOkMs = Date.now();          // 마지막 정상 샘플 수신 시각
    let failStreak = 0;                // 연속 실패 횟수
    let lastDiscAnnounceMs = 0;

    const DISCONNECT_GRACE_MS = 1500;  // 이 시간 동안 샘플이 없으면 끊김 후보
    const FAIL_STREAK_LIMIT   = 20;    // 연속 실패가 이 이상이고, grace도 지났으면 DISCONNECTED
    const DISC_TOAST_COOLDOWN_MS = 7000;

    // ✅ 엔드포인트 “기억” (매번 3개 다 두드리지 않게)
    let preferredEndpoint = "/graphic_data";
    const ENDPOINTS = ["/graphic_data","/data","/json"];

    // ✅ WebSocket 스트림
    let wsSocket = null;
    let wsConnected = false;
    let wsRetryTimer = null;
    let wsRetryMs = 300;
    let wsLastMsgMs = 0;
    const WS_FRESH_MS = 300;
    const WS_RETRY_MAX_MS = 5000;

    // =====================
    // ✅ SPLASH / PRELOAD
    // =====================
    function preloadImages(paths){
      const uniq = Array.from(new Set(paths.filter(Boolean)));
      return Promise.all(uniq.map(src => new Promise(resolve=>{
        const img = new Image();
        img.onload = () => resolve({src, ok:true});
        img.onerror = () => resolve({src, ok:false});
        img.src = src;
      })));
    }

    async function runSplashAndPreload(){
      const splash  = document.getElementById("splash");
      const loading = document.getElementById("splashLoading");
      const dots    = document.getElementById("splashDots");
      const app     = document.querySelector(".page-wrap");

      if(!splash || !loading || !dots || !app){
        app?.classList?.add("ready");
        return;
      }

      // ✅ 타이밍 고정: 로고만 2초 → 로딩중 표시 → (프리로드 완료 후) 넘어감
      const SHOW_LOADING_AFTER_MS = 2000;  // 로고만 보이는 시간
      const HOLD_AFTER_LOADING_MS = 300;   // "로딩중" 최소 체류(너무 휙 넘어가는 느낌 방지)

      // 점 애니메이션
      let n = 0;
      const dotTimer = setInterval(()=>{
        n = (n + 1) % 4;
        dots.textContent = ".".repeat(n);
      }, 320);

      const ASSETS = [
        "img/Flash_logo.png",
        "img/Danger.svg",
        "img/Tick.svg",
        "img/Graph.svg",
        "img/Activity.svg",
        "img/RS_1.svg",
        "img/RS_2.svg",
        "img/RS_all.svg",
      ];

      // ✅ 프리로드는 바로 시작
      const preloadPromise = preloadImages(ASSETS);

      // ✅ 2초는 무조건 기다렸다가 로딩중 표시
      await new Promise(r => setTimeout(r, SHOW_LOADING_AFTER_MS));
      loading.classList.add("show");

      // ✅ 프리로드 끝날 때까지 대기
      await preloadPromise;

      // ✅ 로딩중이 뜬 상태로 너무 바로 꺼지지 않게 살짝 홀드
      await new Promise(r => setTimeout(r, HOLD_AFTER_LOADING_MS));

      clearInterval(dotTimer);
      dots.textContent = "";

      // ✅ 스플래시 종료 → 앱 표시
      splash.classList.add("hide");
      app.classList.add("ready");
      setTimeout(()=>{ try{ splash.remove(); }catch(e){} }, 350);
    }


    // =====================
    // UI 설정 저장
    // =====================
    const SETTINGS_KEY = "hanwool_tms_settings_v2";
    let uiSettings = null;

    function defaultSettings(){
      return {
        thrustUnit:"kgf",
        ignDurationSec:5,
        countdownSec:10,
        relaySafe: true,
        igs: 0,
        serialEnabled: false,
        serialRx: true,
        serialTx: true,
        lang: "ko"
      };
    }
    function loadSettings(){
      try{
        const raw = localStorage.getItem(SETTINGS_KEY);
        uiSettings = raw ? Object.assign(defaultSettings(), JSON.parse(raw)) : defaultSettings();
      }catch(e){ uiSettings = defaultSettings(); }
      relaySafeEnabled = !!uiSettings.relaySafe;

      // WebSerial 기본 OFF 강제
      serialEnabled = false;
      uiSettings.serialEnabled = false;
      saveSettings();

      serialRxEnabled = uiSettings.serialRx !== false;
      serialTxEnabled = uiSettings.serialTx !== false;
      setLanguage(uiSettings.lang || "ko");
    }
    function saveSettings(){ try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(uiSettings)); }catch(e){} }

    // =====================
    // 언어 (i18n)
    // =====================
    const I18N = {
      ko: {
        toastTitleSuccess:"완료",
        toastTitleWarn:"주의",
        toastTitleError:"오류",
        toastTitleIgnite:"점화 / 추력 감지",
        toastTitleInfo:"알림",
        safetyLineSuffix:"안전거리 확보 · 결선/단락 확인 · 주변 인원 접근 금지.",
        settingsLangLabel:"언어",
        settingsLangHint:"표시 언어를 변경합니다.",
        exportXlsx:"XLSX 내보내기",
        chartNoData:"데이터 없음",
        labelDelay:"지연",
        labelBurn:"연소",
        modeSerial:"시리얼",
        modeWifi:"와이파이",
        modeAuto:"자동",
        swHigh:"HIGH",
        swLow:"LOW",
        icOk:"OK",
        icNo:"NO",
        relayOn:"ON",
        relayOff:"OFF",
        dirUp:"상승",
        dirDown:"하강",
        confirmTitleReady:"점화 시퀀스를 진행할까요?",
        confirmTitleEntering:"점화 시퀀스 진입까지 {sec}초",
        confirmTitleCountdown:"카운트다운 시작",
        ignWindowDetected:"점화 구간 감지",
        ignWindowNone:"점화 구간 없음",
        igniterLostAbortLog:"시퀀스 중 이그나이터 끊김 감지 → ABORT 전송.",
        igniterLostAbortToast:"시퀀스 중 이그나이터가 끊겼습니다. ABORT 처리했습니다. {safety}",
        lockoutModalTitle:"LOCKOUT · {name}",
        lockoutModalText:"비정상적인 릴레이 HIGH 감지 ({name})로 모든 제어 권한이 해제되었습니다.",
        lockoutModalNote:"• 릴레이/배선/드라이버 쇼트 여부 확인 후 보드를 재시작하세요.",
        connConnected:"연결됨",
        connDisconnected:"연결 끊김",
        statusDisconnected:"DISCONNECTED",
        statusNoResponse:"보드 응답 없음",
        wsTimeout:"WebSocket 시간초과",
        noResponse:"보드 응답 없음",
        hdrTimeIso:"시간_ISO",
        hdrMessage:"메시지",
        hdrIgnWindow:"점화_구간",
        hdrIgnDelay:"점화_지연_s",
        hdrBurn:"유효_연소_s",
        hdrThreshold:"임계_kgf",
        hdrTag:"태그",
        hdrThrust:"추력_kgf",
        hdrPressure:"압력_v",
        hdrLoopMs:"루프_ms",
        hdrElapsedMs:"경과_ms",
        hdrHxHz:"hx_hz",
        hdrCpuUs:"cpu_us",
        hdrSwitch:"스위치",
        hdrIgnOk:"점화_정상",
        hdrRelay:"릴레이",
        hdrIgs:"igs_모드",
        hdrState:"상태",
        hdrCdMs:"카운트다운_ms",
        hdrRelTime:"상대시간_s",
        hdrIgnWindowFlag:"유효추력_구간",
        chartTitleIgnition:"유효추력 구간 추력/압력 (elapsed_ms 기준)",
        chartTitleThrust:"추력 그래프 (유효추력 구간)",
        chartTitlePressure:"압력 그래프 (유효추력 구간)",
        statusLockout:"LOCKOUT",
        statusAbort:"ABORT",
        statusIgnition:"IGNITION",
        statusCountdown:"COUNTDOWN",
        statusNotArmed:"NOT ARMED",
        statusReady:"READY",
        statusLockoutText:"비정상적인 릴레이 HIGH 감지 ({name}). 모든 제어 권한이 해제되었습니다. 보드를 재시작하세요.",
        statusAbortText:"시퀀스가 중단되었습니다.",
        statusIgnitionText:"점화 중입니다.",
        statusCountdownText:"카운트다운 진행 중",
        statusNotArmedText:"이그나이터 미연결 / 준비 안됨",
        statusReadyText:"시스템 준비 완료",
        relaySafeLockout:"LOCKOUT({name})",
        relaySafeSafe:"SAFE",
        relaySafeOff:"OFF",
        serialOff:"OFF",
        serialConnected:"연결됨",
        serialDisconnected:"연결 끊김",
        inspectFailToast:"점검 실패 항목이 있습니다. 상태를 확인하세요.",
        inspectFailLog:"설비 점검 실패: 일부 항목이 통과하지 못했습니다.",
        inspectPassToast:"설비 점검 통과. 제어 권한을 획득했습니다.",
        inspectPassLog:"설비 점검 완료. 제어 권한을 획득했습니다.",
        wsReconnect:"WebSocket 재연결 예약 ({reason}).",
        wsConnected:"WebSocket 연결됨: {url}",
        wsLost:"보드와의 연결이 끊겼습니다.",
        boardUnstable:"보드 응답이 불안정합니다. 전원/배선/Wi-Fi/폴링 주기를 확인하세요.",
        webserialUnsupported:"이 브라우저는 WebSerial을 지원하지 않습니다. (Chrome/Edge 권장)",
        webserialConnected:"WebSerial 연결됨 @460800.",
        webserialConnectedToast:"시리얼(WebSerial) 연결 완료.",
        serialReadEnded:"시리얼 읽기 루프 종료: {err}",
        webserialConnectFailed:"WebSerial 연결 실패: {err}",
        webserialConnectFailedToast:"시리얼 연결 실패. 포트/권한을 확인하세요.",
        webserialDisconnected:"WebSerial 연결 해제됨.",
        serialWriteFailed:"시리얼 쓰기 실패: {err}",
        linkEstablished:"연결됨 ({src}).",
        linkEstablishedToast:"보드와 연결되었습니다. ({src})",
        lockoutDetectedLog:"LOCKOUT: 비정상적인 릴레이 HIGH 감지 ({name}). 제어 권한 해제. 재시작 필요.",
        lockoutDetectedToast:"비정상적인 릴레이 HIGH 감지 ({name}). 모든 제어 권한이 해제되었습니다. 보드를 재시작하세요.",
        ignitionSignal:"점화 신호 감지 (st=2). 추력 {thr} kgf 초과 감시 시작.",
        ignitionThresholdLog:"추력이 {thr} kgf 초과. 점화 지연 = {delay}s",
        ignitionThresholdToast:"추력이 임계값({thr} kgf) 이상으로 감지되었습니다. 점화 지연 ≈ {delay}s. {safety}",
        ignitionEndLog:"점화 상태 종료. 연소 시간 ≈ {dur}s",
        ignitionEndToast:"유효추력 구간이 종료된 것으로 보입니다. 잔열/잔류가스 주의 후 접근하세요.",
        ignitionNoThrustLog:"점화 상태 종료. 임계값 이상 추력 미검출.",
        ignitionNoThrustToast:"점화 상태 종료. 유효추력이 감지되지 않았습니다. 결선/이그나이터 상태를 확인하세요. {safety}",
        switchHighLog:"스위치 변경: HIGH(ON).",
        switchHighToast:"스위치가 HIGH(ON) 상태입니다. 시퀀스 조건/주변 안전을 재확인하세요. {safety}",
        switchLowLog:"스위치 변경: LOW(OFF).",
        switchLowToast:"스위치가 LOW(OFF) 상태입니다. 안전 상태로 유지하세요. {safety}",
        igniterOkLog:"이그나이터 연속성: OK.",
        igniterOkToast:"이그나이터 상태가 OK로 변경되었습니다. 점화 전 결선/단락/극성을 재확인하세요. {safety}",
        igniterNoLog:"이그나이터 연속성: NO / OPEN.",
        igniterNoToast:"이그나이터가 NO(OPEN) 상태입니다. 커넥터/배선/단선 여부를 확인하세요. {safety}",
        igsOnLog:"Igniter Safety Test: ON (보드).",
        igsOnToast:"Igniter Safety Test가 ON입니다. 의도치 않은 인가 위험이 있습니다. {safety}",
        igsOffLog:"Igniter Safety Test: OFF (보드).",
        igsOffToast:"Igniter Safety Test가 OFF입니다. 안전 상태로 복귀했습니다. {safety}",
        countdownStartLog:"카운트다운 시작 (st=1).",
        countdownStartToast:"카운트다운이 시작되었습니다. 주변 안전거리 확보 후 진행하세요. {safety}",
        ignitionFiringLog:"점화 진행 (st=2).",
        ignitionFiringToast:"점화 시퀀스가 진행 중입니다. 절대 접근하지 마세요. {safety}",
        sequenceCompleteLog:"시퀀스 완료. 대기 상태로 복귀.",
        sequenceCompleteToast:"시퀀스가 완료되었습니다. 잔열/잔류가스 주의 후 접근하세요.",
        sequenceAbortedLog:"시퀀스 중단.",
        sequenceAbortedToast:"ABORT 처리되었습니다. 재시도 전 결선/스위치/환경을 다시 확인하세요. {safety}",
        notArmedToast:"NOT ARMED 상태입니다. 이그나이터 연결 상태를 확인하세요. {safety}",
        lockoutDetectedToastShort:"비정상적인 릴레이 HIGH 감지 ({name}). 모든 제어가 정지됩니다. 보드를 재시작하세요.",
        pollingErrorLog:"폴링 오류: {err}",
        pollingErrorToast:"폴링 중 오류가 발생했습니다. 로그를 확인하세요.",
        lockoutNoControl:"LOCKOUT 상태에서는 어떤 제어도 불가능합니다. 보드를 재시작하세요.",
        inspectionRequiredToast:"설비 점검을 먼저 완료하세요. 점검 통과 후 제어 권한이 부여됩니다.",
        preSequenceToast:"시퀀스 시작 전 최종 안전 확인을 진행하세요. 3초 롱프레스로 진입합니다. {safety}",
        inspectionRequiredShort:"설비 점검을 먼저 완료하세요. 제어 권한이 필요합니다.",
        countdownRequestedLog:"대시보드에서 카운트다운 요청 (롱프레스).",
        countdownRequestedToast:"카운트다운 요청을 보드에 전송했습니다. 신호/배선/주변을 계속 확인하세요. {safety}",
        longPressCanceledToast:"롱프레스가 취소되었습니다. 주변 안전 확보 후 다시 시도하세요. {safety}",
        lockoutForceDenied:"LOCKOUT 상태에서는 강제점화를 포함한 제어가 불가능합니다. 보드를 재시작하세요.",
        forceNotAllowed:"시퀀스 진행 중에는 강제 점화를 사용할 수 없습니다.",
        forceWarning:"강제 점화는 고위험 동작입니다. 마지막 확인 후 진행하세요. {safety}",
        lockoutControlDenied:"LOCKOUT 상태에서는 제어가 불가능합니다.",
        inspectionRequiredPlain:"설비 점검을 먼저 완료하세요.",
        launcherUpDownLog:"발사대 {dir} (UI 전용).",
        lockoutCmdDenied:"LOCKOUT({name}) 상태에서는 명령을 보낼 수 없습니다. 보드를 재시작하세요.",
        cmdSentLog:"명령 => {cmd}",
        systemReadyLog:"시스템 준비 완료. 명령 대기 중.",
        dashboardStartToast:"대시보드가 시작되었습니다. 연결 상태 확인 후 운용하세요. {safety}",
        relaySafeOnToast:"RelaySafe가 ON입니다. 비정상 릴레이 HIGH 감지 시 LOCKOUT 됩니다.",
        relaySafeOffToast:"RelaySafe가 OFF입니다. (권장하지 않음)",
        igsToggledLog:"Igniter Safety Test 토글: {state}",
        igsToggledOnToast:"Igniter Safety Test가 ON입니다. 이그나이터/배선에 주의하세요. {safety}",
        igsToggledOffToast:"Igniter Safety Test가 OFF입니다. 안전 상태로 유지하세요. {safety}",
        serialRxOnToast:"시리얼 수신 파싱 ON",
        serialRxOffToast:"시리얼 수신 파싱 OFF",
        serialTxOnToast:"시리얼 명령 전송 ON",
        serialTxOffToast:"시리얼 명령 전송 OFF",
        lockoutAbortDenied:"LOCKOUT({name}) 상태에서는 ABORT도 불가능합니다. 보드를 재시작하세요.",
        abortRequestedToast:"ABORT 요청을 보드에 전송했습니다. 안전 확인 후 재시도하세요. {safety}",
        inspectionOpenToast:"보드와 연결 후 설비 점검을 실행하세요.",
        inspectionWait:"대기",
        inspectionRunningLabel:"진행중",
        inspectionChecking:"확인 중",
        inspectionOk:"정상",
        inspectionNeed:"확인 필요",
        inspectionSkip:"SKIP",
        inspectionIdleText:"점검 대기중…",
        inspectionRunningText:"점검 중…",
        forceRequestedToast:"강제 점화 요청을 보드에 전송했습니다. 절대 접근하지 마세요. {safety}",
        lockoutAckLog:"LOCKOUT 확인 처리 ({name}). 재시작 필요.",
        lockoutAckToast:"LOCKOUT({name}) 확인 처리(로그 기록). 보드를 재시작하세요.",
        logCopiedLog:"로그를 클립보드에 복사했습니다.",
        logCopiedToast:"로그가 클립보드에 복사되었습니다.",
        clipboardCopyFailedLog:"클립보드 복사 실패.",
        clipboardCopyFailedToast:"클립보드 복사에 실패했습니다. 브라우저 권한을 확인하세요.",
        copyFailedLog:"복사 실패: {err}",
        copyFailedToast:"복사에 실패했습니다. 브라우저 정책을 확인하세요.",
        xlsxExportLog:"XLSX 내보내기 완료 (IGN_SUMMARY/EVENT/RAW): {filename}",
        xlsxExportToast:"XLSX로 내보냈습니다. (IGN_SUMMARY + EVENT + RAW 시트)",
        thrustUnitChangedToast:"추력 단위가 {from} → {to} 로 변경되었습니다. 표시 단위만 변경됩니다. {safety}",
        ignTimeChangedToast:"점화 시간이 {from}s → {to}s 로 변경되었습니다. 과열/인가 시간에 주의하세요. {safety}",
        countdownChangedToast:"카운트다운 시간이 {from}s → {to}s 로 변경되었습니다. 인원 통제 시간을 충분히 두세요. {safety}",
        settingsUpdatedLog:"설정 업데이트: thrustUnit={unit}, ignDuration={ign}s, countdown={cd}s"
      },
      en: {
        toastTitleSuccess:"Success",
        toastTitleWarn:"Warning",
        toastTitleError:"Error",
        toastTitleIgnite:"Ignition / Thrust",
        toastTitleInfo:"Notice",
        safetyLineSuffix:"Keep safe distance · Check wiring/shorts · No personnel approach.",
        settingsLangLabel:"Language",
        settingsLangHint:"Change display language.",
        exportXlsx:"Export XLSX",
        chartNoData:"NO DATA",
        labelDelay:"Delay",
        labelBurn:"Burn",
        modeSerial:"SERIAL",
        modeWifi:"WIFI",
        modeAuto:"AUTO",
        swHigh:"HIGH",
        swLow:"LOW",
        icOk:"OK",
        icNo:"NO",
        relayOn:"ON",
        relayOff:"OFF",
        dirUp:"UP",
        dirDown:"DOWN",
        confirmTitleReady:"Proceed with ignition sequence?",
        confirmTitleEntering:"Entering ignition sequence in {sec}s",
        confirmTitleCountdown:"Countdown start",
        ignWindowDetected:"Ignition window detected",
        ignWindowNone:"No ignition window",
        igniterLostAbortLog:"Igniter lost during sequence → ABORT sent.",
        igniterLostAbortToast:"Igniter lost during sequence. ABORT sent. {safety}",
        lockoutModalTitle:"LOCKOUT · {name}",
        lockoutModalText:"Abnormal relay HIGH detected ({name}). Control revoked.",
        lockoutModalNote:"• Check relay/wiring/driver short then restart the board.",
        connConnected:"CONNECTED",
        connDisconnected:"DISCONNECTED",
        statusDisconnected:"DISCONNECTED",
        statusNoResponse:"No response from board",
        wsTimeout:"WebSocket timeout",
        noResponse:"No response from board",
        hdrTimeIso:"time_iso",
        hdrMessage:"message",
        hdrIgnWindow:"ignition_window",
        hdrIgnDelay:"ignition_delay_s",
        hdrBurn:"effective_burn_s",
        hdrThreshold:"threshold_kgf",
        hdrTag:"tag",
        hdrThrust:"thrust_kgf",
        hdrPressure:"pressure_v",
        hdrLoopMs:"loop_ms",
        hdrElapsedMs:"elapsed_ms",
        hdrHxHz:"hx_hz",
        hdrCpuUs:"cpu_us",
        hdrSwitch:"switch",
        hdrIgnOk:"ign_ok",
        hdrRelay:"relay",
        hdrIgs:"igs_mode",
        hdrState:"state",
        hdrCdMs:"cd_ms",
        hdrRelTime:"rel_time_s",
        hdrIgnWindowFlag:"is_ignition_window",
        chartTitleIgnition:"Thrust/Pressure in ignition window (elapsed_ms)",
        chartTitleThrust:"Thrust chart (ignition window)",
        chartTitlePressure:"Pressure chart (ignition window)",
        statusLockout:"LOCKOUT",
        statusAbort:"ABORT",
        statusIgnition:"IGNITION",
        statusCountdown:"COUNTDOWN",
        statusNotArmed:"NOT ARMED",
        statusReady:"READY",
        statusLockoutText:"Abnormal relay HIGH detected ({name}). Control revoked. Restart the board.",
        statusAbortText:"Sequence aborted.",
        statusIgnitionText:"Igniter firing.",
        statusCountdownText:"Launch countdown in progress",
        statusNotArmedText:"Igniter open / not ready",
        statusReadyText:"System ready",
        relaySafeLockout:"LOCKOUT({name})",
        relaySafeSafe:"SAFE",
        relaySafeOff:"OFF",
        serialOff:"OFF",
        serialConnected:"CONNECTED",
        serialDisconnected:"DISCONNECTED",
        inspectFailToast:"Inspection failed. Check the status.",
        inspectFailLog:"Inspection failed: some items did not pass.",
        inspectPassToast:"Inspection passed. Control authority acquired.",
        inspectPassLog:"Inspection complete. Control authority acquired.",
        wsReconnect:"WebSocket reconnect scheduled ({reason}).",
        wsConnected:"WebSocket connected: {url}",
        wsLost:"Dashboard lost connection to board.",
        boardUnstable:"Board response is unstable. Check power/wiring/Wi-Fi/polling interval.",
        webserialUnsupported:"This browser does not support WebSerial. (Chrome/Edge recommended)",
        webserialConnected:"WebSerial connected @460800.",
        webserialConnectedToast:"Serial (WebSerial) connected.",
        serialReadEnded:"Serial read loop ended: {err}",
        webserialConnectFailed:"WebSerial connect failed: {err}",
        webserialConnectFailedToast:"Serial connect failed. Check port/permissions.",
        webserialDisconnected:"WebSerial disconnected.",
        serialWriteFailed:"Serial write failed: {err}",
        linkEstablished:"Link established ({src}).",
        linkEstablishedToast:"Connected to board. ({src})",
        lockoutDetectedLog:"LOCKOUT: abnormal relay HIGH detected ({name}). Control revoked. Restart required.",
        lockoutDetectedToast:"Abnormal relay HIGH detected ({name}). Control revoked. Restart the board.",
        ignitionSignal:"Ignition signal detected (st=2). Tracking thrust over {thr} kgf.",
        ignitionThresholdLog:"Thrust exceeded {thr} kgf. Ignition delay = {delay}s",
        ignitionThresholdToast:"Thrust exceeded threshold ({thr} kgf). Ignition delay ≈ {delay}s. {safety}",
        ignitionEndLog:"Ignition state finished. Burn duration ≈ {dur}s",
        ignitionEndToast:"Effective thrust window ended. Approach after residual heat/gas.",
        ignitionNoThrustLog:"Ignition state finished. No thrust over threshold detected.",
        ignitionNoThrustToast:"Ignition ended. No effective thrust detected. Check wiring/igniter. {safety}",
        switchHighLog:"Switch changed: HIGH (ON).",
        switchHighToast:"Switch is HIGH (ON). Recheck sequence conditions and safety. {safety}",
        switchLowLog:"Switch changed: LOW (OFF).",
        switchLowToast:"Switch is LOW (OFF). Keep safe state. {safety}",
        igniterOkLog:"Igniter continuity: OK.",
        igniterOkToast:"Igniter state changed to OK. Recheck wiring/short/polarity before ignition. {safety}",
        igniterNoLog:"Igniter continuity: NO / OPEN.",
        igniterNoToast:"Igniter is NO(OPEN). Check connector/wiring/open circuit. {safety}",
        igsOnLog:"Igniter Safety Test: ON (from board).",
        igsOnToast:"Igniter Safety Test is ON. Risk of unintended power. {safety}",
        igsOffLog:"Igniter Safety Test: OFF (from board).",
        igsOffToast:"Igniter Safety Test is OFF. Returned to safe state. {safety}",
        countdownStartLog:"Countdown started (st=1).",
        countdownStartToast:"Countdown started. Maintain safe distance. {safety}",
        ignitionFiringLog:"Ignition firing (st=2).",
        ignitionFiringToast:"Ignition sequence in progress. Do not approach. {safety}",
        sequenceCompleteLog:"Sequence complete. Back to idle.",
        sequenceCompleteToast:"Sequence complete. Approach after residual heat/gas.",
        sequenceAbortedLog:"Sequence aborted.",
        sequenceAbortedToast:"ABORT processed. Recheck wiring/switch/environment before retry. {safety}",
        notArmedToast:"NOT ARMED. Check igniter connection. {safety}",
        lockoutDetectedToastShort:"Abnormal relay HIGH detected ({name}). All control stopped. Restart the board.",
        pollingErrorLog:"Polling error: {err}",
        pollingErrorToast:"Polling error occurred. Check the log.",
        lockoutNoControl:"LOCKOUT state: no control allowed. Restart the board.",
        inspectionRequiredToast:"Complete inspection first. Control authority is granted after pass.",
        preSequenceToast:"Do final safety check before sequence. Hold 3 seconds to enter. {safety}",
        inspectionRequiredShort:"Complete inspection first. Control authority required.",
        countdownRequestedLog:"Countdown requested from dashboard (long-press).",
        countdownRequestedToast:"Countdown request sent to board. Keep checking signal/wiring/area. {safety}",
        longPressCanceledToast:"Long-press canceled. Try again after securing safety. {safety}",
        lockoutForceDenied:"LOCKOUT state: control including force ignition is not allowed. Restart the board.",
        forceNotAllowed:"Force ignition is not allowed during sequence.",
        forceWarning:"Force ignition is high risk. Proceed after final check. {safety}",
        lockoutControlDenied:"LOCKOUT state: control not allowed.",
        inspectionRequiredPlain:"Complete inspection first.",
        launcherUpDownLog:"Launcher {dir} (UI only).",
        lockoutCmdDenied:"LOCKOUT({name}) cannot send command. Restart the board.",
        cmdSentLog:"CMD => {cmd}",
        systemReadyLog:"System ready. Waiting for commands.",
        dashboardStartToast:"Dashboard started. Check connection before operation. {safety}",
        relaySafeOnToast:"RelaySafe is ON. LOCKOUT on abnormal relay HIGH.",
        relaySafeOffToast:"RelaySafe is OFF. (Not recommended)",
        igsToggledLog:"Igniter Safety Test toggled: {state}",
        igsToggledOnToast:"Igniter Safety Test is ON. Watch igniter/wiring. {safety}",
        igsToggledOffToast:"Igniter Safety Test is OFF. Keep safe state. {safety}",
        serialRxOnToast:"Serial RX parsing ON",
        serialRxOffToast:"Serial RX parsing OFF",
        serialTxOnToast:"Serial TX ON",
        serialTxOffToast:"Serial TX OFF",
        lockoutAbortDenied:"LOCKOUT({name}) cannot ABORT. Restart the board.",
        abortRequestedToast:"ABORT request sent to board. Recheck safety before retry. {safety}",
        inspectionOpenToast:"Connect to board before running inspection.",
        inspectionWait:"Waiting",
        inspectionRunningLabel:"Running",
        inspectionChecking:"Checking",
        inspectionOk:"OK",
        inspectionNeed:"Check",
        inspectionSkip:"SKIP",
        inspectionIdleText:"Inspection ready…",
        inspectionRunningText:"Inspection running…",
        forceRequestedToast:"Force ignition request sent to board. Do not approach. {safety}",
        lockoutAckLog:"LOCKOUT acknowledged ({name}). Restart required.",
        lockoutAckToast:"LOCKOUT({name}) acknowledged (logged). Restart the board.",
        logCopiedLog:"Log copied to clipboard.",
        logCopiedToast:"Log copied to clipboard.",
        clipboardCopyFailedLog:"Clipboard copy failed.",
        clipboardCopyFailedToast:"Clipboard copy failed. Check browser permissions.",
        copyFailedLog:"Copy failed: {err}",
        copyFailedToast:"Copy failed. Check browser policy.",
        xlsxExportLog:"XLSX exported (IGN_SUMMARY/EVENT/RAW): {filename}",
        xlsxExportToast:"Exported to XLSX. (IGN_SUMMARY + EVENT + RAW sheets)",
        thrustUnitChangedToast:"Thrust unit changed {from} → {to}. Display only. {safety}",
        ignTimeChangedToast:"Ignition time changed {from}s → {to}s. Watch heating/drive time. {safety}",
        countdownChangedToast:"Countdown changed {from}s → {to}s. Allow enough clearance time. {safety}",
        settingsUpdatedLog:"Settings updated: thrustUnit={unit}, ignDuration={ign}s, countdown={cd}s"
      }
    };

    let currentLang = "ko";
    function t(key, vars){
      const dict = I18N[currentLang] || I18N.ko;
      let text = dict[key] || I18N.ko[key] || key;
      if(vars){
        text = text.replace(/\{(\w+)\}/g, (_, name)=>(
          (vars[name] !== undefined && vars[name] !== null) ? String(vars[name]) : ""
        ));
      }
      return text;
    }
    function setLanguage(lang){
      currentLang = (lang === "en") ? "en" : "ko";
      document.documentElement.lang = currentLang;
      updateStaticTexts();
    }
    function updateStaticTexts(){
      const nodes = document.querySelectorAll("[data-i18n]");
      nodes.forEach(node=>{
        const key = node.getAttribute("data-i18n");
        if(key) node.textContent = t(key);
      });
    }

    function convertThrustForDisplay(t){
      if(!uiSettings) return t;
      return (uiSettings.thrustUnit==="N") ? (t*9.80665) : t;
    }

    function applySettingsToUI(){
      if(!uiSettings) return;
      const thrustLabel = document.querySelector('[data-label="thrust-unit"]');
      const thrustBadge = document.querySelector('[data-badge="thrust-unit"]');
      const pressureBadge = document.querySelector('[data-badge="pressure-unit"]');

      if(thrustLabel) thrustLabel.textContent = uiSettings.thrustUnit;
      if(thrustBadge) thrustBadge.textContent = "RED · " + uiSettings.thrustUnit;
      if(pressureBadge) pressureBadge.textContent = "BLUE · V";

      if(el.unitThrust) el.unitThrust.value = uiSettings.thrustUnit;
      if(el.ignTimeInput) el.ignTimeInput.value = uiSettings.ignDurationSec;
      if(el.countdownSecInput) el.countdownSecInput.value = uiSettings.countdownSec;

      if(el.relaySafeToggle) el.relaySafeToggle.checked = !!uiSettings.relaySafe;
      if(el.igswitch) el.igswitch.checked = !!uiSettings.igs;

      if(el.serialToggle) el.serialToggle.checked = !!uiSettings.serialEnabled;
      if(el.serialRxToggle) el.serialRxToggle.checked = uiSettings.serialRx !== false;
      if(el.serialTxToggle) el.serialTxToggle.checked = uiSettings.serialTx !== false;
      if(el.langSelect) el.langSelect.value = (uiSettings.lang === "en") ? "en" : "ko";

      updateRelaySafePill();
      updateSerialPill();
      updateStaticTexts();
    }
    const delay = (ms)=>new Promise(resolve=>setTimeout(resolve, ms));

    // =====================
    // LOCKOUT helpers
    // =====================
    function relayMaskName(mask){
      if(mask===1) return "RLY1";
      if(mask===2) return "RLY2";
      if(mask===3) return "RLY1+RLY2";
      return "RLY?";
    }
    function setLockoutVisual(on){
      if(!el.lockoutBg) return;
      el.lockoutBg.classList.toggle("active", !!on);
    }

    function lockoutImgSrc(mask){
      if(mask===1) return "img/RS_1.svg";
      if(mask===2) return "img/RS_2.svg";
      if(mask===3) return "img/RS_all.svg";
      return "img/RS_all.svg";
    }
    function showLockoutModal(){
      if(!el.lockoutOverlay) return;

      const name = relayMaskName(lockoutRelayMask);
      const img = lockoutImgSrc(lockoutRelayMask);

      if(el.lockoutImg) el.lockoutImg.src = img;
      if(el.lockoutTitle) el.lockoutTitle.textContent = t("lockoutModalTitle", {name});
      if(el.lockoutText){
        el.lockoutText.textContent = t("lockoutModalText", {name});
      }
      if(el.lockoutNote){
        el.lockoutNote.textContent = t("lockoutModalNote");
      }

      el.lockoutOverlay.classList.remove("hidden");
      el.lockoutOverlay.style.display = "flex";
      lockoutModalShown = true;
    }
    function hideLockoutModal(){
      if(!el.lockoutOverlay) return;
      el.lockoutOverlay.classList.add("hidden");
      el.lockoutOverlay.style.display = "none";
    }

    // =====================
    // UI 헬퍼
    // =====================
    function updateConnectionUI(connected){
      if(!el.connDot || !el.connText) return;
      if(connected){ el.connDot.classList.add("ok"); el.connText.textContent = t("connConnected"); }
      else { el.connDot.classList.remove("ok"); el.connText.textContent = t("connDisconnected"); }
      updateInspectionAccess();
    }

    function addLogLine(message, tag){
      if(!el.logView) return;
      const now = new Date();
      const timeStr = now.toLocaleTimeString();
      const timeIso = now.toISOString();
      const prefix = tag ? "[" + tag + "] " : "";
      const lineText = prefix + "[" + timeStr + "] " + message;

      logLines.push(lineText);
      eventLog.push({ time: timeIso, tag: tag || "", message: message });

      if(eventLog.length > EVENT_LOG_MAX) eventLog.splice(0, eventLog.length - EVENT_LOG_MAX);

      const div = document.createElement("div");
      div.className = "log-line";
      div.innerHTML = '<span class="log-prefix">$</span> ' + lineText.replace(/</g,"&lt;").replace(/>/g,"&gt;");
      el.logView.appendChild(div);

      while(el.logView.childNodes.length > MAX_VISIBLE_LOG){
        el.logView.removeChild(el.logView.firstChild);
      }
      while(logLines.length > MAX_VISIBLE_LOG){
        logLines.shift();
      }
      el.logView.scrollTop = el.logView.scrollHeight;
    }

    function getToastIconPath(type){
      if(type==="success") return "img/Tick.svg";
      if(type==="warn") return "img/Danger.svg";
      if(type==="error") return "img/Danger.svg";
      if(type==="ignite") return "img/Graph.svg";
      return "img/Activity.svg";
    }

    function dismissToast(toast){
      if(!toast || toast._dismissed) return;
      toast._dismissed = true;
      if(toast._timer){ clearTimeout(toast._timer); toast._timer = null; }
      toast.classList.remove("toast-show");
      toast.classList.add("toast-hide");
      setTimeout(()=>{ if(toast && toast.parentNode) toast.parentNode.removeChild(toast); }, 220);
    }

    function showToast(message, type, opts){
      if(!el.toastContainer) return;
      const toastType = type || "info";
      const duration = (opts && opts.duration) ? opts.duration : 5200;

      const toast = document.createElement("div");
      toast.className = "toast toast-" + toastType;
      toast.setAttribute("role","status");
      toast.setAttribute("aria-live","polite");

      const iconDiv = document.createElement("div");
      iconDiv.className = "toast-icon";
      const img = document.createElement("img");
      img.src = getToastIconPath(toastType);
      img.alt = "";
      iconDiv.appendChild(img);

      const bodyDiv = document.createElement("div");
      bodyDiv.className = "toast-body";

      const titleDiv = document.createElement("div");
      titleDiv.className = "toast-title";
      if(toastType==="success") titleDiv.textContent = t("toastTitleSuccess");
      else if(toastType==="warn") titleDiv.textContent = t("toastTitleWarn");
      else if(toastType==="error") titleDiv.textContent = t("toastTitleError");
      else if(toastType==="ignite") titleDiv.textContent = t("toastTitleIgnite");
      else titleDiv.textContent = t("toastTitleInfo");

      const textDiv = document.createElement("div");
      textDiv.className = "toast-text";
      textDiv.textContent = message;

      bodyDiv.appendChild(titleDiv);
      bodyDiv.appendChild(textDiv);

      toast.appendChild(iconDiv);
      toast.appendChild(bodyDiv);

      toast.addEventListener("click", ()=>dismissToast(toast));
      el.toastContainer.appendChild(toast);
      requestAnimationFrame(()=>toast.classList.add("toast-show"));
      toast._timer = setTimeout(()=>dismissToast(toast), duration);
    }

    function safetyLineSuffix(){
      return t("safetyLineSuffix");
    }

    function updateRelaySafePill(){
      if(!el.relaySafePill) return;
      setLockoutVisual(lockoutLatched);

      if(lockoutLatched){
        const name = relayMaskName(lockoutRelayMask);
        el.relaySafePill.textContent = t("relaySafeLockout", {name});
        el.relaySafePill.style.color = "#991b1b";
      }else{
        el.relaySafePill.textContent = relaySafeEnabled ? t("relaySafeSafe") : t("relaySafeOff");
        el.relaySafePill.style.color = relaySafeEnabled ? "#166534" : "#64748b";
      }
    }

    function updateSerialPill(){
      if(!el.serialStatus || !el.serialStatusText) return;
      const enabled = serialEnabled;
      const ok = enabled && serialConnected;
      el.serialStatus.classList.remove("ok","bad");
      if(!enabled){
        el.serialStatusText.textContent = t("serialOff");
      }else if(ok){
        el.serialStatus.classList.add("ok");
        el.serialStatusText.textContent = t("serialConnected");
      }else{
        el.serialStatus.classList.add("bad");
        el.serialStatusText.textContent = t("serialDisconnected");
      }
    }

    function isControlUnlocked(){
      return controlAuthority && inspectionState==="passed" && !lockoutLatched;
    }

    function updateInspectionPill(){
      if(!el.inspectionStatusPill) return;
      let cls="pill ";
      let txt="대기";
      if(inspectionState==="passed"){ cls+="pill-green"; txt="OK"; }
      else if(inspectionState==="failed"){ cls+="pill-red"; txt="확인"; }
      else if(inspectionRunning){ cls+="pill-gray"; txt="진행중"; }
      else { cls+="pill-gray"; txt="대기"; }
      el.inspectionStatusPill.className=cls;
      el.inspectionStatusPill.textContent=txt;
    }

    function updateInspectionAccess(){
      if(!el.inspectionOpenBtn) return;
      const blocked = !connOk;
      el.inspectionOpenBtn.classList.toggle("disabled", blocked);
      el.inspectionOpenBtn.setAttribute("aria-disabled", blocked ? "true" : "false");
    }

    function updateControlAccessUI(st){
      const state = (st==null) ? currentSt : st;
      const unlocked=isControlUnlocked();
      if(el.forceBtn){
        const blocked = (!unlocked || lockoutLatched || state!==0);
        el.forceBtn.disabled = blocked;
        el.forceBtn.classList.toggle("disabled", blocked);
      }
      if(el.launcherOpenBtn){
        const blocked = (!unlocked || lockoutLatched);
        el.launcherOpenBtn.classList.toggle("disabled", blocked);
        el.launcherOpenBtn.setAttribute("aria-disabled", blocked ? "true" : "false");
      }
      updateInspectionPill();
    }

    function setInspectionItemState(key,state,label){
      const item=document.querySelector('.inspection-item[data-key="'+key+'"]');
      if(!item) return;
      item.classList.remove("state-running","state-ok","state-bad","state-skip");
      if(state==="running") item.classList.add("state-running");
      else if(state==="ok") item.classList.add("state-ok");
      else if(state==="bad") item.classList.add("state-bad");
      else if(state==="skip") item.classList.add("state-skip");
      const status=item.querySelector(".inspection-status");
      if(status){
        status.textContent = label || (state==="ok" ? t("inspectionOk") : state==="bad" ? t("inspectionNeed") : t("inspectionRunningLabel"));
      }
    }

    function setInspectionResult(text, state){
      if(!el.inspectionResult) return;
      el.inspectionResult.classList.remove("ok","error","running");
      if(state) el.inspectionResult.classList.add(state);
      el.inspectionResult.textContent=text;
    }

    function resetInspectionUI(){
      inspectionRunning=false;
      controlAuthority=false;
      inspectionState="idle";
      INSPECTION_STEPS.forEach(s=>setInspectionItemState(s.key,"", t("inspectionWait")));
      setInspectionResult(t("inspectionIdleText"),"neutral");
      updateInspectionPill();
      updateControlAccessUI(currentSt);
    }

    async function runInspectionSequence(){
      if(inspectionRunning) return;
      inspectionRunning=true;
      inspectionState="running";
      controlAuthority=false;
      updateInspectionPill();
      setInspectionResult(t("inspectionRunningText"),"running");
      updateControlAccessUI(currentSt);

      let hasFail=false;
      for(const step of INSPECTION_STEPS){
        setInspectionItemState(step.key,"running", t("inspectionChecking"));
        await delay(320);
        let ok=false;
        let skipped=false;
        try{ ok = !!step.check(); }catch(e){ ok=false; }
        if(step.key==="igniter" && !(uiSettings && uiSettings.igs)){
          ok = true;
          skipped = true;
        }
        if(skipped){
          setInspectionItemState(step.key, "skip", t("inspectionSkip"));
        }else{
          setInspectionItemState(step.key, ok ? "ok" : "bad", ok ? t("inspectionOk") : t("inspectionNeed"));
        }
        if(!ok && !skipped) hasFail=true;
        await delay(180);
      }

      inspectionRunning=false;
      inspectionState = hasFail ? "failed" : "passed";

      if(hasFail){
        controlAuthority=false;
        setInspectionResult("점검 실패 항목이 있습니다.","error");
        showToast(t("inspectFailToast"),"warn");
        addLogLine(t("inspectFailLog"),"SAFE");
      }else{
        controlAuthority=true;
        setInspectionResult("모든 항목 통과. 제어 권한 확보됨.","ok");
        showToast(t("inspectPassToast"),"success");
        addLogLine(t("inspectPassLog"),"SAFE");
      }
      setButtonsFromState(currentSt, lockoutLatched);
      updateInspectionPill();
    }

    function showInspection(){
      if(el.inspectionOverlay){
        el.inspectionOverlay.classList.remove("hidden");
        el.inspectionOverlay.style.display="flex";
      }
      resetInspectionUI();
      runInspectionSequence();
    }
    function hideInspection(){
      if(el.inspectionOverlay){
        el.inspectionOverlay.classList.add("hidden");
        el.inspectionOverlay.style.display="none";
      }
    }

    function colorToRgba(hex, alpha){
      if(!hex) hex="#000000";
      if(hex[0]==="#") hex=hex.substring(1);
      if(hex.length===3) hex=hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
      const r=parseInt(hex.substring(0,2),16)||0;
      const g=parseInt(hex.substring(2,4),16)||0;
      const b=parseInt(hex.substring(4,6),16)||0;
      return "rgba("+r+","+g+","+b+","+alpha+")";
    }

    // ✅ KST 시각 표시
    function updateKstClock(){
      if(!el.kstTime) return;
      const now = new Date();
      const opts = { hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false, timeZone:"Asia/Seoul" };
      el.kstTime.textContent = now.toLocaleTimeString("ko-KR", opts);
    }

    function getViewIndices(data, view){
      const len=data.length;
      if(len===0) return {start:0,end:-1};
      let windowSize=view.window||len;
      if(windowSize<2) windowSize=2;
      if(windowSize>len) windowSize=len;
      let start=view.start||0;
      if(start<0) start=0;
      if(start+windowSize>len) start=len-windowSize;
      return {start:start,end:start+windowSize-1};
    }

    // =====================
    // 캔버스 DPR 보정
    // =====================
    function ensureCanvasSize(canvas){
      const rect = canvas.getBoundingClientRect();
      if(!canvas._cssInit){
        canvas.style.width = "100%";
        canvas.style.height = "";
        canvas._cssInit = true;
      }

      let parentContentWidth = 0;
      if(canvas.parentElement){
        const parentRect = canvas.parentElement.getBoundingClientRect();
        const parentStyle = getComputedStyle(canvas.parentElement);
        const padLeft = parseFloat(parentStyle.paddingLeft) || 0;
        const padRight = parseFloat(parentStyle.paddingRight) || 0;
        parentContentWidth = Math.max(0, parentRect.width - padLeft - padRight);
      }
      const cssW = Math.max(160, Math.floor(parentContentWidth || rect.width || 200));
      const cssH = Math.max(180, rect.height || 220);
      const dpr  = window.devicePixelRatio || 1;

      if(canvas._cssW!==cssW || canvas._cssH!==cssH || canvas._dpr!==dpr){
        canvas.width  = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas._cssW = cssW; canvas._cssH = cssH; canvas._dpr = dpr;
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr,0,0,dpr,0,0);
      return { w: cssW, h: cssH, ctx };
    }

    // =====================
    // 차트
    // =====================
    function drawChart(canvasId, data, color, view){
      const canvas=document.getElementById(canvasId);
      if(!canvas) return;

      const { w:width, h:height, ctx } = ensureCanvasSize(canvas);
      ctx.clearRect(0,0,width,height);
      const padding=6;
      ctx.save();
      ctx.strokeStyle="rgba(148,163,184,0.35)";
      ctx.lineWidth=1;
      ctx.setLineDash([3,4]);
      for(let i=0;i<=4;i++){
        let y=padding+(height-2*padding)*(i/4);
        y=height-y;
        ctx.beginPath(); ctx.moveTo(padding,y); ctx.lineTo(width-padding,y); ctx.stroke();
      }
      ctx.setLineDash([2,6]);
      for(let i=0;i<=4;i++){
        let x=padding+(width-2*padding)*(i/4);
        ctx.beginPath(); ctx.moveTo(x,padding); ctx.lineTo(x,height-padding); ctx.stroke();
      }
      ctx.restore();

      if(!data || data.length<2){
        ctx.save();
        ctx.fillStyle="rgba(71,85,105,0.65)";
        ctx.font="12px -apple-system,BlinkMacSystemFont,system-ui,sans-serif";
        ctx.textAlign="center";
        ctx.textBaseline="middle";
        ctx.fillText(t("chartNoData"), width/2, height/2);
        ctx.restore();
        return;
      }
      const indices=getViewIndices(data,view);
      if(indices.end<indices.start) return;

      const slice=data.slice(indices.start,indices.end+1);
      if(slice.length<2) return;

      let min=slice[0], max=slice[0], sum=0;
      for(let v of slice){ if(v<min) min=v; if(v>max) max=v; sum+=v; }
      const avg=sum/slice.length;

      let range=max-min; if(range===0) range=1;
      const count=slice.length;
      const stepX=(width-2*padding)/(count-1);

      function yPos(value){
        return (height-padding) - ((value-min)/range)*(height-2*padding);
      }

      ctx.beginPath();
      for(let i=0;i<slice.length;i++){
        const x=padding+i*stepX;
        const y=yPos(slice[i]);
        if(i===0) ctx.moveTo(x,y);
        else ctx.lineTo(x,y);
      }
      ctx.strokeStyle=color;
      ctx.lineWidth=2;
      ctx.stroke();

      const lastX=padding+(slice.length-1)*stepX;
      const bottomY=height-padding;
      ctx.lineTo(lastX,bottomY);
      ctx.lineTo(padding,bottomY);
      ctx.closePath();

      const grad=ctx.createLinearGradient(0,0,0,height);
      grad.addColorStop(0,colorToRgba(color,0.35));
      grad.addColorStop(0.5,colorToRgba(color,0.18));
      grad.addColorStop(1,colorToRgba(color,0));
      ctx.fillStyle=grad;
      ctx.fill();

      const yAvg=yPos(avg);
      ctx.save();
      ctx.setLineDash([6,4]);
      ctx.strokeStyle=colorToRgba(color,0.7);
      ctx.lineWidth=1.4;
      ctx.beginPath(); ctx.moveTo(padding,yAvg); ctx.lineTo(width-padding,yAvg); ctx.stroke();
      ctx.restore();

      const yMax=yPos(max);
      ctx.save();
      ctx.setLineDash([3,3]);
      ctx.strokeStyle=colorToRgba(color,0.9);
      ctx.lineWidth=1.2;
      ctx.beginPath(); ctx.moveTo(padding,yMax); ctx.lineTo(width-padding,yMax); ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.font="10px -apple-system,BlinkMacSystemFont,system-ui,sans-serif";
      ctx.fillStyle=colorToRgba(color,0.9);
      ctx.textAlign="right";
      ctx.textBaseline="bottom";
      ctx.fillText("AVG "+avg.toFixed(3),width-padding-2,yAvg-2);
      ctx.textBaseline="top";
      ctx.fillText("MAX "+max.toFixed(3),width-padding-2,yMax+2);
      ctx.restore();
    }

    function redrawCharts(){
      const thrustDisplay=thrustBaseHistory.map(convertThrustForDisplay);
      const pressureDisplay=pressureBaseHistory.slice();
      drawChart("thrustChart", thrustDisplay, "#ef4444", chartView);
      drawChart("pressureChart", pressureDisplay, "#3b82f6", chartView);
    }

    // =====================
    // 상태/버튼
    // =====================
    function setStatusFromState(st, ignOK, aborted, lockout){
      if(!el.statusPill||!el.statusText) return 0;

      if(lockout){
        el.statusPill.className="status-lock";
        el.statusPill.textContent = t("statusLockout");
        const name = relayMaskName(lockoutRelayMask);
        el.statusText.textContent = t("statusLockoutText", {name});
        return 9;
      }
      if(aborted){
        el.statusPill.className="status-abort";
        el.statusPill.textContent = t("statusAbort");
        el.statusText.textContent = t("statusAbortText");
        return 4;
      }
      if(st===2){
        el.statusPill.className="status-fire";
        el.statusPill.textContent = t("statusIgnition");
        el.statusText.textContent = t("statusIgnitionText");
        return 2;
      }
      if(st===1){
        el.statusPill.className="status-count";
        el.statusPill.textContent = t("statusCountdown");
        el.statusText.textContent = t("statusCountdownText");
        return 1;
      }
      if(!ignOK){
        el.statusPill.className="status-disc";
        el.statusPill.textContent = t("statusNotArmed");
        el.statusText.textContent = t("statusNotArmedText");
        return 3;
      }
      el.statusPill.className="status-ready";
      el.statusPill.textContent = t("statusReady");
      el.statusText.textContent = t("statusReadyText");
      return 0;
    }

    function setButtonsFromState(st, lockout){
      if(!el.igniteBtn||!el.abortBtn){ updateControlAccessUI(st); return; }
      if(lockout){
        el.igniteBtn.disabled=true;
        el.abortBtn.disabled=true;
        updateControlAccessUI(st);
        return;
      }
      if(!isControlUnlocked()){
        el.igniteBtn.disabled=true;
        el.abortBtn.disabled = (st===0);
        updateControlAccessUI(st);
        return;
      }
      if(st===0){ el.igniteBtn.disabled=false; el.abortBtn.disabled=true; }
      else { el.igniteBtn.disabled=true; el.abortBtn.disabled=false; }
      updateControlAccessUI(st);
    }

    // =====================
    // 통신: WebSocket 스트림
    // =====================
    function getWsUrl(){
      const proto = (location.protocol === "https:") ? "wss" : "ws";
      return proto + "://" + location.host + "/ws";
    }

    function scheduleWsReconnect(reason){
      if(wsRetryTimer) return;
      const delay = Math.min(WS_RETRY_MAX_MS, wsRetryMs);
      wsRetryMs = Math.min(WS_RETRY_MAX_MS, Math.round(wsRetryMs * 1.6 + 80));
      wsRetryTimer = setTimeout(()=>{ wsRetryTimer = null; openWebSocket(); }, delay);

      if(reason){
        addLogLine(t("wsReconnect", {reason}), "NET");
      }
    }

    function openWebSocket(){
      const url = getWsUrl();
      try{
        wsSocket = new WebSocket(url);
      }catch(e){
        scheduleWsReconnect("open failed");
        return;
      }

      wsSocket.onopen = ()=>{
        wsConnected = true;
        wsRetryMs = 300;
        addLogLine(t("wsConnected", {url}), "NET");
      };

      wsSocket.onmessage = (ev)=>{
        wsLastMsgMs = Date.now();
        if(!ev || !ev.data) return;
        try{
          const obj = JSON.parse(ev.data);
          onIncomingSample(obj, "WS");
        }catch(e){}
      };

      wsSocket.onerror = ()=>{
        wsConnected = false;
      };

      wsSocket.onclose = ()=>{
        wsConnected = false;
        scheduleWsReconnect("closed");
      };
    }

    function ensureWsAlive(){
      if(wsConnected && (Date.now() - wsLastMsgMs) > DISCONNECT_GRACE_MS){
        failStreak = FAIL_STREAK_LIMIT;
        markDisconnectedIfNeeded(t("wsTimeout"));
      }
    }

    // =====================
    // 통신: Wi-Fi 폴링
    // =====================
    async function fetchJsonTimeout(url, timeoutMs){
      const ctrl = new AbortController();
      const t = setTimeout(()=>{ try{ ctrl.abort(); }catch(e){} }, timeoutMs);
      try{
        const resp = await fetch(url, { cache:"no-cache", signal: ctrl.signal });
        if(!resp.ok) throw new Error("HTTP " + resp.status);
        return await resp.json();
      }finally{
        clearTimeout(t);
      }
    }

    async function fetchJsonWithFallback(){
      const order = [preferredEndpoint, ...ENDPOINTS.filter(e=>e!==preferredEndpoint)];
      let lastErr = null;

      for(const url of order){
        try{
          const obj = await fetchJsonTimeout(url, 700);
          preferredEndpoint = url;
          return obj;
        }catch(e){
          lastErr = e;
        }
      }
      throw (lastErr || new Error("no valid endpoint"));
    }

    function markDisconnectedIfNeeded(reason){
      const now = Date.now();
      const sinceOk = now - (lastOkMs || 0);

      if(sinceOk > DISCONNECT_GRACE_MS && failStreak >= FAIL_STREAK_LIMIT){
        if(connOk){
          connOk = false;
          updateConnectionUI(false);
        }

        if(el.statusPill && el.statusText && !lockoutLatched){
          el.statusPill.className="status-disc";
          el.statusPill.textContent = t("statusDisconnected");
          el.statusText.textContent = reason || t("statusNoResponse");
        }

        if(!disconnectedLogged){
          addLogLine(t("wsLost"), "DISC");
          disconnectedLogged = true;
        }

        if(now - lastDiscAnnounceMs > DISC_TOAST_COOLDOWN_MS){
          lastDiscAnnounceMs = now;
          showToast(t("boardUnstable"), "warn");
        }
      }
    }

    // =====================
    // WebSerial helpers
    // =====================
    function serialSupported(){ return !!(navigator && navigator.serial); }

    async function serialConnect(){
      if(!serialSupported()){
        showToast(t("webserialUnsupported"), "warn");
        return;
      }
      try{
        serialPort = await navigator.serial.requestPort({});
        await serialPort.open({ baudRate: 460800 });
        serialWriter = serialPort.writable?.getWriter?.() || null;

        serialReadAbort = new AbortController();
        serialReader = serialPort.readable?.getReader?.({ signal: serialReadAbort.signal }) || null;
        serialConnected = true;
        updateSerialPill();

        addLogLine(t("webserialConnected"), "SER");
        showToast(t("webserialConnectedToast"), "success");

        if(serialReader){
          readSerialLoop().catch(err=>{
            addLogLine(t("serialReadEnded", {err:(err?.message||err)}), "SER");
          });
        }
      }catch(e){
        serialConnected = false;
        updateSerialPill();
        addLogLine(t("webserialConnectFailed", {err:(e?.message||e)}), "SER");
        showToast(t("webserialConnectFailedToast"), "error");
      }
    }

    async function serialDisconnect(){
      try{
        if(serialReadAbort){ try{ serialReadAbort.abort(); }catch(e){} serialReadAbort=null; }
        if(serialReader){ try{ await serialReader.cancel(); }catch(e){} try{ serialReader.releaseLock(); }catch(e){} serialReader=null; }
        if(serialWriter){ try{ serialWriter.releaseLock(); }catch(e){} serialWriter=null; }
        if(serialPort){ try{ await serialPort.close(); }catch(e){} serialPort=null; }
      }finally{
        serialConnected = false;
        updateSerialPill();
        addLogLine(t("webserialDisconnected"), "SER");
      }
    }

    async function serialWriteLine(line){
      if(!serialConnected || !serialWriter) return false;
      try{
        const data = new TextEncoder().encode(line.endsWith("\n") ? line : (line + "\n"));
        await serialWriter.write(data);
        return true;
      }catch(e){
        addLogLine(t("serialWriteFailed", {err:(e?.message||e)}), "SER");
        return false;
      }
    }

    async function readSerialLoop(){
      const decoder = new TextDecoder();
      while(serialReader){
        const { value, done } = await serialReader.read();
        if(done) break;
        if(!value) continue;

        if(!serialRxEnabled) continue;

        const chunk = decoder.decode(value, { stream:true });
        serialLineBuf += chunk;

        let idx;
        while((idx = serialLineBuf.indexOf("\n")) >= 0){
          const line = serialLineBuf.slice(0, idx).trim();
          serialLineBuf = serialLineBuf.slice(idx+1);
          if(!line) continue;
          if(line[0] === "{" && line[line.length-1] === "}"){
            try{
              const obj = JSON.parse(line);
              onIncomingSample(obj, "SER");
            }catch(e){}
          }
        }
      }
    }

    // =====================
    // 공통: 샘플 수신 처리
    // =====================
    function onIncomingSample(data, srcTag){
      const nowOk = Date.now();
      if(rxWindowStartMs === 0) rxWindowStartMs = nowOk;
      rxWindowCount++;
      const winMs = nowOk - rxWindowStartMs;
      if(winMs >= 1000){
        rxHzWindow = Math.round((rxWindowCount * 1000) / winMs);
        rxWindowStartMs = nowOk;
        rxWindowCount = 0;
      }
      lastOkMs = nowOk;
      failStreak = 0;

      if(!connOk){
        connOk = true;
        disconnectedLogged = false;
        updateConnectionUI(true);
        addLogLine(t("linkEstablished", {src:srcTag}), "NET");
        showToast(t("linkEstablishedToast", {src:srcTag}), "success", {duration:2600});
      }

      sampleCounter++;

      const nowDate=new Date();
      const timeMs=nowDate.getTime();
      const timeIso=nowDate.toISOString();
      if(firstSampleMs === null) firstSampleMs = timeMs;

      const thrustVal = Number(data.t  != null ? data.t  : (data.thrust   ?? 0));
      const p   = Number(data.p  != null ? data.p  : (data.pressure ?? 0));
      const lt  = Number(data.lt != null ? data.lt : (data.loop ?? data.loopTime ?? 0));
      const elapsedMs = Math.max(0, timeMs - firstSampleMs);

      const hxHz = Number(data.hz != null ? data.hz : (data.hx_hz ?? 0));
      const ctUs = Number(data.ct != null ? data.ct : (data.cpu_us ?? data.cpu ?? 0));

      const sw  = (data.s  != null ? data.s  : data.sw  ?? 0);
      const ic  = (data.ic != null ? data.ic : data.ign ?? 0);
      const rly = (data.r  != null ? data.r  : data.rly ?? 0);
      const st  = Number(data.st != null ? data.st : (data.state ?? 0));
      const cd  = (data.cd != null ? Number(data.cd) : null);
      const uw  = Number(data.uw ?? 0);
      const ab  = Number(data.ab != null ? data.ab : 0);
      const gs  = Number(data.gs != null ? data.gs : data.igs ?? 0);
      const mode = Number(data.m != null ? data.m : data.mode ?? -1);

      // ✅ LOCKOUT 필드 매칭(펌웨어: rf/rm 우선)
      const lko = Number(data.lko ?? data.lockout ?? data.rf ?? 0);
      const rm  = Number(data.rm  ?? data.rmask   ?? data.rm ?? 0);

      currentSt=st;
      if(st===2 && st2StartMs===null) st2StartMs=Date.now();
      if(st!==2) st2StartMs=null;
      latestTelemetry = {sw: sw?1:0, ic: ic?1:0, rly: rly?1:0, mode, gs};

      if(st===0){
        igniterAbortSent = false;
      }else if(st===1 && !ic && !igniterAbortSent){
        igniterAbortSent = true;
        sendCommand({http:"/abort", ser:"ABORT"}, true);
        addLogLine(t("igniterLostAbortLog"), "ABORT");
        showToast(t("igniterLostAbortToast", {safety:safetyLineSuffix()}), "error");
      }

      thrustBaseHistory.push(thrustVal);
      pressureBaseHistory.push(p);

      const maxKeep=MAX_POINTS*4;
      if(thrustBaseHistory.length>maxKeep){
        const remove=thrustBaseHistory.length-maxKeep;
        thrustBaseHistory.splice(0,remove);
        pressureBaseHistory.splice(0,remove);
        chartView.start=Math.max(0,chartView.start-remove);
      }

      sampleHistory.push({timeMs,timeIso,t:thrustVal,p,lt,elapsed:elapsedMs,hz:hxHz,ct:ctUs,sw:sw?1:0,ic:ic?1:0,r:rly?1:0,st,cd:cd??0});
      if(sampleHistory.length>SAMPLE_HISTORY_MAX){
        const remove=sampleHistory.length-SAMPLE_HISTORY_MAX;
        sampleHistory.splice(0,remove);
      }

      logData.push({time:timeIso,t:thrustVal,p,lt,elapsed:elapsedMs,hz:hxHz,ct:ctUs,s:sw?1:0,ic:ic?1:0,r:rly?1:0,gs,st,cd:cd??0});
      if(logData.length > RAW_LOG_MAX) logData.splice(0, logData.length - RAW_LOG_MAX);

      // ✅ LOCKOUT 반영(보드가 내보내면)
      if(lko === 1){
        if(!lockoutLatched){
          lockoutLatched = true;
          lockoutRelayMask = rm || 0;
          controlAuthority = false;
          inspectionState = "failed";

          const name = relayMaskName(lockoutRelayMask);
          setLockoutVisual(true);

          addLogLine(t("lockoutDetectedLog", {name}), "SAFE");
          showToast(
            t("lockoutDetectedToast", {name}),
            "error",
            {duration:12000}
          );

          showLockoutModal();
        }
        updateControlAccessUI(currentSt);
      }

      // 점화 분석
      if(st===2 && prevStForIgn!==2){
        ignitionAnalysis={hasData:false,ignStartMs:timeMs,thresholdMs:null,lastAboveMs:null,windowStartMs:null,windowEndMs:null,delaySec:null,durationSec:null,endNotified:false};
        addLogLine(t("ignitionSignal", {thr:IGN_THRUST_THRESHOLD.toFixed(2)}),"IGN");
      }

      if(ignitionAnalysis.ignStartMs!=null && thrustVal>=IGN_THRUST_THRESHOLD){
        if(ignitionAnalysis.thresholdMs==null){
          ignitionAnalysis.thresholdMs=timeMs;
          ignitionAnalysis.delaySec=(ignitionAnalysis.thresholdMs-ignitionAnalysis.ignStartMs)/1000.0;
          addLogLine(t("ignitionThresholdLog", {thr:IGN_THRUST_THRESHOLD.toFixed(2), delay:ignitionAnalysis.delaySec.toFixed(3)}),"IGN");
          showToast(t("ignitionThresholdToast", {thr:IGN_THRUST_THRESHOLD.toFixed(2), delay:ignitionAnalysis.delaySec.toFixed(3), safety:safetyLineSuffix()}),"ignite");
        }
        ignitionAnalysis.lastAboveMs=timeMs;
        ignitionAnalysis.durationSec=Math.max(0,(ignitionAnalysis.lastAboveMs-ignitionAnalysis.thresholdMs)/1000.0);
        ignitionAnalysis.hasData=true;
      }

      if(prevStForIgn===2 && st!==2 && ignitionAnalysis.ignStartMs!=null && !ignitionAnalysis.endNotified){
        ignitionAnalysis.endNotified=true;
        if(ignitionAnalysis.durationSec!=null){
          addLogLine(t("ignitionEndLog", {dur:ignitionAnalysis.durationSec.toFixed(3)}),"IGN");
          showToast(t("ignitionEndToast"),"info");
        }else{
          addLogLine(t("ignitionNoThrustLog"),"IGN");
          showToast(t("ignitionNoThrustToast", {safety:safetyLineSuffix()}),"warn");
        }
      }
      prevStForIgn=st;

      // UI 업데이트(스킵)
      if(sampleCounter % UI_SAMPLE_SKIP === 0){
        updateConnectionUI(true);
        disconnectedLogged=false;

        if(prevSwState===null) prevSwState=!!sw;
        else if(prevSwState!==!!sw){
          prevSwState=!!sw;
          if(prevSwState){
            addLogLine(t("switchHighLog"), "SW");
            showToast(t("switchHighToast", {safety:safetyLineSuffix()}),"warn");
          }else{
            addLogLine(t("switchLowLog"), "SW");
            showToast(t("switchLowToast", {safety:safetyLineSuffix()}),"info");
          }
        }

        if(prevIcState===null) prevIcState=!!ic;
        else if(prevIcState!==!!ic){
          prevIcState=!!ic;
          if(prevIcState){
            addLogLine(t("igniterOkLog"), "IGN");
            showToast(t("igniterOkToast", {safety:safetyLineSuffix()}),"success");
          }else{
            addLogLine(t("igniterNoLog"), "IGN");
            showToast(t("igniterNoToast", {safety:safetyLineSuffix()}),"warn");
          }
        }

        if(prevGsState===null) prevGsState=!!gs;
        else if(prevGsState!==!!gs){
          prevGsState=!!gs;
          if(prevGsState){
            addLogLine(t("igsOnLog"), "SAFE");
            showToast(t("igsOnToast", {safety:safetyLineSuffix()}),"warn");
          }else{
            addLogLine(t("igsOffLog"), "SAFE");
            showToast(t("igsOffToast", {safety:safetyLineSuffix()}),"info");
          }
        }

        const thrustDisp=convertThrustForDisplay(thrustVal);
        const thrustUnit = (uiSettings && uiSettings.thrustUnit) ? uiSettings.thrustUnit : "kgf";

        if(el.thrust)   el.thrust.innerHTML   = `<span class="num">${thrustDisp.toFixed(3)}</span><span class="unit">${thrustUnit}</span>`;
        if(el.pressure) el.pressure.innerHTML = `<span class="num">${p.toFixed(3)}</span><span class="unit">V</span>`;
        if(el.lt)       el.lt.innerHTML       = `<span class="num">${lt.toFixed(0)}</span><span class="unit">ms</span><span class="unit">/ ${elapsedMs.toFixed(0)} ms</span>`;

        if(el.loopPill) el.loopPill.textContent = lt.toFixed(0) + " ms";
        if(el.snapHz){
          const nowUi = Date.now();
          if((nowUi - lastSnapHzUiMs) >= 1000 || lastSnapHzUiMs === 0){
            const snapHz = rxHzWindow;
            el.snapHz.textContent = (snapHz>0 && isFinite(snapHz)) ? (snapHz.toFixed(0) + " Hz") : "-- Hz";
            lastSnapHzUiMs = nowUi;
          }
        }
        if(el.hxHz) el.hxHz.textContent = (hxHz>0 && isFinite(hxHz)) ? (hxHz.toFixed(0) + " Hz") : "-- Hz";
        if(el.cpuUs) el.cpuUs.textContent = (ctUs>0 && isFinite(ctUs)) ? (ctUs.toFixed(0) + " us") : "-- us";

        if(el.ignDelayDisplay) el.ignDelayDisplay.textContent = (ignitionAnalysis.delaySec!=null)
          ? (t("labelDelay") + " " + ignitionAnalysis.delaySec.toFixed(3) + "s")
          : (t("labelDelay") + " --.-s");
        if(el.burnDurationDisplay) el.burnDurationDisplay.textContent = (ignitionAnalysis.durationSec!=null)
          ? (t("labelBurn") + " " + ignitionAnalysis.durationSec.toFixed(3) + "s")
          : (t("labelBurn") + " --.-s");

        if(el.modePill){
          let label="-";
          if(mode===0) label = t("modeSerial");
          else if(mode===1) label = t("modeWifi");
          else if(mode===2) label = t("modeAuto");
          el.modePill.textContent=label;
        }

        updateRelaySafePill();

        if(el.sw){
          if(sw){ el.sw.textContent = t("swHigh"); el.sw.className="pill pill-green"; }
          else { el.sw.textContent = t("swLow"); el.sw.className="pill pill-gray"; }
        }

        if(el.ic){
          if(ic){ el.ic.textContent = t("icOk"); el.ic.className="pill pill-green"; }
          else { el.ic.textContent = t("icNo"); el.ic.className="pill pill-red"; }
        }

        if(el.relay){
          if(rly){ el.relay.textContent = t("relayOn"); el.relay.className="pill pill-green"; }
          else { el.relay.textContent = t("relayOff"); el.relay.className="pill pill-gray"; }
        }

        if(el.igswitch) el.igswitch.checked=!!gs;

        if(el.countdown){
          let cdText="--";
          if(st===1 && cd!==null){
            let sec=Math.ceil(cd/1000); if(sec<0) sec=0;
            cdText=sec;
          }
          el.countdown.innerHTML=cdText+"<span>s</span>";
        }

        const statusCode=setStatusFromState(st,!!ic,!!ab,lockoutLatched);
        setButtonsFromState(st, lockoutLatched);

        if(statusCode!==lastStatusCode){
          if(statusCode===1){
            addLogLine(t("countdownStartLog"),"COUNT");
            showToast(t("countdownStartToast", {safety:safetyLineSuffix()}),"warn");
          }else if(statusCode===2){
            addLogLine(t("ignitionFiringLog"),"IGNITE");
            showToast(t("ignitionFiringToast", {safety:safetyLineSuffix()}),"ignite");
          }else if(statusCode===0 && lastStatusCode===2){
            addLogLine(t("sequenceCompleteLog"),"DONE");
            showToast(t("sequenceCompleteToast"),"success");
          }else if(statusCode===4){
            addLogLine(t("sequenceAbortedLog"),"ABORT");
            showToast(t("sequenceAbortedToast", {safety:safetyLineSuffix()}),"error");
          }else if(statusCode===3){
            showToast(t("notArmedToast", {safety:safetyLineSuffix()}),"warn");
          }else if(statusCode===9){
            const now = Date.now();
            if(now - lastLockoutToastMs > 5000){
              lastLockoutToastMs = now;
              const name = relayMaskName(lockoutRelayMask);
              showToast(t("lockoutDetectedToastShort", {name}), "error", {duration:12000});
            }
          }
          lastStatusCode=statusCode;
        }

        if(autoScrollChart){
          const len=thrustBaseHistory.length;
          let windowSize=chartView.window||150;
          if(windowSize<10) windowSize=10;
          if(windowSize>MAX_POINTS) windowSize=MAX_POINTS;
          if(windowSize>len) windowSize=len;
          chartView.window=windowSize;
          chartView.start=Math.max(0,len-windowSize);
        }

        const nowPerf=(typeof performance!=="undefined" && performance.now) ? performance.now() : Date.now();
        if(nowPerf-lastChartRedraw>=CHART_MIN_INTERVAL){
          redrawCharts();
          lastChartRedraw=nowPerf;
        }
      }
    }

    // =====================
    // Wi-Fi 폴링 루프
    // =====================
    async function updateData(){
      if(isUpdating) return;
      if(wsConnected && (Date.now() - wsLastMsgMs) < WS_FRESH_MS) return;
      isUpdating=true;
      try{
        let data;
        try{
          data=await fetchJsonWithFallback();
        }catch(err){
          failStreak++;
          markDisconnectedIfNeeded(t("noResponse"));
          return;
        }
        onIncomingSample(data, "WIFI");
      }finally{
        isUpdating=false;
      }
    }

    let pollTimer=null;
    async function pollLoop(){
      const t0 = (performance?.now?.() ?? Date.now());
      try{ await updateData(); }
      catch(e){
        addLogLine(t("pollingErrorLog", {err:(e?.message || e)}), "ERROR");
        showToast(t("pollingErrorToast"), "error");
      }
      const t1 = (performance?.now?.() ?? Date.now());
      const dt = t1 - t0;

      const sinceOk = Date.now() - (lastOkMs || 0);
      const extraBackoff = (sinceOk > DISCONNECT_GRACE_MS) ? 120 : 0;

      const delay = Math.max(0, (POLL_INTERVAL + extraBackoff) - dt);
      pollTimer = setTimeout(pollLoop, delay);
    }

    // =====================
    // 터치 줌/팬
    // =====================
    let isPanning=false;
    let isPinching=false;
    let panStartX=0;
    let panStartStart=0;
    let pinchStartDist=0;
    let pinchStartWindow=MAX_POINTS;

    function attachTouch(canvasId){
      const canvas=document.getElementById(canvasId);
      if(!canvas) return;

      canvas.addEventListener("touchstart",(ev)=>{
        autoScrollChart=false;
        if(ev.touches.length===1){
          isPanning=true;isPinching=false;
          panStartX=ev.touches[0].clientX;
          panStartStart=chartView.start||0;
        }else if(ev.touches.length>=2){
          isPinching=true;isPanning=false;
          const dx=ev.touches[0].clientX-ev.touches[1].clientX;
          const dy=ev.touches[0].clientY-ev.touches[1].clientY;
          pinchStartDist=Math.sqrt(dx*dx+dy*dy)||1;
          pinchStartWindow=chartView.window||MAX_POINTS;
        }
        ev.preventDefault();
      },{passive:false});

      canvas.addEventListener("touchmove",(ev)=>{
        if(isPanning && ev.touches.length===1){
          const dx=ev.touches[0].clientX-panStartX;
          const width=canvas.clientWidth||200;
          const ratio=width ? dx/width : 0;
          const delta=Math.round(-ratio*(chartView.window||MAX_POINTS)*0.8);
          chartView.start=panStartStart+delta;
          redrawCharts();
        }else if(isPinching && ev.touches.length>=2){
          const dx=ev.touches[0].clientX-ev.touches[1].clientX;
          const dy=ev.touches[0].clientY-ev.touches[1].clientY;
          const dist=Math.sqrt(dx*dx+dy*dy)||1;
          const scale=pinchStartDist/dist;
          let newWindow=Math.round(pinchStartWindow*scale);
          if(newWindow<10) newWindow=10;
          if(newWindow>MAX_POINTS) newWindow=MAX_POINTS;
          chartView.window=newWindow;
          redrawCharts();
        }
        ev.preventDefault();
      },{passive:false});

      canvas.addEventListener("touchend",(ev)=>{
        if(ev.touches.length===0){ isPanning=false; isPinching=false; }
      });
    }

    // =====================
    // 롱프레스 / 오버레이
    // =====================
    let lpTimer=null;
    let lpStart=0;
    const LP_DURATION=3000;
    let longPressSpinnerEl=null;
    let confirmOverlayEl=null;
    let confirmTitleEl=null;
    let lpLastSentSec=3;
    let userWaitingLocal=false;

    let forceOverlayEl=null;
    let launcherOverlayEl=null;
    let launcherUpHold=null;
    let launcherDownHold=null;

    function resetLongPressVisual(){
      if(longPressSpinnerEl) longPressSpinnerEl.style.setProperty("--lp-angle","0deg");
      if(confirmTitleEl) confirmTitleEl.textContent = t("confirmTitleReady");
    }
    function hideConfirm(){
      if(lpTimer){ clearInterval(lpTimer); lpTimer=null; }
      resetLongPressVisual();
      userWaitingLocal=false;
      if(confirmOverlayEl){ confirmOverlayEl.classList.add("hidden"); confirmOverlayEl.style.display="none"; }
      sendCommand({http:"/precount?uw=0&cd=0", ser:"PRECOUNT 0 0"}, false);
    }
    function showConfirm(){
      if(lockoutLatched){
        showToast(t("lockoutNoControl"), "error");
        return;
      }
      if(!isControlUnlocked()){
        showToast(t("inspectionRequiredToast"), "warn");
        return;
      }
      if(lpTimer){ clearInterval(lpTimer); lpTimer=null; }
      resetLongPressVisual();
      userWaitingLocal=true;
      lpLastSentSec=3;
      if(confirmOverlayEl){ confirmOverlayEl.classList.remove("hidden"); confirmOverlayEl.style.display="flex"; }
      sendCommand({http:"/precount?uw=1&cd=3000", ser:"PRECOUNT 1 3000"}, false);
      showToast(t("preSequenceToast", {safety:safetyLineSuffix()}),"warn");
    }

    function startHold(){
      if(lockoutLatched) return;
      if(!isControlUnlocked()){
        showToast(t("inspectionRequiredShort"), "warn");
        return;
      }
      if(!el.longPressBtn || !longPressSpinnerEl || lpTimer) return;
      userWaitingLocal=true;
      lpStart=Date.now();
      lpLastSentSec=3;

      lpTimer=setInterval(()=>{
        const now=Date.now();
        const remain=LP_DURATION-(now-lpStart);
        const left=remain<0?0:remain;

        let ratio=(LP_DURATION-left)/LP_DURATION; if(ratio>1) ratio=1;
        const angle=Math.floor(360*ratio);
        longPressSpinnerEl.style.setProperty("--lp-angle",angle+"deg");

        let sec=Math.ceil(left/1000); if(sec<0) sec=0;
        if(confirmTitleEl){
          confirmTitleEl.textContent = sec>0
            ? t("confirmTitleEntering", {sec})
            : t("confirmTitleCountdown");
        }
        if(sec!==lpLastSentSec){
          lpLastSentSec=sec;
          sendCommand({http:"/precount?uw=1&cd="+left, ser:"PRECOUNT 1 "+left}, false);
        }

        if(left===0){
          clearInterval(lpTimer); lpTimer=null;
          resetLongPressVisual(); userWaitingLocal=false;
          if(confirmOverlayEl){ confirmOverlayEl.classList.add("hidden"); confirmOverlayEl.style.display="none"; }
          sendCommand({http:"/precount?uw=0&cd=0", ser:"PRECOUNT 0 0"}, false);
          sendCommand({http:"/countdown_start", ser:"COUNTDOWN"}, true);
          addLogLine(t("countdownRequestedLog"),"CMD");
          showToast(t("countdownRequestedToast", {safety:safetyLineSuffix()}),"ignite");
        }
      },40);
    }

    function endHold(){
      if(!lpTimer) return;
      clearInterval(lpTimer); lpTimer=null;
      resetLongPressVisual();
      if(userWaitingLocal){
        const cdMs=(uiSettings?uiSettings.countdownSec:10)*1000;
        lpLastSentSec=Math.ceil(cdMs/1000);
        sendCommand({http:"/precount?uw=1&cd="+cdMs, ser:"PRECOUNT 1 "+cdMs}, false);
        showToast(t("longPressCanceledToast", {safety:safetyLineSuffix()}),"info");
      }
    }

    // =====================
    // 설정/발사대
    // =====================
    function showSettings(){ if(el.settingsOverlay){ el.settingsOverlay.classList.remove("hidden"); el.settingsOverlay.style.display="flex"; } }
    function hideSettings(){ if(el.settingsOverlay){ el.settingsOverlay.classList.add("hidden"); el.settingsOverlay.style.display="none"; } }
    function showForceConfirm(){
      if(lockoutLatched){
        showToast(t("lockoutForceDenied"), "error");
        return;
      }
      if(currentSt!==0){
        showToast(t("forceNotAllowed"), "warn");
        return;
      }
      if(!isControlUnlocked()){
        showToast(t("inspectionRequiredShort"), "warn");
        return;
      }
      if(forceOverlayEl){ forceOverlayEl.classList.remove("hidden"); forceOverlayEl.style.display="flex"; }
      showToast(t("forceWarning", {safety:safetyLineSuffix()}),"warn");
    }
    function hideForceConfirm(){ if(forceOverlayEl){ forceOverlayEl.classList.add("hidden"); forceOverlayEl.style.display="none"; } }
    function showLauncher(){
      if(lockoutLatched){
        showToast(t("lockoutControlDenied"), "error");
        return;
      }
      if(!isControlUnlocked()){
        showToast(t("inspectionRequiredShort"), "warn");
        return;
      }
      if(launcherOverlayEl){ launcherOverlayEl.classList.remove("hidden"); launcherOverlayEl.style.display="flex"; }
    }
    function hideLauncher(){ if(launcherOverlayEl){ launcherOverlayEl.classList.add("hidden"); launcherOverlayEl.style.display="none"; } }
    function launcherStep(dir){
      const dirLabel = (dir==="up") ? t("dirUp") : t("dirDown");
      addLogLine(t("launcherUpDownLog", {dir:dirLabel}),"LAUNCHER");
    }
    function startLauncherHold(dir){
      if(lockoutLatched){ showToast(t("lockoutControlDenied"), "error"); return; }
      if(!isControlUnlocked()){ showToast(t("inspectionRequiredPlain"), "warn"); return; }
      if(dir==="up"){
        if(!launcherUpHold){ launcherStep("up"); launcherUpHold=setInterval(()=>launcherStep("up"),200); }
      }else{
        if(!launcherDownHold){ launcherStep("down"); launcherDownHold=setInterval(()=>launcherStep("down"),200); }
      }
    }
    function stopLauncherHold(dir){
      if(dir==="up"){ if(launcherUpHold){ clearInterval(launcherUpHold); launcherUpHold=null; } }
      else { if(launcherDownHold){ clearInterval(launcherDownHold); launcherDownHold=null; } }
    }

    // =====================
    // XLSX 유틸 (멀티 시트)
    // =====================
    function downloadBlobAsFile(blob, filename){
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
    function escapeXmlText(text){
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&apos;");
    }
    function toColumnName(index){
      let n = index + 1;
      let name = "";
      while(n > 0){
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
      }
      return name;
    }
    function buildSheetXml(rows, drawingRelId, hiddenFromRow){
      let out = '<?xml version="1.0" encoding="UTF-8"?>';
      out += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
      if(drawingRelId){
        out += ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
      }
      out += ">";
      out += "<sheetData>";
      for(let r = 0; r < rows.length; r++){
        const row = rows[r];
        const rowNum = r + 1;
        let rowXml = "";
        const styleId = (r === 0) ? ' s="1"' : "";
        for(let c = 0; c < row.length; c++){
          const value = row[c];
          if(value === null || value === undefined || value === "") continue;
          const cellRef = toColumnName(c) + rowNum;
          if(typeof value === "number" && isFinite(value)){
            rowXml += '<c r="' + cellRef + '" t="n"' + styleId + '><v>' + value + "</v></c>";
          }else{
            const text = String(value);
            const needsPreserve = /^\s|\s$/.test(text);
            rowXml += '<c r="' + cellRef + '" t="inlineStr"' + styleId + '><is><t' + (needsPreserve ? ' xml:space="preserve"' : "") + ">";
            rowXml += escapeXmlText(text);
            rowXml += "</t></is></c>";
          }
        }
        const hiddenAttr = (hiddenFromRow && rowNum >= hiddenFromRow) ? ' hidden="1"' : "";
        out += '<row r="' + rowNum + '"' + hiddenAttr + '>' + rowXml + "</row>";
      }
      out += "</sheetData>";
      if(drawingRelId){
        out += '<drawing r:id="' + drawingRelId + '"/>';
      }
      out += "</worksheet>";
      return out;
    }
    function buildWorkbookXml(sheets){
      let out = '<?xml version="1.0" encoding="UTF-8"?>';
      out += '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ';
      out += 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
      out += "<sheets>";
      for(let i = 0; i < sheets.length; i++){
        const name = escapeXmlText(sheets[i].name || "");
        const hiddenAttr = sheets[i].hidden ? ' state="hidden"' : "";
        out += '<sheet name="' + name + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"' + hiddenAttr + '/>';
      }
      out += "</sheets></workbook>";
      return out;
    }
    function buildWorkbookRelsXml(sheetCount){
      let out = '<?xml version="1.0" encoding="UTF-8"?>';
      out += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
      for(let i = 0; i < sheetCount; i++){
        out += '<Relationship Id="rId' + (i + 1) + '" ';
        out += 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ';
        out += 'Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }
      out += '<Relationship Id="rId' + (sheetCount + 1) + '" ';
      out += 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ';
      out += 'Target="styles.xml"/>';
      out += "</Relationships>";
      return out;
    }
    function buildContentTypesXml(sheetCount, chartCount){
      let out = '<?xml version="1.0" encoding="UTF-8"?>';
      out += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">';
      out += '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>';
      out += '<Default Extension="xml" ContentType="application/xml"/>';
      out += '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
      for(let i = 0; i < sheetCount; i++){
        out += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ';
        out += 'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }
      if(chartCount > 0){
        out += '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>';
        for(let i = 1; i <= chartCount; i++){
          out += '<Override PartName="/xl/charts/chart' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>';
        }
      }
      out += '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
      out += "</Types>";
      return out;
    }
    function buildStylesXml(){
      return '<?xml version="1.0" encoding="UTF-8"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2">' +
          '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>' +
          '<font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/></font>' +
        '</fonts>' +
        '<fills count="2">' +
          '<fill><patternFill patternType="none"/></fill>' +
          '<fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill>' +
        '</fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2">' +
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
          '<xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
        '</cellXfs>' +
        "</styleSheet>";
    }
    function buildSheetRelsXml(){
      return '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
        "</Relationships>";
    }
    function buildDrawingXml(){
      const EMU_PER_INCH = 914400;
      const CHART_W_EMU = Math.round(6 * EMU_PER_INCH);
      const CHART_H_EMU = Math.round(4.5 * EMU_PER_INCH);
      const startCol = 5;
      const secondCol = 15;
      const startRow = 2;
      return '<?xml version="1.0" encoding="UTF-8"?>' +
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<xdr:oneCellAnchor>' +
        '<xdr:from><xdr:col>' + startCol + '</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>' + startRow + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
        '<xdr:ext cx="' + CHART_W_EMU + '" cy="' + CHART_H_EMU + '"/>' +
        '<xdr:graphicFrame macro="">' +
        '<xdr:nvGraphicFramePr>' +
        '<xdr:cNvPr id="2" name="Thrust Chart"/>' +
        '<xdr:cNvGraphicFramePr/>' +
        '</xdr:nvGraphicFramePr>' +
        '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="' + CHART_W_EMU + '" cy="' + CHART_H_EMU + '"/></xdr:xfrm>' +
        '<a:graphic>' +
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
        '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>' +
        '</a:graphicData>' +
        '</a:graphic>' +
        '</xdr:graphicFrame>' +
        '<xdr:clientData/>' +
        '</xdr:oneCellAnchor>' +
        '<xdr:oneCellAnchor>' +
        '<xdr:from><xdr:col>' + secondCol + '</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>' + startRow + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
        '<xdr:ext cx="' + CHART_W_EMU + '" cy="' + CHART_H_EMU + '"/>' +
        '<xdr:graphicFrame macro="">' +
        '<xdr:nvGraphicFramePr>' +
        '<xdr:cNvPr id="3" name="Pressure Chart"/>' +
        '<xdr:cNvGraphicFramePr/>' +
        '</xdr:nvGraphicFramePr>' +
        '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="' + CHART_W_EMU + '" cy="' + CHART_H_EMU + '"/></xdr:xfrm>' +
        '<a:graphic>' +
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
        '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId2"/>' +
        '</a:graphicData>' +
        '</a:graphic>' +
        '</xdr:graphicFrame>' +
        '<xdr:clientData/>' +
        '</xdr:oneCellAnchor>' +
        '</xdr:wsDr>';
    }
    function buildDrawingRelsXml(){
      return '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/>' +
        "</Relationships>";
    }
    function buildChartXml(sheetName, startRow, endRow, chartTitle, seriesCol, seriesNameCell, axisYTitle, lineColor, majorUnit, xMajorUnit, xNumFmt, axisXTitle, xMin, xMax, yMin, yMax, xTickSkip, xLabelCol){
      const xCol = xLabelCol || "A";
      const xRange = sheetName + "!$" + xCol + "$" + startRow + ":$" + xCol + "$" + endRow;
      const seriesRange = sheetName + "!$" + seriesCol + "$" + startRow + ":$" + seriesCol + "$" + endRow;
      const titleText = escapeXmlText(chartTitle || "");
      const yTitleText = escapeXmlText(axisYTitle || "");
      const xTitleText = escapeXmlText(axisXTitle || "time");
      const lineHex = escapeXmlText(lineColor || "3B82F6");
      const unitVal = (majorUnit && isFinite(majorUnit) && majorUnit > 0) ? Number(majorUnit.toFixed(6)) : null;
      const xUnitVal = (xMajorUnit && isFinite(xMajorUnit) && xMajorUnit > 0) ? Number(xMajorUnit.toFixed(6)) : null;
      const xMinVal = (xMin != null && isFinite(xMin)) ? Number(xMin.toFixed(6)) : null;
      const xMaxVal = (xMax != null && isFinite(xMax)) ? Number(xMax.toFixed(6)) : null;
      const yMinVal = (yMin != null && isFinite(yMin)) ? Number(yMin.toFixed(6)) : null;
      const yMaxVal = (yMax != null && isFinite(yMax)) ? Number(yMax.toFixed(6)) : null;
      const xFmt = escapeXmlText(xNumFmt || "0.0");
      const axisBase = 120000 + (seriesCol.charCodeAt(0) - 64) * 10;
      const xAxisId = axisBase + 1;
      const yAxisId = axisBase + 2;
      const axisTitleXml = (text)=>{
        if(!text) return "";
        return '<c:title>' +
          '<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r>' +
          '<a:rPr sz="1100"><a:solidFill><a:srgbClr val="404040"/></a:solidFill></a:rPr>' +
          '<a:t>' + text + '</a:t>' +
          '</a:r></a:p></c:rich></c:tx>' +
          '<c:overlay val="0"/>' +
          '</c:title>';
      };
      const chartTitleXml = (text)=>{
        if(!text) return "";
        return '<c:title>' +
          '<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r>' +
          '<a:rPr sz="1400"><a:solidFill><a:srgbClr val="202020"/></a:solidFill></a:rPr>' +
          '<a:t>' + text + '</a:t>' +
          '</a:r></a:p></c:rich></c:tx>' +
          '<c:overlay val="0"/>' +
          '</c:title>';
      };
      const plotAreaLayout =
        '<c:layout><c:manualLayout>' +
        '<c:layoutTarget val="outer"/>' +
        '<c:xMode val="edge"/><c:yMode val="edge"/>' +
        '<c:x val="0.06"/><c:y val="0.20"/><c:w val="0.88"/><c:h val="0.70"/>' +
        '</c:manualLayout></c:layout>';
      return '<?xml version="1.0" encoding="UTF-8"?>' +
        '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<c:chart>' +
        chartTitleXml(titleText) +
        '<c:autoTitleDeleted val="0"/>' +
        '<c:plotArea>' +
        plotAreaLayout +
        '<c:areaChart>' +
        '<c:grouping val="standard"/>' +
        '<c:dLbls><c:delete val="1"/></c:dLbls>' +
        '<c:ser>' +
        '<c:idx val="0"/><c:order val="0"/>' +
        '<c:tx><c:strRef><c:f>' + seriesNameCell + '</c:f></c:strRef></c:tx>' +
        '<c:cat><c:numRef><c:f>' + xRange + '</c:f></c:numRef></c:cat>' +
        '<c:val><c:numRef><c:f>' + seriesRange + '</c:f></c:numRef></c:val>' +
        '<c:spPr>' +
        '<a:gradFill rotWithShape="1">' +
        '<a:gsLst>' +
        '<a:gs pos="0"><a:srgbClr val="' + lineHex + '"><a:alpha val="32000"/></a:srgbClr></a:gs>' +
        '<a:gs pos="100000"><a:srgbClr val="' + lineHex + '"><a:alpha val="0"/></a:srgbClr></a:gs>' +
        '</a:gsLst>' +
        '<a:lin ang="5400000" scaled="1"/>' +
        '</a:gradFill>' +
        '<a:ln><a:noFill/></a:ln>' +
        '</c:spPr>' +
        '</c:ser>' +
        '<c:axId val="' + xAxisId + '"/><c:axId val="' + yAxisId + '"/>' +
        '</c:areaChart>' +
        '<c:lineChart>' +
        '<c:grouping val="standard"/>' +
        '<c:dLbls><c:delete val="1"/></c:dLbls>' +
        '<c:ser>' +
        '<c:idx val="1"/><c:order val="1"/>' +
        '<c:tx><c:strRef><c:f>' + seriesNameCell + '</c:f></c:strRef></c:tx>' +
        '<c:cat><c:numRef><c:f>' + xRange + '</c:f></c:numRef></c:cat>' +
        '<c:val><c:numRef><c:f>' + seriesRange + '</c:f></c:numRef></c:val>' +
        '<c:marker><c:symbol val="none"/></c:marker>' +
        '<c:spPr><a:ln w="19000"><a:solidFill><a:srgbClr val="' + lineHex + '"/></a:solidFill></a:ln></c:spPr>' +
        '</c:ser>' +
        '<c:axId val="' + xAxisId + '"/><c:axId val="' + yAxisId + '"/>' +
        '</c:lineChart>' +
        '<c:catAx>' +
        '<c:axId val="' + xAxisId + '"/>' +
        '<c:delete val="0"/>' +
        '<c:scaling><c:orientation val="minMax"/></c:scaling>' +
        '<c:axPos val="b"/>' +
        '<c:majorGridlines><c:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="D0D0D0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' +
        '<c:numFmt formatCode="' + xFmt + '" sourceLinked="0"/>' +
        (xTickSkip && xTickSkip > 1 ? ('<c:tickLblSkip val="' + xTickSkip + '"/><c:tickMarkSkip val="' + xTickSkip + '"/>') : '') +
        '<c:majorTickMark val="out"/>' +
        '<c:minorTickMark val="none"/>' +
        '<c:tickLblPos val="nextTo"/>' +
        axisTitleXml(xTitleText) +
        '<c:crossAx val="' + yAxisId + '"/>' +
        '<c:crosses val="autoZero"/>' +
        '</c:catAx>' +
        '<c:valAx>' +
        '<c:axId val="' + yAxisId + '"/>' +
        '<c:delete val="0"/>' +
        '<c:scaling><c:orientation val="minMax"/>' +
        (yMinVal != null ? ('<c:min val="' + yMinVal + '"/>') : '') +
        (yMaxVal != null ? ('<c:max val="' + yMaxVal + '"/>') : '') +
        '</c:scaling>' +
        '<c:axPos val="l"/>' +
        '<c:majorGridlines><c:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="D0D0D0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' +
        '<c:numFmt formatCode="General" sourceLinked="1"/>' +
        (unitVal ? ('<c:majorUnit val="' + unitVal + '"/>') : '') +
        '<c:majorTickMark val="out"/>' +
        '<c:minorTickMark val="none"/>' +
        '<c:tickLblPos val="nextTo"/>' +
        axisTitleXml(yTitleText) +
        '<c:crossAx val="' + xAxisId + '"/>' +
        '<c:crosses val="autoZero"/>' +
        '</c:valAx>' +
        '</c:plotArea>' +
        '<c:plotVisOnly val="1"/>' +
        '<c:dispBlanksAs val="gap"/>' +
        '</c:chart>' +
        '</c:chartSpace>';
    }
    const CRC32_TABLE = (()=>{
      const table = new Uint32Array(256);
      for(let i = 0; i < 256; i++){
        let c = i;
        for(let k = 0; k < 8; k++){
          c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
      }
      return table;
    })();
    function crc32(buf){
      let crc = 0 ^ -1;
      for(let i = 0; i < buf.length; i++){
        crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xff];
      }
      return (crc ^ -1) >>> 0;
    }
    function buildZip(files){
      const encoder = new TextEncoder();
      const fileEntries = [];
      let localSize = 0;

      for(const file of files){
        const nameBytes = encoder.encode(file.name);
        const dataBytes = encoder.encode(file.data);
        const crc = crc32(dataBytes);
        const localHeader = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(localHeader.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 0, true);
        view.setUint16(8, 0, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, 0, true);
        view.setUint32(14, crc, true);
        view.setUint32(18, dataBytes.length, true);
        view.setUint32(22, dataBytes.length, true);
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true);
        localHeader.set(nameBytes, 30);

        fileEntries.push({
          nameBytes,
          dataBytes,
          crc,
          localHeader,
          offset: localSize
        });

        localSize += localHeader.length + dataBytes.length;
      }

      let centralSize = 0;
      const centralParts = [];
      for(const entry of fileEntries){
        const centralHeader = new Uint8Array(46 + entry.nameBytes.length);
        const view = new DataView(centralHeader.buffer);
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 20, true);
        view.setUint16(8, 0, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, 0, true);
        view.setUint16(14, 0, true);
        view.setUint32(16, entry.crc, true);
        view.setUint32(20, entry.dataBytes.length, true);
        view.setUint32(24, entry.dataBytes.length, true);
        view.setUint16(28, entry.nameBytes.length, true);
        view.setUint16(30, 0, true);
        view.setUint16(32, 0, true);
        view.setUint16(34, 0, true);
        view.setUint16(36, 0, true);
        view.setUint32(38, 0, true);
        view.setUint32(42, entry.offset, true);
        centralHeader.set(entry.nameBytes, 46);
        centralParts.push(centralHeader);
        centralSize += centralHeader.length;
      }

      const end = new Uint8Array(22);
      const endView = new DataView(end.buffer);
      endView.setUint32(0, 0x06054b50, true);
      endView.setUint16(4, 0, true);
      endView.setUint16(6, 0, true);
      endView.setUint16(8, fileEntries.length, true);
      endView.setUint16(10, fileEntries.length, true);
      endView.setUint32(12, centralSize, true);
      endView.setUint32(16, localSize, true);
      endView.setUint16(20, 0, true);

      const totalSize = localSize + centralSize + end.length;
      const out = new Uint8Array(totalSize);
      let offset = 0;
      for(const entry of fileEntries){
        out.set(entry.localHeader, offset);
        offset += entry.localHeader.length;
        out.set(entry.dataBytes, offset);
        offset += entry.dataBytes.length;
      }
      for(const central of centralParts){
        out.set(central, offset);
        offset += central.length;
      }
      out.set(end, offset);
      return out;
    }
    function buildXlsxBlob(sheets, chart){
      const chartCount = chart ? 2 : 0;
      const files = [];
      files.push({name:"[Content_Types].xml", data:buildContentTypesXml(sheets.length, chartCount)});
      files.push({name:"_rels/.rels", data:'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'});
      files.push({name:"xl/workbook.xml", data:buildWorkbookXml(sheets)});
      files.push({name:"xl/_rels/workbook.xml.rels", data:buildWorkbookRelsXml(sheets.length)});
      files.push({name:"xl/styles.xml", data:buildStylesXml()});
      for(let i = 0; i < sheets.length; i++){
        const drawingRelId = (chartCount > 0 && i === 0) ? "rId1" : null;
        const hiddenStart = (chartCount > 0 && i === 0 && chart && chart.hideDataFromRow) ? chart.hideDataFromRow : null;
        files.push({name:"xl/worksheets/sheet" + (i + 1) + ".xml", data:buildSheetXml(sheets[i].rows, drawingRelId, hiddenStart)});
      }
      if(chartCount > 0){
        files.push({name:"xl/worksheets/_rels/sheet1.xml.rels", data:buildSheetRelsXml()});
        files.push({name:"xl/drawings/drawing1.xml", data:buildDrawingXml()});
        files.push({name:"xl/drawings/_rels/drawing1.xml.rels", data:buildDrawingRelsXml()});
        files.push({name:"xl/charts/chart1.xml", data:buildChartXml(chart.sheetName, chart.startRow, chart.endRow, chart.titleThrust, "B", chart.seriesNameThrust, chart.axisTitleThrust, "EF4444", chart.majorUnitThrust, chart.xMajorUnit, chart.xNumFmt, chart.axisTitleX, chart.xMin, chart.xMax, chart.yMinThrust, chart.yMaxThrust, chart.xTickSkip, chart.xLabelCol)});
        files.push({name:"xl/charts/chart2.xml", data:buildChartXml(chart.sheetName, chart.startRow, chart.endRow, chart.titlePressure, "C", chart.seriesNamePressure, chart.axisTitlePressure, "3B82F6", chart.majorUnitPressure, chart.xMajorUnit, chart.xNumFmt, chart.axisTitleX, chart.xMin, chart.xMax, chart.yMinPressure, chart.yMaxPressure, chart.xTickSkip, chart.xLabelCol)});
      }
      const zipData = buildZip(files);
      return new Blob([zipData], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
    }

    // =====================
    // 공통 명령 전송: Wi-Fi + (옵션) Serial
    // =====================
    async function sendCommand(cmd, logIt){
      if(lockoutLatched){
        const name = relayMaskName(lockoutRelayMask);
        showToast(t("lockoutCmdDenied", {name}), "error");
        return;
      }

      const API_BASE = (location.protocol === "http:" || location.protocol === "https:")
          ? ""
          : "http://192.168.4.1";

      if(cmd.http){
        const url = API_BASE ? (API_BASE + cmd.http) : cmd.http;
        const opt = API_BASE ? { mode:"no-cors", cache:"no-cache" } : { cache:"no-cache" };
        fetch(url, opt).catch(()=>{});
      }

      let serLine = cmd.ser ? String(cmd.ser).trim() : "";
      if(serLine && serLine[0] !== "/"){
        const parts = serLine.split(/\s+/);
        const head = (parts[0] || "").toUpperCase();

        if(head === "FORCE"){
          serLine = "/force_ignite";
        }else if(head === "COUNTDOWN"){
          serLine = "/countdown_start";
        }else if(head === "ABORT"){
          serLine = "/abort";
        }else if(head === "IGNITE"){
          serLine = "/ignite";
        }else if(head === "PRECOUNT"){
          const uw = (parts[1] != null) ? Number(parts[1]) : 0;
          const cd = (parts[2] != null) ? Number(parts[2]) : 0;
          serLine = "/precount?uw=" + (uw ? 1 : 0) + "&cd=" + Math.max(0, Math.min(30000, cd|0));
        }else if(head === "RS"){
          const v = (parts[1] != null) ? (Number(parts[1]) ? 1 : 0) : 0;
          serLine = "/set?rs=" + v;
        }else if(head === "IGS"){
          const v = (parts[1] != null) ? (Number(parts[1]) ? 1 : 0) : 0;
          serLine = "/set?igs=" + v;
        }else if(head === "IGNMS"){
          const ms = (parts[1] != null) ? (Number(parts[1])|0) : 5000;
          serLine = "/set?ign_ms=" + ms;
        }else if(head === "CDMS"){
          const ms = (parts[1] != null) ? (Number(parts[1])|0) : 10000;
          serLine = "/set?cd_ms=" + ms;
        }
      }

      if(serialEnabled && serialConnected && serialTxEnabled && serLine){
        await serialWriteLine(serLine);
      }

      if(logIt){
        addLogLine(t("cmdSentLog", {cmd:(cmd.http || cmd.ser || "?")}), "CMD");
      }
    }

    // =====================
    // DOM Ready
    // =====================
    document.addEventListener("DOMContentLoaded", async ()=>{
      // ✅ 스플래시 + 프리로드 먼저
      await runSplashAndPreload();

      el.toastContainer = document.getElementById("toastContainer");
      el.logView = document.getElementById("logView");
      el.connDot = document.getElementById("conn-dot");
      el.connText = document.getElementById("conn-text");
      el.statusPill = document.getElementById("statusPill");
      el.statusText = document.getElementById("statusText");
      el.countdown = document.getElementById("countdown");
      el.lockoutBg = document.getElementById("lockoutBg");
      el.kstTime = document.getElementById("kst-time");

      el.thrust = document.getElementById("thrust");
      el.pressure = document.getElementById("pressure");
      el.lt = document.getElementById("lt");

      el.loopPill = document.getElementById("loop-pill");
      el.snapHz   = document.getElementById("snap-hz");
      el.hxHz     = document.getElementById("hx-hz");
      el.cpuUs    = document.getElementById("cpu-us");

      el.modePill = document.getElementById("mode-pill");
      el.relaySafePill = document.getElementById("relay-safe-pill");

      el.sw = document.getElementById("sw");
      el.ic = document.getElementById("ic");
      el.relay = document.getElementById("relay");

      el.ignDelayDisplay = document.getElementById("ignDelayDisplay");
      el.burnDurationDisplay = document.getElementById("burnDurationDisplay");

      el.igniteBtn = document.getElementById("igniteBtn");
      el.abortBtn = document.getElementById("abortBtn");
      el.forceBtn = document.getElementById("forceIgniteBtn");
      el.copyLogBtn = document.getElementById("copyLogBtn");
      el.exportCsvBtn = document.getElementById("exportCsvBtn");

      el.controlsSettingsBtn = document.getElementById("controlsSettingsBtn");
      el.settingsOverlay = document.getElementById("settingsOverlay");
      el.settingsClose = document.getElementById("settingsClose");
      el.settingsSave = document.getElementById("settingsSave");
      el.unitThrust = document.getElementById("unitThrust");
      el.ignTimeInput = document.getElementById("ignTimeInput");
      el.countdownSecInput = document.getElementById("countdownSecInput");

      el.relaySafeToggle = document.getElementById("relaySafeToggle");
      el.igswitch = document.getElementById("igswitch");
      el.serialToggle = document.getElementById("serialToggle");
      el.serialRxToggle = document.getElementById("serialRxToggle");
      el.serialTxToggle = document.getElementById("serialTxToggle");
      el.serialStatus = document.getElementById("serialStatus");
      el.serialStatusText = document.getElementById("serialStatusText");
      el.langSelect = document.getElementById("langSelect");

      el.launcherOpenBtn = document.getElementById("launcherOpenBtn");
      el.inspectionOpenBtn = document.getElementById("inspectionOpenBtn");
      el.inspectionOverlay = document.getElementById("inspectionOverlay");
      el.inspectionClose = document.getElementById("inspectionClose");
      el.inspectionResult = document.getElementById("inspectionResult");
      el.inspectionRetry = document.getElementById("inspectionRetry");
      el.inspectionStatusPill = document.getElementById("inspectionStatusPill");

      el.longPressBtn = document.getElementById("longPressBtn");

      // ✅ LOCKOUT modal elements
      el.lockoutOverlay = document.getElementById("lockoutOverlay");
      el.lockoutImg = document.getElementById("lockoutImg");
      el.lockoutTitle = document.getElementById("lockoutTitle");
      el.lockoutText = document.getElementById("lockoutText");
      el.lockoutNote = document.getElementById("lockoutNote");

      const helpLink=document.getElementById("controlsHelpLink");
      if(helpLink){ helpLink.addEventListener("click",()=>{ window.location.href="/help"; }); }

      loadSettings();
      applySettingsToUI();
      addLogLine(t("systemReadyLog"),"READY");
      showToast(t("dashboardStartToast", {safety:safetyLineSuffix()}),"info");
      setLockoutVisual(false);
      resetInspectionUI();
      setButtonsFromState(currentSt, lockoutLatched);

      confirmOverlayEl=document.getElementById("confirmOverlay");
      longPressSpinnerEl=document.querySelector("#longPressBtn .longpress-spinner");
      confirmTitleEl=document.querySelector("#confirmOverlay .confirm-title");
      const confirmCancelBtn=document.getElementById("confirmCancel");

      forceOverlayEl=document.getElementById("forceOverlay");
      launcherOverlayEl=document.getElementById("launcherOverlay");

      const launcherCloseBtn=document.getElementById("launcherClose");
      const launcherUpBtn=document.getElementById("launcherUpModalBtn");
      const launcherDownBtn=document.getElementById("launcherDownModalBtn");

      if(el.relaySafeToggle){
        el.relaySafeToggle.addEventListener("change",()=>{
          relaySafeEnabled = !!el.relaySafeToggle.checked;
          uiSettings.relaySafe = relaySafeEnabled;
          saveSettings();
          updateRelaySafePill();
          sendCommand({http:"/set?rs="+(relaySafeEnabled?1:0), ser:"RS "+(relaySafeEnabled?1:0)}, true);
          showToast(relaySafeEnabled ? t("relaySafeOnToast") : t("relaySafeOffToast"), relaySafeEnabled?"info":"warn");
        });
      }

      if(el.igswitch){
        el.igswitch.addEventListener("change",()=>{
          const val=el.igswitch.checked?1:0;
          uiSettings.igs = val;
          saveSettings();
          sendCommand({http:"/set?igs="+val, ser:"IGS "+val}, true);
          addLogLine(t("igsToggledLog", {state:(val?"ON":"OFF")}),"SAFE");
          showToast(val ? t("igsToggledOnToast", {safety:safetyLineSuffix()})
                       : t("igsToggledOffToast", {safety:safetyLineSuffix()}),
                   val ? "warn" : "info");
        });
      }

      if(el.serialToggle){
        el.serialToggle.addEventListener("change",async ()=>{
          serialEnabled = !!el.serialToggle.checked;
          uiSettings.serialEnabled = serialEnabled;
          saveSettings();
          updateSerialPill();

          if(serialEnabled){
            await serialConnect();
          }else{
            await serialDisconnect();
          }
        });
      }
      if(el.serialRxToggle){
        el.serialRxToggle.addEventListener("change",()=>{
          serialRxEnabled = !!el.serialRxToggle.checked;
          uiSettings.serialRx = serialRxEnabled;
          saveSettings();
          showToast(serialRxEnabled ? t("serialRxOnToast") : t("serialRxOffToast"), "info");
        });
      }
      if(el.serialTxToggle){
        el.serialTxToggle.addEventListener("change",()=>{
          serialTxEnabled = !!el.serialTxToggle.checked;
          uiSettings.serialTx = serialTxEnabled;
          saveSettings();
          showToast(serialTxEnabled ? t("serialTxOnToast") : t("serialTxOffToast"), "info");
        });
      }
      if(el.langSelect){
        el.langSelect.addEventListener("change",()=>{
          uiSettings.lang = (el.langSelect.value === "en") ? "en" : "ko";
          saveSettings();
          setLanguage(uiSettings.lang);
        });
      }

      if(el.igniteBtn){
        el.igniteBtn.addEventListener("click",()=>{
          if(currentSt===0) showConfirm();
        });
      }

      if(el.abortBtn){
        el.abortBtn.addEventListener("click",()=>{
          if(lockoutLatched){
            const name = relayMaskName(lockoutRelayMask);
          showToast(t("lockoutAbortDenied", {name}), "error");
            return;
          }
          sendCommand({http:"/abort", ser:"ABORT"}, true);
          showToast(t("abortRequestedToast", {safety:safetyLineSuffix()}),"error");
          hideConfirm();
        });
      }

      if(confirmCancelBtn){ confirmCancelBtn.addEventListener("click",()=>hideConfirm()); }

      if(el.longPressBtn){
        el.longPressBtn.addEventListener("pointerdown", (e)=>{ e.preventDefault(); el.longPressBtn.setPointerCapture(e.pointerId); startHold(); });
        el.longPressBtn.addEventListener("pointerup",   (e)=>{ e.preventDefault(); endHold(); });
        el.longPressBtn.addEventListener("pointercancel",(e)=>{ e.preventDefault(); endHold(); });
      }

      if(el.inspectionOpenBtn){
        const openInspection=()=>{
          if(!connOk){
            showToast(t("inspectionOpenToast"), "warn");
            return;
          }
          showInspection();
        };
        el.inspectionOpenBtn.addEventListener("click", openInspection);
        el.inspectionOpenBtn.addEventListener("keydown",(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); openInspection(); }});
      }
      if(el.inspectionRetry){
        el.inspectionRetry.addEventListener("click",()=>runInspectionSequence());
      }
      if(el.inspectionClose){
        el.inspectionClose.addEventListener("click",()=>hideInspection());
      }
      if(el.inspectionOverlay){
        el.inspectionOverlay.addEventListener("click",(ev)=>{ if(ev.target===el.inspectionOverlay) hideInspection(); });
      }

      const forceBtn=el.forceBtn;
      const forceYes=document.getElementById("forceConfirmYes");
      const forceCancel=document.getElementById("forceConfirmCancel");
      if(forceBtn && forceYes && forceCancel){
        forceBtn.addEventListener("click",()=>showForceConfirm());
        forceCancel.addEventListener("click",()=>hideForceConfirm());
        forceYes.addEventListener("click",()=>{
          if(!isControlUnlocked()){
            showToast(t("inspectionRequiredShort"), "warn");
            return;
          }
          hideForceConfirm();
          sendCommand({http:"/force_ignite", ser:"FORCE"}, true);
          showToast(t("forceRequestedToast", {safety:safetyLineSuffix()}),"ignite");
        });
      }

      // ✅ LOCKOUT modal events
      const lockoutCloseBtn = document.getElementById("lockoutClose");
      const lockoutAckBtn = document.getElementById("lockoutAck");
      const lockoutCopyBtn = document.getElementById("lockoutCopy");
      if(lockoutCloseBtn) lockoutCloseBtn.addEventListener("click", ()=>hideLockoutModal());
      if(lockoutAckBtn) lockoutAckBtn.addEventListener("click", ()=>hideLockoutModal());
      if(el.lockoutOverlay){
        el.lockoutOverlay.addEventListener("click",(ev)=>{
          if(ev.target===el.lockoutOverlay) hideLockoutModal();
        });
      }
      if(lockoutCopyBtn){
        lockoutCopyBtn.addEventListener("click", ()=>{
          const name = relayMaskName(lockoutRelayMask);
          addLogLine(t("lockoutAckLog", {name}), "SAFE");
          showToast(t("lockoutAckToast", {name}), "error", {duration:7000});
        });
      }

      if(el.copyLogBtn){
        el.copyLogBtn.addEventListener("click",()=>{
          const text=logLines.join("\n");
          if(navigator.clipboard && window.isSecureContext){
            navigator.clipboard.writeText(text).then(()=>{
              addLogLine(t("logCopiedLog"),"INFO");
              showToast(t("logCopiedToast"),"success");
            }).catch(()=>{
              addLogLine(t("clipboardCopyFailedLog"),"ERROR");
              showToast(t("clipboardCopyFailedToast"),"error");
            });
          }else{
            try{
              const ta=document.createElement("textarea");
              ta.value=text; ta.style.position="fixed"; ta.style.top="-9999px";
              document.body.appendChild(ta);
              ta.focus(); ta.select();
              document.execCommand("copy");
              document.body.removeChild(ta);
              addLogLine(t("logCopiedLog"),"INFO");
              showToast(t("logCopiedToast"),"success");
            }catch(e){
              addLogLine(t("copyFailedLog", {err:e}),"ERROR");
              showToast(t("copyFailedToast"),"error");
            }
          }
        });
      }

      if(el.exportCsvBtn){
        el.exportCsvBtn.addEventListener("click",()=>{
          const now = new Date();
          const pad = (n)=>String(n).padStart(2,"0");
          const fnameSuffix =
            now.getFullYear().toString()+
            pad(now.getMonth()+1)+pad(now.getDate())+"_"+pad(now.getHours())+pad(now.getMinutes())+pad(now.getSeconds());
          const filename = "ALTIS_FLASH_DAQ_" + fnameSuffix + "_data.xlsx";

          const hasIgnitionWindow =
            ignitionAnalysis.hasData &&
            ignitionAnalysis.ignStartMs!=null &&
            ignitionAnalysis.thresholdMs!=null &&
            ignitionAnalysis.lastAboveMs!=null;

          const windowStartMs = hasIgnitionWindow ? (ignitionAnalysis.thresholdMs - IGN_PRE_WINDOW_MS) : null;
          const windowEndMs   = hasIgnitionWindow ? (ignitionAnalysis.lastAboveMs + IGN_POST_WINDOW_MS) : null;

          const delayVal = (ignitionAnalysis.delaySec!=null) ? ignitionAnalysis.delaySec.toFixed(3) : "";
          const durVal   = (ignitionAnalysis.durationSec!=null) ? ignitionAnalysis.durationSec.toFixed(3) : "";

          const summaryRows = [
            [t("hdrTimeIso"), t("hdrMessage"), t("hdrIgnWindow"), t("hdrIgnDelay"), t("hdrBurn"), t("hdrThreshold")],
            [
              now.toISOString(),
              hasIgnitionWindow ? t("ignWindowDetected") : t("ignWindowNone"),
              hasIgnitionWindow ? 1 : 0,
              delayVal !== "" ? Number(delayVal) : "",
              durVal !== "" ? Number(durVal) : "",
              Number(IGN_THRUST_THRESHOLD.toFixed(3))
            ],
            [],
            [t("hdrElapsedMs"), t("hdrThrust"), t("hdrPressure"), "time_axis"]
          ];

          const eventRows = [[t("hdrTimeIso"), t("hdrTag"), t("hdrMessage")]];
          for(const e of eventLog){
            eventRows.push([e.time || "", e.tag || "", e.message || ""]);
          }

          const rawRows = [[
            t("hdrTimeIso"), t("hdrThrust"), t("hdrPressure"), t("hdrLoopMs"), t("hdrElapsedMs"), t("hdrHxHz"), t("hdrCpuUs"), t("hdrSwitch"), t("hdrIgnOk"), t("hdrRelay"),
            t("hdrIgs"), t("hdrState"), t("hdrCdMs"), t("hdrRelTime"), t("hdrIgnWindowFlag")
          ]];

          let thrustMin = Infinity;
          let thrustMax = -Infinity;
          let pressureMin = Infinity;
          let pressureMax = -Infinity;
          let baseElapsedSec = null;
          let xMaxSec = null;
          let xDeltaSum = 0;
          let xDeltaCount = 0;
          let lastXVal = null;

          const t0ms = (logData && logData.length) ? Date.parse(logData[0].time) : null;
          for(const row of logData){
            const ms = Date.parse(row.time);
            const rel = (t0ms!=null && isFinite(ms)) ? ((ms - t0ms)/1000) : "";
            const inWin = (hasIgnitionWindow && isFinite(ms) && ms>=windowStartMs && ms<=windowEndMs) ? 1 : 0;
            const tVal = Number(row.t);
            const pVal = Number(row.p);
            if(inWin){
              if(isFinite(tVal)){ if(tVal < thrustMin) thrustMin = tVal; if(tVal > thrustMax) thrustMax = tVal; }
              if(isFinite(pVal)){ if(pVal < pressureMin) pressureMin = pVal; if(pVal > pressureMax) pressureMax = pVal; }
              const elapsedSec = (row.elapsed != null && isFinite(Number(row.elapsed))) ? (Number(row.elapsed) / 1000) : null;
              let xVal = "";
              if(elapsedSec != null && isFinite(elapsedSec)){
                if(baseElapsedSec == null) baseElapsedSec = elapsedSec;
                xVal = elapsedSec - baseElapsedSec;
                if(isFinite(xVal)){
                  if(lastXVal != null){
                    const d = xVal - lastXVal;
                    if(isFinite(d) && d > 0){
                      xDeltaSum += d;
                      xDeltaCount += 1;
                    }
                  }
                  lastXVal = xVal;
                  if(xMaxSec == null || xVal > xMaxSec) xMaxSec = xVal;
                }else{
                  xVal = "";
                }
              }
              const xNum = (xVal !== "" ? Number(xVal.toFixed(3)) : "");
              const xLabel = (xNum !== "" && isFinite(xNum)) ? Number(xNum.toFixed(1)) : "";
              summaryRows.push([
                xNum,
                isFinite(tVal) ? Number(tVal.toFixed(3)) : "",
                isFinite(pVal) ? Number(pVal.toFixed(3)) : "",
                xLabel
              ]);
            }
            rawRows.push([
              row.time || "",
              isFinite(tVal) ? Number(tVal.toFixed(3)) : "",
              isFinite(pVal) ? Number(pVal.toFixed(3)) : "",
              (row.lt ?? ""),
              (row.elapsed != null && isFinite(Number(row.elapsed)) ? Number(Number(row.elapsed).toFixed(0)) : ""),
              (row.hz ?? ""),
              (row.ct ?? ""),
              (row.s  ?? 0),
              (row.ic ?? 0),
              (row.r  ?? 0),
              (row.gs ?? 0),
              (row.st ?? 0),
              (row.cd ?? 0),
              (rel !== "" ? Number(rel.toFixed(3)) : ""),
              inWin
            ]);
          }

          if(summaryRows.length === 4){
            summaryRows.push(["","",""]);
          }

          const calcNiceUnit = (min, max, targetTicks)=>{
            if(!isFinite(min) || !isFinite(max)) return null;
            const range = max - min;
            if(!(range > 0)) return null;
            const rough = range / targetTicks;
            const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
            const n = rough / pow10;
            let step;
            if(n <= 1) step = 1;
            else if(n <= 2) step = 2;
            else if(n <= 5) step = 5;
            else step = 10;
            return step * pow10;
          };
          const axisMinMax = (min, max, step)=>{
            if(!isFinite(min) || !isFinite(max) || !isFinite(step) || !(step > 0)) return {min:null, max:null};
            const low = (min >= 0) ? 0 : Math.floor(min / step) * step;
            const high = Math.ceil(max / step) * step;
            return {min:low, max:high};
          };

          const thrustMajorUnit = calcNiceUnit(thrustMin, thrustMax, 6);
          const pressureMajorUnit = calcNiceUnit(pressureMin, pressureMax, 6);
          const thrustAxis = axisMinMax(thrustMin, thrustMax, thrustMajorUnit || 1);
          const pressureAxis = axisMinMax(pressureMin, pressureMax, pressureMajorUnit || 1);
          const xMajorUnit = 0.5;
          const avgDelta = (xDeltaCount > 0) ? (xDeltaSum / xDeltaCount) : null;
          const xTickSkip = (avgDelta && isFinite(avgDelta) && avgDelta > 0)
            ? Math.max(1, Math.round(xMajorUnit / avgDelta))
            : 1;
          const xMax = (xMaxSec != null && isFinite(xMaxSec)) ? Math.max(xMajorUnit, Math.ceil(xMaxSec / xMajorUnit) * xMajorUnit) : null;

          const chartStartRow = 5;
          const chartEndRow = summaryRows.length;
          const chartConfig = (chartEndRow >= chartStartRow)
            ? {
                sheetName:"IGN_SUMMARY",
                startRow:chartStartRow,
                endRow:chartEndRow,
                titleThrust:t("chartTitleThrust"),
                titlePressure:t("chartTitlePressure"),
                seriesNameThrust:"IGN_SUMMARY!$B$4",
                seriesNamePressure:"IGN_SUMMARY!$C$4",
                axisTitleThrust:t("hdrThrust"),
                axisTitlePressure:t("hdrPressure"),
                axisTitleX:"time",
                majorUnitThrust:thrustMajorUnit,
                majorUnitPressure:pressureMajorUnit,
                xMajorUnit:xMajorUnit,
                xNumFmt:"0.0",
                xTickSkip:xTickSkip,
                xMin:(xMax != null ? 0 : null),
                xMax:xMax,
                yMinThrust:thrustAxis.min,
                yMaxThrust:thrustAxis.max,
                yMinPressure:pressureAxis.min,
                yMaxPressure:pressureAxis.max,
                xLabelCol:"D"
              }
            : null;

          const workbook = buildXlsxBlob([
            {name:"IGN_SUMMARY", rows:summaryRows},
            {name:"EVENT", rows:eventRows},
            {name:"RAW", rows:rawRows}
          ], chartConfig);
          downloadBlobAsFile(workbook, filename);

          addLogLine(t("xlsxExportLog", {filename}), "INFO");
          showToast(t("xlsxExportToast"), "success");
        });
      }

      const navBtns=document.querySelectorAll(".settings-nav-btn");
      const panels=document.querySelectorAll(".settings-panel");
      navBtns.forEach(btn=>{
        btn.addEventListener("click",()=>{
          const target=btn.dataset.target;
          navBtns.forEach(b=>b.classList.remove("active"));
          btn.classList.add("active");
          panels.forEach(p=>p.classList.toggle("active",p.dataset.panel===target));
        });
      });

      if(el.controlsSettingsBtn) el.controlsSettingsBtn.addEventListener("click",()=>showSettings());
      if(el.settingsClose) el.settingsClose.addEventListener("click",()=>hideSettings());
      if(el.settingsOverlay){
        el.settingsOverlay.addEventListener("click",(ev)=>{ if(ev.target===el.settingsOverlay) hideSettings(); });
      }

      updateInspectionAccess();

      if(el.settingsSave && el.unitThrust && el.ignTimeInput && el.countdownSecInput){
        el.settingsSave.addEventListener("click",async ()=>{
          const before=Object.assign({}, uiSettings || defaultSettings());

          uiSettings.thrustUnit = el.unitThrust.value || "kgf";

          let ignSec=parseInt(el.ignTimeInput.value,10);
          if(isNaN(ignSec)||ignSec<1) ignSec=1;
          if(ignSec>10) ignSec=10;
          el.ignTimeInput.value=ignSec;
          uiSettings.ignDurationSec=ignSec;

          let cdSec=parseInt(el.countdownSecInput.value,10);
          if(isNaN(cdSec)||cdSec<3) cdSec=3;
          if(cdSec>30) cdSec=30;
          el.countdownSecInput.value=cdSec;
          uiSettings.countdownSec=cdSec;

          uiSettings.relaySafe = relaySafeEnabled;
          uiSettings.igs = el.igswitch ? (el.igswitch.checked?1:0) : (uiSettings.igs||0);
          uiSettings.serialEnabled = serialEnabled;
          uiSettings.serialRx = serialRxEnabled;
          uiSettings.serialTx = serialTxEnabled;

          saveSettings();
          applySettingsToUI();

          await sendCommand({http:"/set?ign_ms="+(ignSec*1000), ser:"IGNMS "+(ignSec*1000)}, false);
          await sendCommand({http:"/set?cd_ms="+(cdSec*1000),  ser:"CDMS "+(cdSec*1000)}, false);

          if(before.thrustUnit!==uiSettings.thrustUnit){
            showToast(t("thrustUnitChangedToast", {from:before.thrustUnit, to:uiSettings.thrustUnit, safety:safetyLineSuffix()}),"info");
          }
          if(before.ignDurationSec!==uiSettings.ignDurationSec){
            showToast(t("ignTimeChangedToast", {from:before.ignDurationSec, to:uiSettings.ignDurationSec, safety:safetyLineSuffix()}),"warn");
          }
          if(before.countdownSec!==uiSettings.countdownSec){
            showToast(t("countdownChangedToast", {from:before.countdownSec, to:uiSettings.countdownSec, safety:safetyLineSuffix()}),"warn");
          }

          addLogLine(t("settingsUpdatedLog", {unit:uiSettings.thrustUnit, ign:ignSec, cd:cdSec}), "CFG");
          hideSettings();
          redrawCharts();

          if(serialEnabled && !serialConnected){
            await serialConnect();
          }
          if(!serialEnabled && serialConnected){
            await serialDisconnect();
          }
        });
      }

      if(el.launcherOpenBtn && launcherOverlayEl){
        el.launcherOpenBtn.addEventListener("click",()=>showLauncher());
        el.launcherOpenBtn.addEventListener("keydown",(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); showLauncher(); }});
      }
      if(launcherCloseBtn){ launcherCloseBtn.addEventListener("click",()=>hideLauncher()); }
      if(launcherOverlayEl){ launcherOverlayEl.addEventListener("click",(ev)=>{ if(ev.target===launcherOverlayEl) hideLauncher(); }); }

      if(launcherUpBtn || launcherDownBtn){
        const startEvents=["mousedown","touchstart"];
        const endEvents=["mouseup","mouseleave","touchend","touchcancel"];

        if(launcherUpBtn){
          startEvents.forEach(evName=>{
            launcherUpBtn.addEventListener(evName,(ev)=>{ ev.preventDefault(); launcherUpBtn.classList.add("pressed"); startLauncherHold("up"); },{passive:false});
          });
          endEvents.forEach(evName=>{
            launcherUpBtn.addEventListener(evName,(ev)=>{ ev.preventDefault(); launcherUpBtn.classList.remove("pressed"); stopLauncherHold("up"); },{passive:false});
          });
        }

        if(launcherDownBtn){
          startEvents.forEach(evName=>{
            launcherDownBtn.addEventListener(evName,(ev)=>{ ev.preventDefault(); launcherDownBtn.classList.add("pressed"); startLauncherHold("down"); },{passive:false});
          });
          endEvents.forEach(evName=>{
            launcherDownBtn.addEventListener(evName,(ev)=>{ ev.preventDefault(); launcherDownBtn.classList.remove("pressed"); stopLauncherHold("down"); },{passive:false});
          });
        }
      }

      const zoomOutBtn=document.getElementById("chartZoomOut");
      const zoomInBtn=document.getElementById("chartZoomIn");
      const chartLeft=document.getElementById("chartLeft");
      const chartRight=document.getElementById("chartRight");
      const chartLive=document.getElementById("chartLive");

      if(zoomOutBtn){
        zoomOutBtn.addEventListener("click",()=>{ chartView.window=Math.min(MAX_POINTS,Math.round(chartView.window*1.4)); autoScrollChart=false; redrawCharts(); });
      }
      if(zoomInBtn){
        zoomInBtn.addEventListener("click",()=>{ chartView.window=Math.max(10,Math.round(chartView.window*0.7)); autoScrollChart=false; redrawCharts(); });
      }
      if(chartLeft){
        chartLeft.addEventListener("click",()=>{ autoScrollChart=false; chartView.start=(chartView.start||0)-Math.round(chartView.window*0.2); redrawCharts(); });
      }
      if(chartRight){
        chartRight.addEventListener("click",()=>{ autoScrollChart=false; chartView.start=(chartView.start||0)+Math.round(chartView.window*0.2); redrawCharts(); });
      }
      if(chartLive){
        chartLive.addEventListener("click",()=>{ autoScrollChart=true; redrawCharts(); });
      }

      attachTouch("thrustChart");
      attachTouch("pressureChart");
      window.addEventListener("resize",()=>{ redrawCharts(); });

      openWebSocket();
      setInterval(ensureWsAlive, 500);
      updateData().finally(()=>{ pollLoop(); });
      updateSerialPill();

      // ✅ KST 실시간 업데이트
      updateKstClock();
      setInterval(updateKstClock, 1000);
    });
