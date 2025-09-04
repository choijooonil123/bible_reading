/* 말씀읽기APP — Email/Password 로그인 + bible.json + 음성인식(v3, 버튼전용ON/OFF)
   - 자동이동 시 SR 건드리지 않음, 마이크 ON 동안 모드/튜닝 변경 금지
   - 가중 접두 정렬(밴디드 DP) + 옵션화(SUB_NEAR/SUB_DIST/DEL_COST/INS_COST) + 튜닝 패널
*/
(() => {
  // ---------- PWA ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" })
        .then(reg => console.log("[SW] registered:", reg.scope))
        .catch(err => console.warn("[SW] register failed:", err));
    });
  }

  // ---------- Firebase ----------
  let auth, db, user;
  function initFirebase() {
    if (!window.firebaseConfig || typeof firebase === "undefined") {
      console.error("[Firebase] SDK/config 누락");
      alert("Firebase 설정이 로드되지 않았습니다. firebaseConfig.js를 확인하세요.");
      return;
    }
    firebase.initializeApp(window.firebaseConfig);
    auth = firebase.auth();
    db   = firebase.firestore();
    console.log("[Firebase] 초기화 OK");
  }
  initFirebase();

  // ---------- Screens ----------
  const scrLogin = document.getElementById("screen-login");
  const scrApp   = document.getElementById("screen-app");
  function showScreen(name) {
    if (name === "login") { scrLogin?.classList.add("show"); scrApp?.classList.remove("show"); }
    else { scrApp?.classList.add("show"); scrLogin?.classList.remove("show"); }
  }

  // ---------- DOM ----------
  const els = {
    // 로그인 폼
    email: document.getElementById("email"),
    password: document.getElementById("password"),
    displayName: document.getElementById("displayName"),
    nickname: document.getElementById("nickname"),
    btnLogin: document.getElementById("btnLogin"),
    btnSignup: document.getElementById("btnSignup"),

    // 상단(앱)
    signedIn: document.getElementById("signedIn"),
    userName: document.getElementById("userName"),
    userPhoto: document.getElementById("userPhoto"),
    btnSignOut: document.getElementById("btnSignOut"),

    // 선택/리더
    bookSelect: document.getElementById("bookSelect"),
    chapterGrid: document.getElementById("chapterGrid"),
    verseGrid: document.getElementById("verseGrid"),
    verseText: document.getElementById("verseText"),
    locLabel: document.getElementById("locLabel"),
    verseCount: document.getElementById("verseCount"),
    myStats: document.getElementById("myStats"),

    // 리더보드
    leaderList: document.getElementById("leaderList"),

    // 현황표
    matrixModal: document.getElementById("matrixModal"),
    matrixWrap: document.getElementById("matrixWrap"),
    btnCloseMatrix: document.getElementById("btnCloseMatrix"),
    btnOpenMatrix: document.getElementById("btnOpenMatrix"),

    // FABs
    btnPrevVerse: document.getElementById("btnPrevVerse"),
    btnNextVerse: document.getElementById("btnNextVerse"),
    btnToggleMic: document.getElementById("btnToggleMic"),
    listenHint: document.getElementById("listenHint"),
    autoAdvance: document.getElementById("autoAdvance"),

    // (선택) 모드 라디오
    modeRadios: Array.from(document.querySelectorAll("input[name=recogMode]")),

    // (선택) 마이크 레벨 UI
    micBar: document.getElementById("micBar"),
    micDb: document.getElementById("micDb"),
  };

  // ---------- State ----------
  const BOOKS = window.BOOKS || [];
  const getBookByKo = (ko) => BOOKS.find(b => b.ko === ko);
  const state = {
    bible: null, currentBookKo: null, currentChapter: null,
    verses: [], currentVerseIdx: 0, listening:false, recog:null,
    progress:{}, myStats:{versesRead:0,chaptersRead:0,last:{bookKo:null,chapter:null,verse:0}},
  };

  // ---------- bible.json ----------
  async function loadBible() {
    try {
      const res = await fetch("./bible.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("bible.json not found");
      state.bible = await res.json();
    } catch (e) {
      console.error("[bible.json] 로딩 실패:", e);
      els.verseText && (els.verseText.textContent = "루트에 bible.json 파일이 필요합니다.");
    }
  }
  loadBible();

  // ---------- Auth UX ----------
  function mapAuthError(e) {
    const code = e?.code || "";
    if (code.includes("invalid-email")) return "이메일 형식이 올바르지 않습니다.";
    if (code.includes("email-already-in-use")) return "이미 가입된 이메일입니다. 로그인하세요.";
    if (code.includes("weak-password")) return "비밀번호를 6자 이상으로 입력하세요.";
    if (code.includes("operation-not-allowed")) return "이메일/비밀번호 로그인이 비활성화되어 있습니다. 콘솔에서 활성화해주세요.";
    if (code.includes("network-request-failed")) return "네트워크 오류가 발생했습니다. 인터넷 연결을 확인하세요.";
    return e?.message || "알 수 없는 오류가 발생했습니다.";
  }
  async function safeEnsureUserDoc(u, opts={}) {
    try { await ensureUserDoc(u, opts); } catch (e){ console.warn("[ensureUserDoc] 실패:", e); }
  }
  let busy=false;
  async function withBusy(btn, fn){
    if(busy) return;
    busy=true;
    const orig = btn?.textContent;
    if(btn){ btn.disabled=true; btn.textContent="처리 중…"; }
    try{ await fn(); } finally { busy=false; if(btn){ btn.disabled=false; btn.textContent=orig; } }
  }

  // ---------- 회원가입 / 로그인 / 로그아웃 ----------
  els.btnSignup?.addEventListener("click", (e) => withBusy(els.btnSignup, async () => {
    e?.preventDefault(); e?.stopPropagation();
    const email = (els.email.value || "").trim();
    const pw    = (els.password.value || "").trim();
    const name  = (els.displayName.value || "").trim();
    const nick  = (els.nickname?.value || "").trim();
    if (!email || !pw) { alert("이메일/비밀번호를 입력하세요."); return; }

    try {
      const cred = await auth.createUserWithEmailAndPassword(email, pw);
      user = cred.user;
      if (name) { await user.updateProfile({ displayName: name }); }
      await safeEnsureUserDoc(user, { nickname: nick });
    } catch (e) {
      console.error(e);
      alert("회원가입 실패: " + mapAuthError(e));
    }
  }));

  els.btnLogin?.addEventListener("click", (e) => withBusy(els.btnLogin, async () => {
    e?.preventDefault(); e?.stopPropagation();
    const email = (els.email.value || "").trim();
    const pw    = (els.password.value || "").trim();
    const name  = (els.displayName.value || "").trim();
    const nick  = (els.nickname?.value || "").trim();
    if (!email || !pw) { alert("이메일/비밀번호를 입력하세요."); return; }

    try {
      const cred = await auth.signInWithEmailAndPassword(email, pw);
      user = cred.user;
      if (name) { await user.updateProfile({ displayName: name }); }
      await safeEnsureUserDoc(user, { nickname: nick });
    } catch (e) {
      console.error(e);
      alert("로그인 실패: " + mapAuthError(e));
    }
  }));

  els.btnSignOut?.addEventListener("click", () => auth?.signOut());

  auth?.onAuthStateChanged(async (u) => {
    user = u;
    if (!u) { showScreen("login"); clearAppUI(); return; }

    showScreen("app");
    els.signedIn?.classList.remove("hidden");
    els.userName && (els.userName.textContent = u.displayName || u.email || "사용자");
    els.userPhoto && (els.userPhoto.src = u.photoURL || "https://avatars.githubusercontent.com/u/9919?s=200&v=4");

    try { await ensureUserDoc(u); } catch (e) {}
    try { await loadMyStats(); } catch (e) {}
    try { buildBookSelect(); } catch (e) {}
    try { loadLeaderboard(); } catch (e) {}
  });

  // ---------- Firestore helpers ----------
  async function ensureUserDoc(u, opts={}) {
    if (!db || !u) return;
    const data = {
      email: u.email || "",
      versesRead: firebase.firestore.FieldValue.increment(0),
      chaptersRead: firebase.firestore.FieldValue.increment(0),
      last: state.myStats.last || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (opts.nickname && opts.nickname.trim()) data.nickname = opts.nickname.trim();
    await db.collection("users").doc(u.uid).set(data, { merge: true });
  }

  async function loadMyStats() {
    if (!db || !user) return;
    try {
      const snap = await db.collection("users").doc(user.uid).get();
      if (snap.exists) {
        const d = snap.data();
        state.myStats.versesRead = d.versesRead || 0;
        state.myStats.chaptersRead = d.chaptersRead || 0;
        state.myStats.last = d.last || { bookKo: null, chapter: null, verse: 0 };
        els.myStats && (els.myStats.textContent =
          `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
      }
    } catch (e) {}

    const p = {};
    try {
      const qs = await db.collection("users").doc(user.uid).collection("progress").get();
      qs.forEach(doc => { p[doc.id] = { readChapters: new Set((doc.data().readChapters) || []) }; });
    } catch (e) {}
    state.progress = p;
  }

  async function saveLastPosition() {
    if (!db || !user) return;
    try {
      await db.collection("users").doc(user.uid).set({
        last: state.myStats.last,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {}
  }

  async function markChapterDone(bookId, chapter) {
    if (!state.progress[bookId]) state.progress[bookId] = { readChapters: new Set() };
    state.progress[bookId].readChapters.add(chapter);
    if (db && user) {
      try {
        await db.collection("users").doc(user.uid).collection("progress").doc(bookId)
          .set({ readChapters: Array.from(state.progress[bookId].readChapters) }, { merge: true });
        await db.collection("users").doc(user.uid)
          .set({ chaptersRead: firebase.firestore.FieldValue.increment(1),
                 updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        state.myStats.chaptersRead += 1;
        els.myStats && (els.myStats.textContent =
          `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
        buildChapterGrid();
        buildMatrix();
      } catch (e) {}
    }
  }

  async function incVersesRead(n = 1) {
    state.myStats.versesRead += n;
    els.myStats && (els.myStats.textContent =
      `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
    if (db && user) {
      try {
        await db.collection("users").doc(user.uid)
          .set({
            versesRead: firebase.firestore.FieldValue.increment(n),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
      } catch (e) {}
    }
  }

  // ---------- Book / Chapter / Verse ----------
  function clearAppUI() {
    els.bookSelect && (els.bookSelect.innerHTML = "");
    els.chapterGrid && (els.chapterGrid.innerHTML = "");
    els.verseGrid && (els.verseGrid.innerHTML = "");
    els.verseText && (els.verseText.textContent = "로그인 후 시작하세요.");
    els.leaderList && (els.leaderList.innerHTML = "");
    els.myStats && (els.myStats.textContent = "—");
    els.locLabel && (els.locLabel.textContent = "");
    els.verseCount && (els.verseCount.textContent = "");
    state.currentBookKo = null; state.currentChapter = null; state.verses = []; state.currentVerseIdx = 0;
  }

  function buildBookSelect() {
    if (!els.bookSelect) return;
    els.bookSelect.innerHTML = "";
    for (const b of BOOKS) {
      const opt = document.createElement("option");
      opt.value = b.ko; opt.textContent = b.ko;
      els.bookSelect.appendChild(opt);
    }
    const last = state.myStats?.last;
    if (last?.bookKo) {
      els.bookSelect.value = last.bookKo; state.currentBookKo = last.bookKo; buildChapterGrid();
      if (last.chapter) {
        selectChapter(last.chapter).then(() => {
          if (Number.isInteger(last.verse)) {
            state.currentVerseIdx = Math.max(0, (last.verse || 1) - 1); updateVerseText();
          }
        });
      }
    } else {
      els.bookSelect.value = BOOKS[0]?.ko || "";
      state.currentBookKo = els.bookSelect.value;
      buildChapterGrid();
    }
  }

  els.bookSelect?.addEventListener("change", () => {
    state.currentBookKo = els.bookSelect.value;
    state.currentChapter = null; state.verses = []; state.currentVerseIdx = 0;
    els.verseGrid && (els.verseGrid.innerHTML = ""); els.verseText && (els.verseText.textContent = "장과 절을 선택하세요.");
    buildChapterGrid();
    state.myStats.last = { bookKo: state.currentBookKo, chapter: null, verse: 0 }; saveLastPosition();
  });

  function buildChapterGrid() {
    const b = getBookByKo(state.currentBookKo);
    if (!b || !els.chapterGrid) return;
    els.chapterGrid.innerHTML = "";
    for (let i = 1; i <= b.ch; i++) {
      const btn = document.createElement("button");
      btn.className = "chip" + (state.progress[b.id]?.readChapters?.has(i) ? " done" : "");
      btn.textContent = i;
      btn.addEventListener("click", () => selectChapter(i));
      if (state.currentChapter === i) btn.classList.add("active");
      els.chapterGrid.appendChild(btn);
    }
  }

  function buildVerseGrid() {
    if (!els.verseGrid) return;
    els.verseGrid.innerHTML = "";
    for (let i = 1; i <= state.verses.length; i++) {
      const btn = document.createElement("button");
      btn.className = "chip"; btn.textContent = i;
      btn.addEventListener("click", () => {
        state.currentVerseIdx = i - 1; updateVerseText();
        state.myStats.last.verse = i; saveLastPosition();
      });
      if (state.currentVerseIdx === i - 1) btn.classList.add("active");
      els.verseGrid.appendChild(btn);
    }
  }

  async function selectChapter(chapter) {
    state.currentChapter = chapter; state.currentVerseIdx = 0;
    const b = getBookByKo(state.currentBookKo);
    els.locLabel && (els.locLabel.textContent = `${b?.ko || ""} ${chapter}장`);
    els.verseText && (els.verseText.textContent = "로딩 중…");

    if (!state.bible) { await loadBible(); if (!state.bible) { els.verseText && (els.verseText.textContent = "bible.json 로딩 실패"); return; } }
    const chObj = state.bible?.[state.currentBookKo]?.[String(chapter)];
    if (!chObj) {
      els.verseText && (els.verseText.textContent = `${b.ko} ${chapter}장 본문 없음`);
      els.verseCount && (els.verseCount.textContent = ""); els.verseGrid && (els.verseGrid.innerHTML = ""); return;
    }
    const entries = Object.entries(chObj).map(([k,v])=>[parseInt(k,10), String(v)]).sort((a,b)=>a[0]-b[0]);
    state.verses = entries.map(e=>e[1]);

    els.verseCount && (els.verseCount.textContent = `(${state.verses.length}절)`);
    buildVerseGrid();
    updateVerseText();
    state.myStats.last = { bookKo: b.ko, chapter, verse: 1 }; saveLastPosition();
  }

  // ---------- 표시 업데이트 ----------
  let paintedPrefix = 0;
  function updateVerseText() {
    const v = state.verses[state.currentVerseIdx] || "";
    paintedPrefix = 0;
    els.locLabel && (els.locLabel.textContent =
      `${state.currentBookKo} ${state.currentChapter}장 ${state.currentVerseIdx + 1}절`);
    if (els.verseText) {
      els.verseText.innerHTML = "";
      for (let i = 0; i < v.length; i++) { const s=document.createElement("span"); s.textContent=v[i]; els.verseText.appendChild(s); }
    }
    els.verseCount && (els.verseCount.textContent =
      `(${state.verses.length}절 중 ${state.currentVerseIdx + 1}절)`);
    if (els.verseGrid) { [...els.verseGrid.children].forEach((btn, idx) =>
      btn.classList.toggle("active", idx===state.currentVerseIdx)); }
  }

  function paintRead(prefixLen){
    if (!els.verseText) return;
    const spans = els.verseText.childNodes;
    for (let i=0;i<spans.length;i++){
      spans[i].classList?.toggle("read", i<prefixLen);
    }
  }

  // ---------- Speech Recognition ----------
  const getRecognition = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = 'ko-KR';
    r.continuous = true;
    r.interimResults = true;
    try { r.maxAlternatives = 3; } catch(_) {}
    return r;
  };

  // 환경 가드
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const isStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true;
  const isSecure = location.protocol === 'https:' || location.hostname === 'localhost';
  function supportsSR(){ return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  function envGuardBeforeStart() {
    if (!supportsSR()) { alert("이 브라우저는 음성인식을 지원하지 않습니다."); return false; }
    if (!isSecure) { alert("음성인식은 HTTPS에서만 동작합니다."); return false; }
    if (isIOS && isStandalone) { alert("iOS 홈화면(PWA)에서는 음성인식이 동작하지 않습니다. Safari 앱에서 열어주세요."); return false; }
    return true;
  }
  let micPrimed=false;
  async function primeMicOnce(){
    if (micPrimed) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true, sampleRate:{ideal:48000} }
    });
    stream.getTracks().forEach(t=>t.stop());
    micPrimed=true;
  }

  // ---- 프로파일(모드) & 비용옵션
  const RECOG_PROFILES = {
    fast: {
      shortLen:30, mediumLen:60,
      minRatioShort:0.94, minRatioMedium:0.92, minRatioLong:0.90,
      holdMs:400, cooldownMs:600, postAdvanceDelayMs:300,
      SUB_NEAR:0.35, SUB_DIST:1.0, DEL_COST:0.55, INS_COST:0.55
    },
    normal: {
      shortLen:30, mediumLen:60,
      minRatioShort:0.90, minRatioMedium:0.88, minRatioLong:0.84,
      holdMs:480, cooldownMs:650, postAdvanceDelayMs:400,
      SUB_NEAR:0.35, SUB_DIST:1.0, DEL_COST:0.55, INS_COST:0.55
    },
    lenient: {
      shortLen:30, mediumLen:60,
      minRatioShort:0.84, minRatioMedium:0.82, minRatioLong:0.76,
      holdMs:520, cooldownMs:700, postAdvanceDelayMs:500,
      SUB_NEAR:0.28, SUB_DIST:0.85, DEL_COST:0.45, INS_COST:0.45
    }
  };
  let currentMode = (document.querySelector("input[name=recogMode]:checked")?.value) || "normal";
  let MATCH_PROFILE = RECOG_PROFILES[currentMode];
  const FINAL_GRACE_MS = 1200;

  function applyModeFromUI() {
    currentMode = document.querySelector("input[name=recogMode]:checked")?.value || currentMode;
    MATCH_PROFILE = RECOG_PROFILES[currentMode] || RECOG_PROFILES.normal;
    console.log("[RecogMode] 변경:", currentMode, MATCH_PROFILE);
  }
  function setModeRadiosDisabled(disabled){
    (els.modeRadios||[]).forEach(r => r.disabled = disabled);
  }
  (els.modeRadios||[]).forEach(radio=>{
    radio.addEventListener("change", ()=>{
      if (state.listening) {
        (els.modeRadios||[]).forEach(r => { r.checked = (r.value === currentMode); });
        alert("마이크가 켜져있는 동안에는 음성모드를 바꿀 수 없습니다.");
        return;
      }
      applyModeFromUI();
      if (window.__renderTuningPlaceholders) window.__renderTuningPlaceholders(); // 튜닝 패널 placeholder 갱신
    });
  });

  // ---- 한글 자모 유틸
  const CHO = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  const JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
  const JONG = ["","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  const S_BASE=0xAC00, L_COUNT=19, V_COUNT=21, T_COUNT=28, N_COUNT=V_COUNT*T_COUNT, S_COUNT=L_COUNT*N_COUNT;
  function decomposeJamo(s){
    const out=[];
    for (const ch of (s||"")){
      const code = ch.codePointAt(0);
      const sIndex = code - S_BASE;
      if (sIndex>=0 && sIndex<S_COUNT){
        const L = Math.floor(sIndex/N_COUNT);
        const V = Math.floor((sIndex%N_COUNT)/T_COUNT);
        const T = sIndex%T_COUNT;
        out.push(CHO[L], JUNG[V]);
        if (T) out.push(JONG[T]);
      } else out.push(ch);
    }
    return out.join("");
  }
  const NUM_KO = {"영":0,"공":0,"하나":1,"한":1,"둘":2,"두":2,"셋":3,"세":3,"넷":4,"네":4,"다섯":5,"여섯":6,"일곱":7,"여덟":8,"아홉":9,"열":10};
  function normalizeKoreanNumbers(s){
    return s
      .replace(/(열|한\s*십|일\s*십)/g,"십")
      .replace(/(한|일)\s*십/g,"십")
      .replace(/(둘|이)\s*십/g,"이십")
      .replace(/(셋|삼)\s*십/g,"삼십")
      .replace(/(넷|사)\s*십/g,"사십")
      .replace(/(다섯|오)\s*십/g,"오십")
      .replace(/(여섯|육)\s*십/g,"육십")
      .replace(/(일곱|칠)\s*십/g,"칠십")
      .replace(/(여덟|팔)\s*십/g,"팔십")
      .replace(/(아홉|구)\s*십/g,"구십")
      .replace(/십\s*(한|일)/g,"11").replace(/십\s*(둘|이)/g,"12")
      .replace(/십\s*(셋|삼)/g,"13").replace(/십\s*(넷|사)/g,"14")
      .replace(/십\s*(다섯|오)/g,"15").replace(/십\s*(여섯|육)/g,"16")
      .replace(/십\s*(일곱|칠)/g,"17").replace(/십\s*(여덟|팔)/g,"18")
      .replace(/십\s*(아홉|구)/g,"19")
      .replace(/^\s*십\s*$/g,"10")
      .replace(/(이|둘)\s*십\s*(\d{1})?/g,(_,__,y)=>"2"+(y?y:"0"))
      .replace(/(삼|셋)\s*십\s*(\d{1})?/g,(_,__,y)=>"3"+(y?y:"0"))
      .replace(/(사|넷)\s*십\s*(\d{1})?/g,(_,__,y)=>"4"+(y?y:"0"))
      .replace(/(오|다섯)\s*십\s*(\d{1})?/g,(_,__,y)=>"5"+(y?y:"0"))
      .replace(/(육|여섯)\s*십\s*(\d{1})?/g,(_,__,y)=>"6"+(y?y:"0"))
      .replace(/(칠|일곱)\s*십\s*(\d{1})?/g,(_,__,y)=>"7"+(y?y:"0"))
      .replace(/(팔|여덟)\s*십\s*(\d{1})?/g,(_,__,y)=>"8"+(y?y:"0"))
      .replace(/(구|아홉)\s*십\s*(\d{1})?/g,(_,__,y)=>"9"+(y?y:"0"))
      .replace(/\b(영|공|하나|한|둘|두|셋|세|넷|네|다섯|여섯|일곱|여덟|아홉|열)\b/g,(m)=>String(NUM_KO[m] ?? m));
  }
  const USE_STOPWORD_STRIP = false;
  const USE_PRONUN_HEUR   = true;
  const STOPWORDS = /(\b|)(은|는|이|가|을|를|에|에서|으로|와|과|도|만|까지|부터|로서|보다|에게|께|마다|처럼|뿐|이라|거나|하며|하고)(\b|)/g;
  const pronunciationHeuristics = s => s.replace(/의/g,"에");
  function normalizeToJamo(s, forSpoken=false){
    let t = (s||"").normalize("NFKC").replace(/[“”‘’"'\u200B-\u200D`´^~]/g,"").toLowerCase();
    t = normalizeKoreanNumbers(t);
    if (USE_STOPWORD_STRIP) t = t.replace(STOPWORDS," ");
    if (forSpoken && USE_PRONUN_HEUR) t = pronunciationHeuristics(t);
    t = t.replace(/[^\p{L}\p{N} ]/gu," ").replace(/\s+/g," ").trim();
    t = decomposeJamo(t).replace(/\s+/g,"");
    return t;
  }

  // ---- 알고리즘: (1) 관대한 접두 정렬(옵션 지원)
  function softPrefixProgress(targetJamo, spokenJamo, opts={}) {
    if (!targetJamo || !spokenJamo) return { chars:0, ratio:0 };

    const SUB_NEAR = opts.SUB_NEAR ?? 0.35;
    const SUB_DIST = opts.SUB_DIST ?? 1.0;
    const DEL_COST = opts.DEL_COST ?? 0.55;
    const INS_COST = opts.INS_COST ?? 0.55;

    const equivPairs = [
      ["ㅐ","ㅔ"], ["ㅚ","ㅙ"], ["ㅚ","ㅞ"], ["ㅙ","ㅞ"], ["ㅢ","ㅣ"],
      ["ㅓ","ㅗ"], ["ㅕ","ㅛ"], ["ㅠ","ㅡ"],
      ["ㄴ","ㅇ"], ["ㅂ","ㅍ"], ["ㅂ","ㅁ"], ["ㄷ","ㅌ"], ["ㅅ","ㅆ"],
      ["ㅎ",""], ["","ㅎ"]
    ];
    const NEAR = new Map();
    for (const [a,b] of equivPairs) { NEAR.set(`${a},${b}`,1); NEAR.set(`${b},${a}`,1); }
    const near = (a,b) => a===b || NEAR.has(`${a},${b}`);
    const subCost = (a,b) => (a===b ? 0 : (near(a,b) ? SUB_NEAR : SUB_DIST));

    const T = targetJamo, S = spokenJamo;
    const n = T.length,  m = S.length;

    const BAND = Math.min(10, Math.max(6, Math.floor(Math.max(n,m)/10)));

    let prev = new Float32Array(m+1);
    let curr = new Float32Array(m+1);
    for (let j=0;j<=m;j++) prev[j] = j*INS_COST;

    let bestI = 0, bestScore = -Infinity;

    for (let i=1;i<=n;i++){
      const jStart = Math.max(1, i-BAND);
      const jEnd   = Math.min(m, i+BAND);

      curr[0] = i*DEL_COST;
      for (let j=1;j<=m;j++){
        if (j<jStart || j>jEnd) { curr[j] = 1e9; continue; }
        const costSub = prev[j-1] + subCost(T[i-1], S[j-1]);
        const costDel = prev[j]   + DEL_COST;
        const costIns = curr[j-1] + INS_COST;
        curr[j] = Math.min(costSub, costDel, costIns);
      }

      let rowMin = Infinity;
      for (let j=jStart;j<=jEnd;j++) rowMin = Math.min(rowMin, curr[j]);

      const score = i - rowMin*0.6;
      if (score > bestScore){ bestScore = score; bestI = i; }

      const tmp = prev; prev = curr; curr = tmp;
    }

    const matched = Math.max(0, Math.min(n, bestI));
    const ratio = n ? matched / n : 0;
    return { chars: matched, ratio };
  }

  // (2) 엄격 접두(표시 단계: 앞서가지 않게)
  function matchedPrefixLenContiguous(targetJamo, spokenJamo){
    if (!targetJamo || !spokenJamo) return 0;
    let best=0;
    const maxShift = Math.min(5, Math.max(0, spokenJamo.length-1));
    for (let shift=0; shift<=maxShift; shift++){
      let ti=0, si=shift, cur=0;
      while (ti<targetJamo.length && si<spokenJamo.length){
        if (targetJamo[ti] !== spokenJamo[si]) break;
        cur++; ti++; si++;
      }
      if (cur>best) best=cur;
      if (best>=targetJamo.length) break;
    }
    return best;
  }

  // 안정/완료 판정 상태
  let stableSince = 0, lastCompleteTs = 0, lastPrefix = 0;
  let ignoreUntilTs = 0;

  function bestTranscripts(evt){
    const cand=[];
    for (let i=0;i<evt.results.length;i++){
      const res=evt.results[i];
      const maxAlt=Math.min(res.length,3);
      for (let a=0;a<maxAlt;a++) cand.push(res[a].transcript);
    }
    cand.sort((a,b)=>b.length-a.length);
    return cand.slice(0,3);
  }

  function onSpeechResult(evt){
    const v = state.verses[state.currentVerseIdx] || "";
    if (!v) return;

    const nowTs = Date.now();
    if (nowTs < ignoreUntilTs) return;

    const targetJ = normalizeToJamo(v, false);
    const L = targetJ.length;
    const minRatio =
      (L <= MATCH_PROFILE.shortLen)  ? MATCH_PROFILE.minRatioShort  :
      (L <= MATCH_PROFILE.mediumLen) ? MATCH_PROFILE.minRatioMedium :
                                       MATCH_PROFILE.minRatioLong;

    let best = { chars:0, ratio:0 };
    let strictMax = 0;
    for (const tr of bestTranscripts(evt)){
      const spokenJ = normalizeToJamo(tr, true);
      const tuned = getTunedOptsWithProfile(MATCH_PROFILE);
      const curSoft   = softPrefixProgress(targetJ, spokenJ, tuned);
      const curStrict = matchedPrefixLenContiguous(targetJ, spokenJ);
      if (curSoft.chars > best.chars) best = curSoft;
      if (curStrict > strictMax) strictMax = curStrict;
    }

    // 화면 채움은 "엄격" 결과를 기준으로 한 스텝씩만 전진
    const stepLimited = Math.min(strictMax, paintedPrefix + 2);
    const paintLen = Math.min(stepLimited, L);
    paintRead(paintLen);
    paintedPrefix = paintLen;

    const ratio = best.ratio;
    const now = Date.now();
    if (best.chars > lastPrefix){ stableSince = now; lastPrefix = best.chars; }

    const holdOk = (now - stableSince) >= MATCH_PROFILE.holdMs;
    const coolOk = (now - lastCompleteTs) >= MATCH_PROFILE.cooldownMs;
    const isFinal = evt.results[evt.results.length - 1]?.isFinal;
    const longHoldOk = (now - stableSince) >= Math.max(MATCH_PROFILE.holdMs, FINAL_GRACE_MS);

    const finalOk  = isFinal && ratio >= minRatio && coolOk;
    const stableOk = ratio >= minRatio && holdOk && coolOk;
    const graceOk  = ratio >= minRatio && longHoldOk && coolOk;
    if (finalOk || stableOk || graceOk){
      lastCompleteTs = now;
      completeVerseWithProfile();
    }
  }

  // ---------- 자동이동(마이크 건드리지 않음) ----------
  async function advanceToNextVerse() {
    if (state.currentVerseIdx < state.verses.length - 1) {
      state.currentVerseIdx++;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      return true;
    }
    return false;
  }

  async function completeVerseWithProfile(){
    await incVersesRead(1);
    const auto = els.autoAdvance ? !!els.autoAdvance.checked : true;
    const b = getBookByKo(state.currentBookKo);
    await new Promise(r => setTimeout(r, MATCH_PROFILE.postAdvanceDelayMs));

    if (auto) {
      const moved = await advanceToNextVerse();
      if (!moved) {
        await markChapterDone(b.id, state.currentChapter);
        state.myStats.last.verse = 0;
        state.myStats.last.chapter = state.currentChapter;
        saveLastPosition();
        alert("장 완료! 다음 장으로 이동하세요.");
        return;
      }
      // 마이크는 그대로 두고, 잔여 입력만 잠시 무시
      stableSince = 0; lastPrefix = 0; paintedPrefix = 0;
      ignoreUntilTs = Date.now() + 400;
    }
  }

  // ---------- Mic control: 버튼으로만 ON/OFF ----------
  async function startListening(showAlert=true){
    if (!envGuardBeforeStart()) return;
    if (state.listening) return;

    state.recog = getRecognition();
    if (!state.recog){
      els.listenHint && (els.listenHint.innerHTML="⚠️ 음성인식 미지원(Chrome/Safari 권장)");
      if (showAlert) alert("이 브라우저는 음성인식을 지원하지 않습니다.");
      return;
    }

    // 모드/튜닝 패널 잠금
    setModeRadiosDisabled(true);
    setTuningDisabled(true);

    stableSince=0; lastPrefix=0;

    state.recog.onresult = onSpeechResult;

    // 자동 재시작 없음: onend는 UI만 반영
    state.recog.onend = () => {
      state.listening = false;
      els.btnToggleMic && (els.btnToggleMic.textContent="🎙️");
      stopMicLevel();
      setModeRadiosDisabled(false);
      setTuningDisabled(false);
      console.log("[SR] ended");
    };

    state.recog.onerror = (e) => {
      console.warn("[SR] error:", e?.error, e);
      // 자동제어 없음
    };

    try {
      await primeMicOnce();
      state.recog.start();
      state.listening = true;
      els.btnToggleMic && (els.btnToggleMic.textContent="⏹️");
      startMicLevel();
    } catch(e){
      alert("음성인식 시작 실패: " + e.message);
      setModeRadiosDisabled(false);
      setTuningDisabled(false);
    }
  }

  function stopListening(resetBtn=true){
    if (state.recog){
      try{ state.recog.onresult=null; state.recog.onend=null; state.recog.onerror=null; state.recog.abort?.(); }catch(_){}
      try{ state.recog.stop?.(); }catch(_){}
    }
    state.listening=false;
    if (resetBtn && els.btnToggleMic) els.btnToggleMic.textContent="🎙️";
    stopMicLevel();
    setModeRadiosDisabled(false);
    setTuningDisabled(false);
  }

  els.btnToggleMic?.addEventListener("click", ()=>{ if(!state.listening) startListening(); else stopListening(); });

  // 앞/뒤 절 버튼: 마이크 절대 건드리지 않음
  els.btnNextVerse?.addEventListener("click", ()=>{
    if(!state.verses.length) return;
    if(state.currentVerseIdx<state.verses.length-1){
      state.currentVerseIdx++;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      stableSince=0; lastPrefix=0; paintedPrefix=0;
      ignoreUntilTs = Date.now() + 300;
    }
  });
  els.btnPrevVerse?.addEventListener("click", ()=>{
    if(!state.verses.length) return;
    if(state.currentVerseIdx>0){
      state.currentVerseIdx--;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      stableSince=0; lastPrefix=0; paintedPrefix=0;
      ignoreUntilTs = Date.now() + 300;
    }
  });

  // ---------- Leaderboard ----------
  async function loadLeaderboard() {
    if (!db || !els.leaderList) return;
    let qs; try { qs = await db.collection("users").orderBy("versesRead","desc").limit(20).get(); } catch (e) { return; }
    const list=[]; qs.forEach(doc=>list.push({id:doc.id, ...doc.data()}));
    els.leaderList.innerHTML="";
    list.forEach((u,idx)=>{
      const label = (u.nickname && String(u.nickname).trim())
        ? String(u.nickname).trim()
        : ((u.email || "").toString().split("@")[0] || `user-${String(u.id).slice(0,6)}`);
      const v = Number(u.versesRead||0), c = Number(u.chaptersRead||0);
      const li=document.createElement("li");
      li.innerHTML = `<strong>${idx+1}위</strong> ${label} · 절 ${v.toLocaleString()} · 장 ${c.toLocaleString()}`;
      els.leaderList.appendChild(li);
    });
  }

  // ---------- Progress Matrix ----------
  function buildMatrix() {
    if (!els.matrixWrap) return;
    const maxCh = Math.max(...BOOKS.map(b => b.ch));
    const table=document.createElement("table"); table.className="matrix";
    const thead=document.createElement("thead"); const trh=document.createElement("tr");
    const th0=document.createElement("th"); th0.className="book"; th0.textContent="권/장"; trh.appendChild(th0);
    for(let c=1;c<=maxCh;c++){ const th=document.createElement("th"); th.textContent=String(c); trh.appendChild(th); }
    thead.appendChild(trh); table.appendChild(thead);
    const tbody=document.createElement("tbody");
    for(const b of BOOKS){
      const tr=document.createElement("tr");
      const th=document.createElement("th"); th.className="book"; th.textContent=b.ko; tr.appendChild(th);
      const read=state.progress[b.id]?.readChapters||new Set();
      for(let c=1;c<=maxCh;c++){
        const td=document.createElement("td");
        if(c<=b.ch){ td.textContent=" "; td.style.background = read.has(c) ? "rgba(67,209,122,0.6)" : "rgba(120,120,140,0.25)"; td.title=`${b.ko} ${c}장`; }
        else { td.style.background="transparent"; }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    els.matrixWrap.innerHTML=""; els.matrixWrap.appendChild(table);
  }
  function openMatrix(){ buildMatrix(); els.matrixModal?.classList.add("show"); els.matrixModal?.classList.remove("hidden"); }
  function closeMatrix(){ els.matrixModal?.classList.remove("show"); els.matrixModal?.classList.add("hidden"); }
  document.getElementById("btnOpenMatrix")?.addEventListener("click", openMatrix);
  els.btnCloseMatrix?.addEventListener("click", (e)=>{ e?.preventDefault?.(); e?.stopPropagation?.(); closeMatrix(); });
  els.matrixModal?.addEventListener("click", (e)=>{ const body=els.matrixModal.querySelector(".modal-body"); if (!body || !e.target) return; if (!body.contains(e.target)) closeMatrix(); });
  window.addEventListener("keydown", (e)=>{ if (e.key==='Escape' && els.matrixModal?.classList.contains('show')) closeMatrix(); });

  // ---------- Mic Level Meter ----------
  let audioCtx, analyser, micSrc, levelTimer, micStream;
  async function startMicLevel() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true, sampleRate:{ideal:48000} }
      });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      micSrc = audioCtx.createMediaStreamSource(micStream);
      micSrc.connect(analyser);

      const dataArray = new Uint8Array(analyser.fftSize);

      function update() {
        if (!analyser) return;
        analyser.getByteTimeDomainData(dataArray);
        let sumSq = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / dataArray.length);
        const db = 20 * Math.log10(rms || 1e-6);
        if (els.micBar) els.micBar.style.width = Math.min(100, Math.max(0, rms * 400)) + "%";
        if (els.micDb) els.micDb.textContent = (db <= -60 ? "-∞" : db.toFixed(0)) + " dB";
        levelTimer = requestAnimationFrame(update);
      }
      update();
    } catch (e) {
      console.warn("[MicLevel] 마이크 접근 실패:", e);
    }
  }
  function stopMicLevel() {
    if (levelTimer) cancelAnimationFrame(levelTimer);
    levelTimer = null;
    if (audioCtx) { try { audioCtx.close(); } catch(_) {} }
    if (micStream) { try { micStream.getTracks().forEach(t=>t.stop()); } catch(_) {} }
    audioCtx = null; analyser = null; micSrc = null; micStream = null;
    if (els.micBar) els.micBar.style.width = "0%";
    if (els.micDb) els.micDb.textContent = "-∞ dB";
  }

  // ---------- 튜닝 패널(네 가지 비용 값 UI) ----------
  const TUNING_LS_KEY = "recogTuningV1";
  function loadTuning(){
    try { return JSON.parse(localStorage.getItem(TUNING_LS_KEY) || "{}"); } catch(_) { return {}; }
  }
  function saveTuning(obj){
    localStorage.setItem(TUNING_LS_KEY, JSON.stringify(obj||{}));
  }
  function getTunedOptsWithProfile(profile){
    const t = loadTuning();
    return {
      SUB_NEAR: (t.SUB_NEAR != null ? Number(t.SUB_NEAR) : profile.SUB_NEAR),
      SUB_DIST: (t.SUB_DIST != null ? Number(t.SUB_DIST) : profile.SUB_DIST),
      DEL_COST: (t.DEL_COST != null ? Number(t.DEL_COST) : profile.DEL_COST),
      INS_COST: (t.INS_COST != null ? Number(t.INS_COST) : profile.INS_COST),
    };
  }

  let tuningPanel, tuningInputs = {};
  function createTuningPanel(){
    if (tuningPanel) return;
    tuningPanel = document.createElement("div");
    tuningPanel.id = "recog-tuning";
    tuningPanel.style.cssText = `
      position:fixed; right:10px; bottom:10px; z-index:9999;
      background:rgba(16,24,58,0.92); color:#fff; padding:10px 12px; border-radius:12px;
      box-shadow:0 6px 18px rgba(0,0,0,0.35); font-size:12px; width:240px;
      backdrop-filter:saturate(1.2) blur(4px);
    `;
    tuningPanel.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:6px">
        <strong style="font-size:13px">🎚️ 음성매칭 튜닝</strong>
        <button type="button" id="tuneReset" style="font-size:11px; padding:2px 6px; border-radius:6px; border:0; background:#39437a; color:#fff">프로파일값</button>
      </div>
      ${["SUB_NEAR","SUB_DIST","DEL_COST","INS_COST"].map(k=>`
        <label style="display:block; margin:6px 0 4px">${k}
          <input id="tune_${k}" type="number" step="0.01" min="0" max="2" style="width:100%; margin-top:2px; border-radius:8px; border:1px solid #556; padding:6px; background:#12183a; color:#fff"/>
        </label>
      `).join("")}
      <div style="opacity:.75">※ 값 낮을수록 더 <b>관대</b>해집니다.</div>
    `;
    document.body.appendChild(tuningPanel);

    ["SUB_NEAR","SUB_DIST","DEL_COST","INS_COST"].forEach(k=>{
      tuningInputs[k] = document.getElementById(`tune_${k}`);
      tuningInputs[k].addEventListener("change", ()=>{
        const v = tuningInputs[k].value;
        const num = (v === "" ? null : Number(v));
        const t = loadTuning();
        if (num === null || Number.isNaN(num)) { delete t[k]; } else { t[k] = num; }
        saveTuning(t);
      });
    });

    function renderValuesFromProfile(){
      const defaults = RECOG_PROFILES[currentMode] || RECOG_PROFILES.normal;
      const t = loadTuning();
      ["SUB_NEAR","SUB_DIST","DEL_COST","INS_COST"].forEach(k=>{
        tuningInputs[k].placeholder = String(defaults[k]);
        tuningInputs[k].value = (t[k] != null ? t[k] : "");
      });
    }
    renderValuesFromProfile();

    document.getElementById("tuneReset").addEventListener("click", ()=>{
      saveTuning({});
      ["SUB_NEAR","SUB_DIST","DEL_COST","INS_COST"].forEach(k=>{ tuningInputs[k].value = ""; });
    });

    window.__renderTuningPlaceholders = renderValuesFromProfile;
  }
  createTuningPanel();

  function setTuningDisabled(disabled){
    if (!tuningPanel) return;
    tuningPanel.style.opacity = disabled ? ".55" : "1";
    ["SUB_NEAR","SUB_DIST","DEL_COST","INS_COST"].forEach(k=>{
      if (tuningInputs[k]) tuningInputs[k].disabled = disabled;
    });
  }

})();
