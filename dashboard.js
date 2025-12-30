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

    let prevSwState = null;
    let prevIcState = null;
    let prevGsState = null;
    let st2StartMs = null;

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
      {key:"igniter", check:()=>latestTelemetry.ic===1},
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
        serialTx: true
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
    }
    function saveSettings(){ try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(uiSettings)); }catch(e){} }

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

      updateRelaySafePill();
      updateSerialPill();
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
      if(el.lockoutTitle) el.lockoutTitle.textContent = "LOCKOUT · " + name;
      if(el.lockoutText){
        el.lockoutText.textContent =
          "비정상적인 릴레이 HIGH 감지 ("+name+")로 모든 제어 권한이 해제되었습니다.";
      }
      if(el.lockoutNote){
        el.lockoutNote.innerHTML =
          "• 릴레이/배선/드라이버 쇼트 여부 확인 후 <strong>보드를 재시작</strong>하세요.";
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
      if(connected){ el.connDot.classList.add("ok"); el.connText.textContent="CONNECTED"; }
      else { el.connDot.classList.remove("ok"); el.connText.textContent="DISCONNECTED"; }
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
      const t = type || "info";
      const duration = (opts && opts.duration) ? opts.duration : 5200;

      const toast = document.createElement("div");
      toast.className = "toast toast-" + t;
      toast.setAttribute("role","status");
      toast.setAttribute("aria-live","polite");

      const iconDiv = document.createElement("div");
      iconDiv.className = "toast-icon";
      const img = document.createElement("img");
      img.src = getToastIconPath(t);
      img.alt = "";
      iconDiv.appendChild(img);

      const bodyDiv = document.createElement("div");
      bodyDiv.className = "toast-body";

      const titleDiv = document.createElement("div");
      titleDiv.className = "toast-title";
      if(t==="success") titleDiv.textContent="완료";
      else if(t==="warn") titleDiv.textContent="주의";
      else if(t==="error") titleDiv.textContent="오류";
      else if(t==="ignite") titleDiv.textContent="점화 / 추력 감지";
      else titleDiv.textContent="알림";

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
      return "안전거리 확보 · 결선/단락 확인 · 주변 인원 접근 금지.";
    }

    function updateRelaySafePill(){
      if(!el.relaySafePill) return;
      setLockoutVisual(lockoutLatched);

      if(lockoutLatched){
        const name = relayMaskName(lockoutRelayMask);
        el.relaySafePill.textContent = "LOCKOUT(" + name + ")";
        el.relaySafePill.style.color = "#991b1b";
      }else{
        el.relaySafePill.textContent = relaySafeEnabled ? "SAFE" : "OFF";
        el.relaySafePill.style.color = relaySafeEnabled ? "#166534" : "#64748b";
      }
    }

    function updateSerialPill(){
      if(!el.serialStatus || !el.serialStatusText) return;
      const enabled = serialEnabled;
      const ok = enabled && serialConnected;
      el.serialStatus.classList.remove("ok","bad");
      if(!enabled){
        el.serialStatusText.textContent = "OFF";
      }else if(ok){
        el.serialStatus.classList.add("ok");
        el.serialStatusText.textContent = "CONNECTED";
      }else{
        el.serialStatus.classList.add("bad");
        el.serialStatusText.textContent = "DISCONNECTED";
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
      item.classList.remove("state-running","state-ok","state-bad");
      if(state==="running") item.classList.add("state-running");
      else if(state==="ok") item.classList.add("state-ok");
      else if(state==="bad") item.classList.add("state-bad");
      const status=item.querySelector(".inspection-status");
      if(status){
        status.textContent = label || (state==="ok" ? "정상" : state==="bad" ? "확인 필요" : "진행중");
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
      INSPECTION_STEPS.forEach(s=>setInspectionItemState(s.key,"", "대기"));
      setInspectionResult("점검 대기중…","neutral");
      updateInspectionPill();
      updateControlAccessUI(currentSt);
    }

    async function runInspectionSequence(){
      if(inspectionRunning) return;
      inspectionRunning=true;
      inspectionState="running";
      controlAuthority=false;
      updateInspectionPill();
      setInspectionResult("점검 중…","running");
      updateControlAccessUI(currentSt);

      let hasFail=false;
      for(const step of INSPECTION_STEPS){
        setInspectionItemState(step.key,"running","확인 중");
        await delay(320);
        let ok=false;
        try{ ok = !!step.check(); }catch(e){ ok=false; }
        setInspectionItemState(step.key, ok ? "ok" : "bad", ok ? "정상" : "확인 필요");
        if(!ok) hasFail=true;
        await delay(180);
      }

      inspectionRunning=false;
      inspectionState = hasFail ? "failed" : "passed";

      if(hasFail){
        controlAuthority=false;
        setInspectionResult("점검 실패 항목이 있습니다.","error");
        showToast("점검 실패 항목이 있습니다. 상태를 확인하세요.","warn");
        addLogLine("설비 점검 실패: 일부 항목이 통과하지 못했습니다.","SAFE");
      }else{
        controlAuthority=true;
        setInspectionResult("모든 항목 통과. 제어 권한 확보됨.","ok");
        showToast("설비 점검 통과. 제어 권한을 획득했습니다.","success");
        addLogLine("설비 점검 완료. 제어 권한을 획득했습니다.","SAFE");
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
      const cssW = Math.max(160, rect.width || (canvas.parentElement?.clientWidth || 200));
      const cssH = Math.max(180, rect.height || 220);
      const dpr  = window.devicePixelRatio || 1;

      if(canvas._cssW!==cssW || canvas._cssH!==cssH || canvas._dpr!==dpr){
        canvas.style.width  = cssW + "px";
        canvas.style.height = cssH + "px";
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
        ctx.fillText("NO DATA", width/2, height/2);
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
        el.statusPill.textContent="LOCKOUT";
        const name = relayMaskName(lockoutRelayMask);
        el.statusText.textContent="비정상적인 릴레이 HIGH 감지 ("+name+"). 모든 제어 권한이 해제되었습니다. 보드를 재시작하세요.";
        return 9;
      }
      if(aborted){
        el.statusPill.className="status-abort"; el.statusPill.textContent="ABORT"; el.statusText.textContent="Sequence aborted"; return 4;
      }
      if(st===2){
        el.statusPill.className="status-fire"; el.statusPill.textContent="IGNITION"; el.statusText.textContent="Igniter firing"; return 2;
      }
      if(st===1){
        el.statusPill.className="status-count"; el.statusPill.textContent="COUNTDOWN"; el.statusText.textContent="Launch countdown in progress"; return 1;
      }
      if(!ignOK){
        el.statusPill.className="status-disc"; el.statusPill.textContent="NOT ARMED"; el.statusText.textContent="Igniter open / not ready"; return 3;
      }
      el.statusPill.className="status-ready"; el.statusPill.textContent="READY"; el.statusText.textContent="System ready"; return 0;
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
          el.statusPill.textContent="DISCONNECTED";
          el.statusText.textContent = reason || "No response from board";
        }

        if(!disconnectedLogged){
          addLogLine("Dashboard lost connection to board.", "DISC");
          disconnectedLogged = true;
        }

        if(now - lastDiscAnnounceMs > DISC_TOAST_COOLDOWN_MS){
          lastDiscAnnounceMs = now;
          showToast("보드 응답이 불안정합니다. 전원/배선/Wi-Fi/폴링 주기를 확인하세요.", "warn");
        }
      }
    }

    // =====================
    // WebSerial helpers
    // =====================
    function serialSupported(){ return !!(navigator && navigator.serial); }

    async function serialConnect(){
      if(!serialSupported()){
        showToast("이 브라우저는 WebSerial을 지원하지 않습니다. (Chrome/Edge 권장)", "warn");
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

        addLogLine("WebSerial connected @460800.", "SER");
        showToast("시리얼(WebSerial) 연결 완료.", "success");

        if(serialReader){
          readSerialLoop().catch(err=>{
            addLogLine("Serial read loop ended: " + (err?.message||err), "SER");
          });
        }
      }catch(e){
        serialConnected = false;
        updateSerialPill();
        addLogLine("WebSerial connect failed: " + (e?.message || e), "SER");
        showToast("시리얼 연결 실패. 포트/권한을 확인하세요.", "error");
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
        addLogLine("WebSerial disconnected.", "SER");
      }
    }

    async function serialWriteLine(line){
      if(!serialConnected || !serialWriter) return false;
      try{
        const data = new TextEncoder().encode(line.endsWith("\n") ? line : (line + "\n"));
        await serialWriter.write(data);
        return true;
      }catch(e){
        addLogLine("Serial write failed: " + (e?.message||e), "SER");
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
      lastOkMs = nowOk;
      failStreak = 0;

      if(!connOk){
        connOk = true;
        disconnectedLogged = false;
        updateConnectionUI(true);
        addLogLine("Link established (" + srcTag + ").", "NET");
        showToast("보드와 연결되었습니다. (" + srcTag + ")", "success", {duration:2600});
      }

      sampleCounter++;

      const nowDate=new Date();
      const timeMs=nowDate.getTime();
      const timeIso=nowDate.toISOString();

      const t   = Number(data.t  != null ? data.t  : (data.thrust   ?? 0));
      const p   = Number(data.p  != null ? data.p  : (data.pressure ?? 0));
      const lt  = Number(data.lt != null ? data.lt : (data.loop ?? data.loopTime ?? 0));

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

      thrustBaseHistory.push(t);
      pressureBaseHistory.push(p);

      const maxKeep=MAX_POINTS*4;
      if(thrustBaseHistory.length>maxKeep){
        const remove=thrustBaseHistory.length-maxKeep;
        thrustBaseHistory.splice(0,remove);
        pressureBaseHistory.splice(0,remove);
        chartView.start=Math.max(0,chartView.start-remove);
      }

      sampleHistory.push({timeMs,timeIso,t,p,lt,hz:hxHz,ct:ctUs,sw:sw?1:0,ic:ic?1:0,r:rly?1:0,st,cd:cd??0});
      if(sampleHistory.length>SAMPLE_HISTORY_MAX){
        const remove=sampleHistory.length-SAMPLE_HISTORY_MAX;
        sampleHistory.splice(0,remove);
      }

      logData.push({time:timeIso,t,p,lt,hz:hxHz,ct:ctUs,s:sw?1:0,ic:ic?1:0,r:rly?1:0,gs,st,cd:cd??0});
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

          addLogLine("LOCKOUT: abnormal relay HIGH detected ("+name+"). Control revoked. Restart required.", "SAFE");
          showToast(
            "비정상적인 릴레이 HIGH 감지 ("+name+"). 모든 제어 권한이 해제되었습니다. 보드를 재시작하세요.",
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
        addLogLine("Ignition signal detected (st=2). Tracking thrust over "+IGN_THRUST_THRESHOLD.toFixed(2)+" kgf.","IGN");
      }

      if(ignitionAnalysis.ignStartMs!=null && t>=IGN_THRUST_THRESHOLD){
        if(ignitionAnalysis.thresholdMs==null){
          ignitionAnalysis.thresholdMs=timeMs;
          ignitionAnalysis.delaySec=(ignitionAnalysis.thresholdMs-ignitionAnalysis.ignStartMs)/1000.0;
          addLogLine("Thrust exceeded "+IGN_THRUST_THRESHOLD.toFixed(2)+" kgf. Ignition delay = "+ignitionAnalysis.delaySec.toFixed(3)+" s","IGN");
          showToast("추력이 임계값("+IGN_THRUST_THRESHOLD.toFixed(2)+" kgf) 이상으로 감지되었습니다. 점화 지연 ≈ "+ ignitionAnalysis.delaySec.toFixed(3) + "s. " + safetyLineSuffix(),"ignite");
        }
        ignitionAnalysis.lastAboveMs=timeMs;
        ignitionAnalysis.durationSec=Math.max(0,(ignitionAnalysis.lastAboveMs-ignitionAnalysis.thresholdMs)/1000.0);
        ignitionAnalysis.hasData=true;
      }

      if(prevStForIgn===2 && st!==2 && ignitionAnalysis.ignStartMs!=null && !ignitionAnalysis.endNotified){
        ignitionAnalysis.endNotified=true;
        if(ignitionAnalysis.durationSec!=null){
          addLogLine("Ignition state finished. Burn duration ≈ "+ignitionAnalysis.durationSec.toFixed(3)+" s","IGN");
          showToast("유효추력 구간이 종료된 것으로 보입니다. 잔열/잔류가스 주의 후 접근하세요.","info");
        }else{
          addLogLine("Ignition state finished. No thrust over threshold detected.","IGN");
          showToast("점화 상태 종료. 유효추력이 감지되지 않았습니다. 결선/이그나이터 상태를 확인하세요. "+safetyLineSuffix(),"warn");
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
            addLogLine("Switch changed: HIGH (ON).", "SW");
            showToast("스위치가 HIGH(ON) 상태입니다. 시퀀스 조건/주변 안전을 재확인하세요. "+safetyLineSuffix(),"warn");
          }else{
            addLogLine("Switch changed: LOW (OFF).", "SW");
            showToast("스위치가 LOW(OFF) 상태입니다. 안전 상태로 유지하세요. "+safetyLineSuffix(),"info");
          }
        }

        if(prevIcState===null) prevIcState=!!ic;
        else if(prevIcState!==!!ic){
          prevIcState=!!ic;
          if(prevIcState){
            addLogLine("Igniter continuity: OK.", "IGN");
            showToast("Igniter 상태가 OK로 변경되었습니다. 점화 전 결선/단락/극성을 재확인하세요. "+safetyLineSuffix(),"success");
          }else{
            addLogLine("Igniter continuity: NO / OPEN.", "IGN");
            showToast("Igniter가 NO(OPEN) 상태입니다. 커넥터/배선/단선 여부를 확인하세요. "+safetyLineSuffix(),"warn");
          }
        }

        if(prevGsState===null) prevGsState=!!gs;
        else if(prevGsState!==!!gs){
          prevGsState=!!gs;
          if(prevGsState){
            addLogLine("Igniter Safety Test: ON (from board).", "SAFE");
            showToast("Igniter Safety Test가 ON입니다. 의도치 않은 인가 위험이 있습니다. "+safetyLineSuffix(),"warn");
          }else{
            addLogLine("Igniter Safety Test: OFF (from board).", "SAFE");
            showToast("Igniter Safety Test가 OFF입니다. 안전 상태로 복귀했습니다. "+safetyLineSuffix(),"info");
          }
        }

        const thrustDisp=convertThrustForDisplay(t);
        const thrustUnit = (uiSettings && uiSettings.thrustUnit) ? uiSettings.thrustUnit : "kgf";

        if(el.thrust)   el.thrust.innerHTML   = `<span class="num">${thrustDisp.toFixed(3)}</span><span class="unit">${thrustUnit}</span>`;
        if(el.pressure) el.pressure.innerHTML = `<span class="num">${p.toFixed(3)}</span><span class="unit">V</span>`;
        if(el.lt)       el.lt.innerHTML       = `<span class="num">${lt.toFixed(0)}</span><span class="unit">ms</span>`;

        if(el.loopPill) el.loopPill.textContent = lt.toFixed(0) + " ms";
        if(el.snapHz){
          const snapHz = (lt>0) ? (1000/lt) : 0;
          el.snapHz.textContent = (snapHz>0 && isFinite(snapHz)) ? (snapHz.toFixed(1) + " Hz") : "-- Hz";
        }
        if(el.hxHz) el.hxHz.textContent = (hxHz>0 && isFinite(hxHz)) ? (hxHz.toFixed(0) + " Hz") : "-- Hz";
        if(el.cpuUs) el.cpuUs.textContent = (ctUs>0 && isFinite(ctUs)) ? (ctUs.toFixed(0) + " us") : "-- us";

        if(el.ignDelayDisplay) el.ignDelayDisplay.textContent = (ignitionAnalysis.delaySec!=null) ? ("Delay "+ignitionAnalysis.delaySec.toFixed(3)+"s") : "Delay --.-s";
        if(el.burnDurationDisplay) el.burnDurationDisplay.textContent = (ignitionAnalysis.durationSec!=null) ? ("Burn "+ignitionAnalysis.durationSec.toFixed(3)+"s") : "Burn --.-s";

        if(el.modePill){
          let label="-";
          if(mode===0) label="SERIAL";
          else if(mode===1) label="WIFI";
          else if(mode===2) label="AUTO";
          el.modePill.textContent=label;
        }

        updateRelaySafePill();

        if(el.sw){
          if(sw){ el.sw.textContent="HIGH"; el.sw.className="pill pill-green"; }
          else { el.sw.textContent="LOW"; el.sw.className="pill pill-gray"; }
        }

        if(el.ic){
          if(ic){ el.ic.textContent="OK"; el.ic.className="pill pill-green"; }
          else { el.ic.textContent="NO"; el.ic.className="pill pill-red"; }
        }

        if(el.relay){
          if(rly){ el.relay.textContent="ON"; el.relay.className="pill pill-green"; }
          else { el.relay.textContent="OFF"; el.relay.className="pill pill-gray"; }
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
            addLogLine("Countdown started (st=1).","COUNT");
            showToast("카운트다운이 시작되었습니다. 주변 안전거리 확보 후 진행하세요. "+safetyLineSuffix(),"warn");
          }else if(statusCode===2){
            addLogLine("Ignition firing (st=2).","IGNITE");
            showToast("점화 시퀀스가 진행 중입니다. 절대 접근하지 마세요. "+safetyLineSuffix(),"ignite");
          }else if(statusCode===0 && lastStatusCode===2){
            addLogLine("Sequence complete. Back to idle.","DONE");
            showToast("시퀀스가 완료되었습니다. 잔열/잔류가스 주의 후 접근하세요.","success");
          }else if(statusCode===4){
            addLogLine("Sequence aborted.","ABORT");
            showToast("ABORT 처리되었습니다. 재시도 전 결선/스위치/환경을 다시 확인하세요. "+safetyLineSuffix(),"error");
          }else if(statusCode===3){
            showToast("NOT ARMED 상태입니다. 이그나이터 연결 상태를 확인하세요. "+safetyLineSuffix(),"warn");
          }else if(statusCode===9){
            const now = Date.now();
            if(now - lastLockoutToastMs > 5000){
              lastLockoutToastMs = now;
              const name = relayMaskName(lockoutRelayMask);
              showToast("비정상적인 릴레이 HIGH 감지 ("+name+"). 모든 제어가 정지됩니다. 보드를 재시작하세요.", "error", {duration:12000});
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
      isUpdating=true;
      try{
        let data;
        try{
          data=await fetchJsonWithFallback();
        }catch(err){
          failStreak++;
          markDisconnectedIfNeeded("No response from board");
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
        addLogLine("Polling error: " + (e?.message || e), "ERROR");
        showToast("폴링 중 오류가 발생했습니다. 로그를 확인하세요.", "error");
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
      if(confirmTitleEl) confirmTitleEl.textContent="점화 시퀀스를 진행할까요?";
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
        showToast("LOCKOUT 상태에서는 어떤 제어도 불가능합니다. 보드를 재시작하세요.", "error");
        return;
      }
      if(!isControlUnlocked()){
        showToast("설비 점검을 먼저 완료하세요. 점검 통과 후 제어 권한이 부여됩니다.", "warn");
        return;
      }
      if(lpTimer){ clearInterval(lpTimer); lpTimer=null; }
      resetLongPressVisual();
      userWaitingLocal=true;
      lpLastSentSec=3;
      if(confirmOverlayEl){ confirmOverlayEl.classList.remove("hidden"); confirmOverlayEl.style.display="flex"; }
      sendCommand({http:"/precount?uw=1&cd=3000", ser:"PRECOUNT 1 3000"}, false);
      showToast("시퀀스 시작 전 최종 안전 확인을 진행하세요. 3초 롱프레스로 진입합니다. "+safetyLineSuffix(),"warn");
    }

    function startHold(){
      if(lockoutLatched) return;
      if(!isControlUnlocked()){
        showToast("설비 점검을 먼저 완료하세요. 제어 권한이 필요합니다.", "warn");
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
          confirmTitleEl.textContent = sec>0 ? ("점화 시퀀스 진입까지 "+sec+"초") : "카운트다운 시작";
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
          addLogLine("Countdown requested from dashboard (long-press).","CMD");
          showToast("카운트다운 요청을 보드에 전송했습니다. 신호/배선/주변을 계속 확인하세요. "+safetyLineSuffix(),"ignite");
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
        showToast("롱프레스가 취소되었습니다. 주변 안전 확보 후 다시 시도하세요. "+safetyLineSuffix(),"info");
      }
    }

    // =====================
    // 설정/발사대
    // =====================
    function showSettings(){ if(el.settingsOverlay){ el.settingsOverlay.classList.remove("hidden"); el.settingsOverlay.style.display="flex"; } }
    function hideSettings(){ if(el.settingsOverlay){ el.settingsOverlay.classList.add("hidden"); el.settingsOverlay.style.display="none"; } }
    function showForceConfirm(){
      if(lockoutLatched){
        showToast("LOCKOUT 상태에서는 강제점화를 포함한 제어가 불가능합니다. 보드를 재시작하세요.", "error");
        return;
      }
      if(currentSt!==0){
        showToast("시퀀스 진행 중에는 강제 점화를 사용할 수 없습니다.", "warn");
        return;
      }
      if(!isControlUnlocked()){
        showToast("설비 점검을 먼저 완료하세요. 제어 권한이 필요합니다.", "warn");
        return;
      }
      if(forceOverlayEl){ forceOverlayEl.classList.remove("hidden"); forceOverlayEl.style.display="flex"; }
      showToast("강제 점화는 고위험 동작입니다. 마지막 확인 후 진행하세요. "+safetyLineSuffix(),"warn");
    }
    function hideForceConfirm(){ if(forceOverlayEl){ forceOverlayEl.classList.add("hidden"); forceOverlayEl.style.display="none"; } }
    function showLauncher(){
      if(lockoutLatched){
        showToast("LOCKOUT 상태에서는 제어가 불가능합니다.", "error");
        return;
      }
      if(!isControlUnlocked()){
        showToast("설비 점검을 먼저 완료하세요. 제어 권한이 필요합니다.", "warn");
        return;
      }
      if(launcherOverlayEl){ launcherOverlayEl.classList.remove("hidden"); launcherOverlayEl.style.display="flex"; }
    }
    function hideLauncher(){ if(launcherOverlayEl){ launcherOverlayEl.classList.add("hidden"); launcherOverlayEl.style.display="none"; } }
    function launcherStep(dir){ addLogLine("Launcher "+(dir==="up"?"UP":"DOWN")+" (UI only).","LAUNCHER"); }
    function startLauncherHold(dir){
      if(lockoutLatched){ showToast("LOCKOUT 상태에서는 제어가 불가능합니다.", "error"); return; }
      if(!isControlUnlocked()){ showToast("설비 점검을 먼저 완료하세요.", "warn"); return; }
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
    // CSV 유틸 (단일 파일 통합)
    // =====================
    function downloadTextAsFile(text, filename){
      const blob = new Blob([text], {type:"text/csv"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
    function escapeCsvField(v){
      const s = (v==null) ? "" : String(v);
      if(/[",\n\r]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
      return s;
    }

    // =====================
    // 공통 명령 전송: Wi-Fi + (옵션) Serial
    // =====================
    async function sendCommand(cmd, logIt){
      if(lockoutLatched){
        const name = relayMaskName(lockoutRelayMask);
        showToast("LOCKOUT("+name+") 상태에서는 명령을 보낼 수 없습니다. 보드를 재시작하세요.", "error");
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
        addLogLine("CMD => " + (cmd.http || cmd.ser || "?"), "CMD");
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
      addLogLine("System ready. Waiting for commands.","READY");
      showToast("대시보드가 시작되었습니다. 연결 상태 확인 후 운용하세요. "+safetyLineSuffix(),"info");
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
          showToast(relaySafeEnabled ? "RelaySafe가 ON입니다. 비정상 릴레이 HIGH 감지 시 LOCKOUT 됩니다." : "RelaySafe가 OFF입니다. (권장하지 않음)", relaySafeEnabled?"info":"warn");
        });
      }

      if(el.igswitch){
        el.igswitch.addEventListener("change",()=>{
          const val=el.igswitch.checked?1:0;
          uiSettings.igs = val;
          saveSettings();
          sendCommand({http:"/set?igs="+val, ser:"IGS "+val}, true);
          addLogLine("Igniter Safety Test toggled: "+(val?"ON":"OFF"),"SAFE");
          showToast(val ? ("Igniter Safety Test가 ON입니다. 이그나이터/배선에 주의하세요. "+safetyLineSuffix())
                       : ("Igniter Safety Test가 OFF입니다. 안전 상태로 유지하세요. "+safetyLineSuffix()),
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
          showToast(serialRxEnabled ? "시리얼 수신 파싱 ON" : "시리얼 수신 파싱 OFF", "info");
        });
      }
      if(el.serialTxToggle){
        el.serialTxToggle.addEventListener("change",()=>{
          serialTxEnabled = !!el.serialTxToggle.checked;
          uiSettings.serialTx = serialTxEnabled;
          saveSettings();
          showToast(serialTxEnabled ? "시리얼 명령 전송 ON" : "시리얼 명령 전송 OFF", "info");
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
            showToast("LOCKOUT("+name+") 상태에서는 ABORT도 불가능합니다. 보드를 재시작하세요.", "error");
            return;
          }
          sendCommand({http:"/abort", ser:"ABORT"}, true);
          showToast("ABORT 요청을 보드에 전송했습니다. 안전 확인 후 재시도하세요. "+safetyLineSuffix(),"error");
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
            showToast("보드와 연결 후 설비 점검을 실행하세요.", "warn");
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
            showToast("설비 점검을 먼저 완료하세요. 제어 권한이 필요합니다.", "warn");
            return;
          }
          hideForceConfirm();
          sendCommand({http:"/force_ignite", ser:"FORCE"}, true);
          showToast("강제 점화 요청을 보드에 전송했습니다. 절대 접근하지 마세요. "+safetyLineSuffix(),"ignite");
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
          addLogLine("LOCKOUT modal acknowledged ("+name+"). Restart required.", "SAFE");
          showToast("LOCKOUT("+name+") 확인 처리(로그 기록). 보드를 재시작하세요.", "error", {duration:7000});
        });
      }

      if(el.copyLogBtn){
        el.copyLogBtn.addEventListener("click",()=>{
          const text=logLines.join("\n");
          if(navigator.clipboard && window.isSecureContext){
            navigator.clipboard.writeText(text).then(()=>{
              addLogLine("Log copied to clipboard.","INFO");
              showToast("로그가 클립보드에 복사되었습니다.","success");
            }).catch(()=>{
              addLogLine("Clipboard copy failed.","ERROR");
              showToast("클립보드 복사에 실패했습니다. 브라우저 권한을 확인하세요.","error");
            });
          }else{
            try{
              const ta=document.createElement("textarea");
              ta.value=text; ta.style.position="fixed"; ta.style.top="-9999px";
              document.body.appendChild(ta);
              ta.focus(); ta.select();
              document.execCommand("copy");
              document.body.removeChild(ta);
              addLogLine("Log copied to clipboard.","INFO");
              showToast("로그가 클립보드에 복사되었습니다.","success");
            }catch(e){
              addLogLine("Copy failed: "+e,"ERROR");
              showToast("복사에 실패했습니다. 브라우저 정책을 확인하세요.","error");
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
          const filename = "ALTIS_FLASH_DAQ_" + fnameSuffix + "_data.csv";

          const hasIgnitionWindow =
            ignitionAnalysis.hasData &&
            ignitionAnalysis.ignStartMs!=null &&
            ignitionAnalysis.thresholdMs!=null &&
            ignitionAnalysis.lastAboveMs!=null;

          const windowStartMs = hasIgnitionWindow ? (ignitionAnalysis.thresholdMs - IGN_PRE_WINDOW_MS) : null;
          const windowEndMs   = hasIgnitionWindow ? (ignitionAnalysis.lastAboveMs + IGN_POST_WINDOW_MS) : null;

          const delayVal = (ignitionAnalysis.delaySec!=null) ? ignitionAnalysis.delaySec.toFixed(3) : "";
          const durVal   = (ignitionAnalysis.durationSec!=null) ? ignitionAnalysis.durationSec.toFixed(3) : "";

          let csv = "";
          csv += [
            "type",
            "time_iso",
            "tag",
            "message",
            "thrust_kgf",
            "pressure_v",
            "loop_ms",
            "hx_hz",
            "cpu_us",
            "switch",
            "ign_ok",
            "relay",
            "igs_mode",
            "state",
            "cd_ms",
            "rel_time_s",
            "is_ignition_window",
            "ignition_delay_s",
            "effective_burn_s",
            "threshold_kgf"
          ].join(",") + "\n";

          csv += [
            "IGN_SUMMARY",
            escapeCsvField(now.toISOString()),
            "",
            escapeCsvField(hasIgnitionWindow ? "Ignition window detected" : "No ignition window"),
            "", "", "", "", "", "", "", "", "", "", "",
            "",
            hasIgnitionWindow ? "1" : "0",
            delayVal,
            durVal,
            IGN_THRUST_THRESHOLD.toFixed(3)
          ].join(",") + "\n";

          for(const e of eventLog){
            csv += [
              "EVENT",
              escapeCsvField(e.time),
              escapeCsvField(e.tag || ""),
              escapeCsvField(e.message || ""),
              "", "", "", "", "", "", "", "", "", "", "",
              "",
              "0",
              "", "", ""
            ].join(",") + "\n";
          }

          const t0ms = (logData && logData.length) ? Date.parse(logData[0].time) : null;

          for(const row of logData){
            const ms = Date.parse(row.time);
            const rel = (t0ms!=null && isFinite(ms)) ? ((ms - t0ms)/1000).toFixed(3) : "";
            const inWin = (hasIgnitionWindow && isFinite(ms) && ms>=windowStartMs && ms<=windowEndMs) ? 1 : 0;

            csv += [
              "RAW",
              escapeCsvField(row.time),
              "",
              "",
              Number(row.t).toFixed(3),
              Number(row.p).toFixed(3),
              (row.lt ?? ""),
              (row.hz ?? ""),
              (row.ct ?? ""),
              (row.s  ?? 0),
              (row.ic ?? 0),
              (row.r  ?? 0),
              (row.gs ?? 0),
              (row.st ?? 0),
              (row.cd ?? 0),
              rel,
              String(inWin),
              "", "", ""
            ].join(",") + "\n";
          }

          downloadTextAsFile(csv, filename);

          addLogLine("CSV exported (single file): " + filename, "INFO");
          showToast("CSV를 1개 파일로 내보냈습니다. (IGN_SUMMARY + EVENT + RAW)", "success");
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
            showToast("추력 단위가 "+before.thrustUnit+" → "+uiSettings.thrustUnit+" 로 변경되었습니다. 표시 단위만 변경됩니다. "+safetyLineSuffix(),"info");
          }
          if(before.ignDurationSec!==uiSettings.ignDurationSec){
            showToast("점화 시간이 "+before.ignDurationSec+"s → "+uiSettings.ignDurationSec+"s 로 변경되었습니다. 과열/인가 시간에 주의하세요. "+safetyLineSuffix(),"warn");
          }
          if(before.countdownSec!==uiSettings.countdownSec){
            showToast("카운트다운 시간이 "+before.countdownSec+"s → "+uiSettings.countdownSec+"s 로 변경되었습니다. 인원 통제 시간을 충분히 두세요. "+safetyLineSuffix(),"warn");
          }

          addLogLine("Settings updated: thrustUnit="+uiSettings.thrustUnit+", ignDuration="+ignSec+"s, countdown="+cdSec+"s", "CFG");
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

      updateData().finally(()=>{ pollLoop(); });
      updateSerialPill();

      // ✅ KST 실시간 업데이트
      updateKstClock();
      setInterval(updateKstClock, 1000);
    });
