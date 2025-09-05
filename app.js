/* 말씀읽기APP — Firebase 로그인/진도저장 + bible.json + 안드로이드 최적화 음성매칭(최대 안정) */
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

    // (선택) 레벨미터
    micBar: document.getElementById("micBar"),
    micDb: document.getElementById("micDb"),
  };

  // ---------- State ----------
  const BOOKS = window.BOOKS || [];
  const getBookByKo = (ko) => BOOKS.find(b => b.ko === ko);
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const state = {
    bible: null, currentBookKo: null, currentChapter: null,
    verses: [], currentVerseIdx: 0,
    listening:false, recog:null,
    progress:{}, myStats:{versesRead:0,chaptersRead:0,last:{bookKo:null,chapter:null,verse:0}},
    ignoreUntilTs: 0,  // 자동이동 직후 잠깐 무시
    paintedPrefix: 0,  // 화면 채움 경계
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
  els.btnSignup?.addEventListener("click", () => withBusy(els.btnSignup, async () => {
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

  els.btnLogin?.addEventListener("click", () => withBusy(els.btnLogin, async () => {
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
    // 기본 로고 숨기고 photoURL 있을 때만 표시
    if (els.userPhoto) {
      if (u.photoURL) { els.userPhoto.src = u.photoURL; els.userPhoto.classList.remove('hidden'); }
      else { els.userPhoto.classList.add('hidden'); }
    }

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
  function updateVerseText() {
    const v = state.verses[state.currentVerseIdx] || "";
    state.paintedPrefix = 0;
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

  // ---------- 마이크 예열 (권한/경로 고정) ----------
  let primeStream;
  async function primeMicrophone() {
    if (primeStream && primeStream.getTracks().some(t=>t.readyState==="live")) return primeStream;
    try {
      primeStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate:   { ideal: 48000 },
          sampleSize:   { ideal: 16 },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl:  { ideal: true }
        },
        video: false
      });
      if (window.AudioContext || window.webkitAudioContext) {
        try {
          const ac = new (window.AudioContext || window.webkitAudioContext)();
          if (ac.state === "suspended") await ac.resume();
          const src = ac.createMediaStreamSource(primeStream);
          const g = ac.createGain(); src.connect(g);
          await new Promise(r => setTimeout(r, 20));
          ac.close();
        } catch(_) {}
      }
      return primeStream;
    } catch (e) {
      console.warn("[PrimeMic] 실패:", e);
      return null;
    }
  }
  function releasePrimeMic() {
    try { if (primeStream) primeStream.getTracks().forEach(t=>t.stop()); } catch(_) {}
    primeStream = null;
  }

  // ---------- 한글 정규화/자모 ----------
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
        out.push(CHO[L], JUNG[V]); if (T) out.push(JONG[T]);
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
      .replace(/^\s*십\s*$/g,"10");
  }

  const USE_PRONUN_HEUR = true; // '의'≈'에' 등
  function normalizeToJamo(s, forSpoken=false){
    let t = (s||"").normalize("NFKC").replace(/[“”‘’"'\u200B-\u200D`´^~]/g,"").toLowerCase();
    t = normalizeKoreanNumbers(t);
    if (forSpoken && USE_PRONUN_HEUR) t = t.replace(/의/g,"에");
    t = t.replace(/[^\p{L}\p{N} ]/gu," ").replace(/\s+/g," ").trim();
    return decomposeJamo(t).replace(/\s+/g,"");
  }

  // ---------- 매칭: 접두 커버리지 + 가중 레벤슈타인(밴드) ----------
  // 근접 대체(모음 유사, 유성/무성, 받침 생략 등)
  const NEAR = new Set([
    "ㅐ,ㅔ","ㅔ,ㅐ","ㅚ,ㅙ","ㅚ,ㅞ","ㅙ,ㅞ",
    "ㅢ,ㅣ","ㅣ,ㅢ","ㅓ,ㅗ","ㅕ,ㅛ","ㅠ,ㅡ",
    "ㄴ,ㅇ","ㅇ,ㄴ","ㅂ,ㅍ","ㅍ,ㅂ","ㅂ,ㅁ","ㅁ,ㅂ",
    "ㄷ,ㅌ","ㅌ,ㄷ","ㅅ,ㅆ","ㅆ,ㅅ",
    "ㅎ,"," ,ㅎ" // ㅎ 탈락
  ]);
  function near(a,b){ return a===b || NEAR.has(`${a},${b}`); }

  function bandedEdit(target, spoken, band=10, subNear=0.35, subFar=1.0, del=0.55, ins=0.55){
    const n=target.length, m=spoken.length;
    let prev=new Float32Array(m+1), curr=new Float32Array(m+1);
    for(let j=0;j<=m;j++) prev[j]=j*ins;
    for(let i=1;i<=n;i++){
      const jStart=Math.max(1,i-band), jEnd=Math.min(m,i+band);
      curr[0]=i*del;
      for(let j=1;j<=m;j++){
        if(j<jStart||j>jEnd){ curr[j]=1e9; continue; }
        const cSub = prev[j-1] + (target[i-1]===spoken[j-1] ? 0 : (near(target[i-1], spoken[j-1])? subNear : subFar));
        const cDel = prev[j] + del;
        const cIns = curr[j-1] + ins;
        curr[j] = Math.min(cSub, cDel, cIns);
      }
      const t=prev; prev=curr; curr=t;
    }
    let best=prev[m];
    for(let j=Math.max(0,m-band); j<=m; j++) if(prev[j]<best) best=prev[j];
    return best; // 작을수록 유사
  }

  // target의 앞에서부터 얼마나 덮었는지: i를 증가시키며 ED비율로 판정
  function prefixCoverage(targetJ, spokenJ){
    const n = targetJ.length;
    if (!n || !spokenJ.length) return 0;

    const short=30, medium=60;
    const thrShort=0.80, thrMedium=0.78, thrLong=0.75; // 안드로이드용(조금 관대)
    let bestI=0;
    for(let i=1;i<=n;i++){
      const slice = targetJ.slice(0,i);
      const band = Math.min(12, Math.max(6, Math.floor(i/8)));
      const ed = bandedEdit(slice, spokenJ, band);
      const okRatio = 1 - (ed / Math.max(1,i)); // 1: 완전일치
      const thr = (i<=short)?thrShort : (i<=medium?thrMedium:thrLong);
      if (okRatio >= thr) bestI = i;
      // 최적화: 연속 실패시 살짝 건너뛰기
      if (i - bestI > 20) break;
    }
    return bestI;
  }

  // ---------- SpeechRecognition 루프(안드로이드 최적화) ----------
  function supportsSR(){ return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  function makeRecognizer(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = 'ko-KR';
    r.continuous = !IS_ANDROID;        // 안드로이드는 false가 더 안정
    r.interimResults = !IS_ANDROID ? true : false; // 안드로이드는 final 위주
    try { r.maxAlternatives = 4; } catch(_) {}
    return r;
  }

  let loopTimer=null;
  function runRecognizerLoop(){
    if (!state.listening) return;
    const recog = makeRecognizer();
    if (!recog) {
      els.listenHint && (els.listenHint.innerHTML="⚠️ 음성인식 미지원(Chrome/Safari 권장)");
      alert("이 브라우저는 음성인식을 지원하지 않습니다.");
      stopListening();
      return;
    }
    state.recog = recog;

    recog.onresult = (evt)=>{
      // 안드로이드: 대부분 final만 들어옴
      const v = state.verses[state.currentVerseIdx] || "";
      if (!v) return;
      if (Date.now() < state.ignoreUntilTs) return;

      // 상위 후보 1개만 사용(안드로이드 단일 결과 빈도 높음)
      const res = evt.results[evt.results.length-1]; if (!res) return;
      const tr = res[0]?.transcript || ""; if (!tr) return;

      const targetJ = normalizeToJamo(v, false);
      const spokenJ = normalizeToJamo(tr, true);

      // 접두 커버리지 계산
      const matched = prefixCoverage(targetJ, spokenJ);

      // 화면 채움: 앞서가지 않도록 완만히
      const paintLen = Math.min(targetJ.length, Math.max(state.paintedPrefix, Math.min(matched, state.paintedPrefix+3)));
      paintRead(paintLen);
      state.paintedPrefix = paintLen;

      const ratio = matched / Math.max(1, targetJ.length);
      const L = targetJ.length;
      const need = (L<=30?0.80:(L<=60?0.78:0.75));

      if (ratio >= need) completeVerse(); // 최종판정: 관대
    };

    // 안드로이드: onend가 자주 오므로 버튼 ON이면 즉시 재가동
    const restart = () => {
      if (!state.listening) return;
      try { state.recog && (state.recog.onresult=null, state.recog.onend=null, state.recog.onerror=null, state.recog.abort?.()); } catch(_){}
      loopTimer = setTimeout(runRecognizerLoop, 80);
    };
    recog.onend = restart;

    recog.onerror = (e)=>{
      console.warn("[SR] error:", e?.error, e);
      if (!state.listening) return;
      // no-speech / network / audio-capture → 바로 재가동
      loopTimer = setTimeout(runRecognizerLoop, 150);
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        alert("마이크 권한이 필요합니다. 주소창 오른쪽 마이크 아이콘을 확인하세요.");
      }
    };

    try {
      recog.start();
    } catch(e) {
      console.warn("recog.start 실패:", e);
      loopTimer = setTimeout(runRecognizerLoop, 150);
    }
  }

  async function startListening(showAlert=true){
    if (state.listening) return;
    if (!supportsSR()){
      els.listenHint && (els.listenHint.innerHTML="⚠️ 음성인식 미지원(Chrome/Safari 권장)");
      if (showAlert) alert("이 브라우저는 음성인식을 지원하지 않습니다.");
      return;
    }
    await primeMicrophone(); // 권한/경로 고정

    state.paintedPrefix = 0;
    state.ignoreUntilTs = 0;
    state.listening = true;
    els.btnToggleMic && (els.btnToggleMic.textContent="⏹️");
    startMicLevel();

    runRecognizerLoop();
  }

  function stopListening(resetBtn=true){
    state.listening=false;
    if (loopTimer) { clearTimeout(loopTimer); loopTimer=null; }
    if (state.recog){
      try{ state.recog.onresult=null; state.recog.onend=null; state.recog.onerror=null; state.recog.abort?.(); }catch(_){}
      try{ state.recog.stop?.(); }catch(_){}
    }
    if (resetBtn && els.btnToggleMic) els.btnToggleMic.textContent="🎙️";
    stopMicLevel();
    releasePrimeMic();
  }

  els.btnToggleMic?.addEventListener("click", ()=>{ if(!state.listening) startListening(); else stopListening(); });

  // ---------- 완료/자동이동 (마이크는 건드리지 않음) ----------
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

  async function completeVerse(){
    await incVersesRead(1);

    const auto = els.autoAdvance ? !!els.autoAdvance.checked : true;
    const b = getBookByKo(state.currentBookKo);

    if (auto){
      const moved = await advanceToNextVerse();
      if (!moved){
        await markChapterDone(b.id, state.currentChapter);
        state.myStats.last.verse = 0;
        state.myStats.last.chapter = state.currentChapter;
        saveLastPosition();
        alert("장 완료! 다음 장으로 이동하세요.");
        return;
      }
      // 자동이동 직후 잠깐 무시(이전 인식 파편 방지)
      state.paintedPrefix = 0;
      state.ignoreUntilTs = Date.now() + 500;
    } else {
      // 자동이동이 아닐 때도, 같은 절 재시도시 과속 방지
      state.ignoreUntilTs = Date.now() + 300;
    }
  }

  // ---------- 앞/뒤 절 버튼(마이크는 손대지 않음) ----------
  els.btnNextVerse?.addEventListener("click", ()=>{
    if(!state.verses.length) return;
    if(state.currentVerseIdx<state.verses.length-1){
      state.currentVerseIdx++;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      state.paintedPrefix=0; state.ignoreUntilTs = Date.now() + 300;
    }
  });
  els.btnPrevVerse?.addEventListener("click", ()=>{
    if(!state.verses.length) return;
    if(state.currentVerseIdx>0){
      state.currentVerseIdx--;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      state.paintedPrefix=0; state.ignoreUntilTs = Date.now() + 300;
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
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

})();
