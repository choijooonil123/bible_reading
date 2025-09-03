/* 말씀읽기APP — Email/Password 로그인 + bible.json + 음성인식(v3-stable) + 자동이동시 음성 재시작 + 진도저장
   - 표시이름(displayName): Firebase Auth 프로필에만 (선택 입력 시) 갱신
   - 닉네임(nickname): Firestore users/{uid}.nickname 에 저장(선택 입력 시), 순위표 표시용
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
  };

  // ---------- State ----------
  const BOOKS = window.BOOKS || [];
  const getBookByKo = (ko) => BOOKS.find(b => b.ko === ko);
  const state = {
    bible: null, currentBookKo: null, currentChapter: null,
    verses: [], currentVerseIdx: 0, listening:false, recog:null,
    progress:{}, myStats:{versesRead:0,chaptersRead:0,last:{bookKo:null,chapter:null,verse:0}},
    suppressAutoRestart: false // onend 자동재시작 억제용 가드
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

  // ---------- Auth UX 보조 ----------
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
      email: u.email || ",
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
          .set({ versesRead: firebase.firestore.FieldValue.increment(n),
                 updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
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

  function updateVerseText() {
    const v = state.verses[state.currentVerseIdx] || "";
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

  // ---------- Speech Recognition (v3-stable: 연속매칭 + final필수 + 임계강화) ----------
  const getRecognition = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = 'ko-KR';
    r.continuous = true;
    r.interimResults = true; // 중간은 보지만, 완료 체크는 final에서만
    try { r.maxAlternatives = 3; } catch(_) {}
    return r;
  };

  // 모드 프로파일 (빠름/보통/느긋함)
  const RECOG_PROFILES = {
    fast:   { shortLen:30, mediumLen:60, minRatioShort:0.94, minRatioMedium:0.92, minRatioLong:0.90, holdMs:400, cooldownMs:600, postAdvanceDelayMs:300 },
    normal: { shortLen:30, mediumLen:60, minRatioShort:0.92, minRatioMedium:0.90, minRatioLong:0.88, holdMs:500, cooldownMs:700, postAdvanceDelayMs:400 },
    lenient:{ shortLen:30, mediumLen:60, minRatioShort:0.88, minRatioMedium:0.86, minRatioLong:0.84, holdMs:600, cooldownMs:800, postAdvanceDelayMs:500 }
  };
  let MATCH_PROFILE = RECOG_PROFILES.normal;

  // 라디오 → 프로파일 변경
  document.querySelectorAll("input[name=recogMode]")?.forEach(radio=>{
    radio.addEventListener("change", ()=>{
      const val = document.querySelector("input[name=recogMode]:checked")?.value || "normal";
      MATCH_PROFILE = RECOG_PROFILES[val] || RECOG_PROFILES.normal;
      console.log("[RecogMode] 변경:", val, MATCH_PROFILE);
    });
  });

  // 자모 분해 테이블
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

  // 숫자 간략 정규화(1~99)
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

  // v3: 불용어/발음치환 기본 OFF (과매칭 방지)
  const USE_STOPWORD_STRIP = false;
  const USE_PRONUN_HEUR   = false;
  const STOPWORDS = /(\b|)(은|는|이|가|을|를|에|에서|으로|와|과|도|만|까지|부터|로서|보다|에게|께|마다|처럼|뿐|이라|거나|하며|하고)(\b|)/g;
  const pronunciationHeuristics = s => s.replace(/의/g,"에");

  // 공통 정규화 → 자모열
  function normalizeToJamo(s, forSpoken=false){
    let t = (s||"").normalize("NFKC")
      .replace(/[“”‘’"'\u200B-\u200D`´^~]/g,"")
      .toLowerCase();

    t = normalizeKoreanNumbers(t);
    if (USE_STOPWORD_STRIP) t = t.replace(STOPWORDS," ");
    if (forSpoken && USE_PRONUN_HEUR) t = pronunciationHeuristics(t);

    t = t.replace(/[^\p{L}\p{N} ]/gu," ").replace(/\s+/g," ").trim();
    t = decomposeJamo(t).replace(/\s+/g,"");
    return t;
  }

  // 연속(prefix) 매칭만 허용: spoken 시작 오프셋 0..5 탐색
  function matchedPrefixLenContiguous(targetJamo, spokenJamo){
    if (!targetJamo || !spokenJamo) return 0;
    let best = 0;
    const maxShift = Math.min(5, Math.max(0, spokenJamo.length-1));
    for (let shift = 0; shift <= maxShift; shift++){
      let ti = 0, si = shift, cur = 0;
      while (ti < targetJamo.length && si < spokenJamo.length){
        if (targetJamo[ti] !== spokenJamo[si]) break;
        cur++; ti++; si++;
      }
      if (cur > best) best = cur;
      if (best >= targetJamo.length) break;
    }
    return best;
  }

  function paintRead(prefixLen){
    if (!els.verseText) return;
    const spans = els.verseText.childNodes;
    for (let i=0;i<spans.length;i++){
      spans[i].classList?.toggle("read", i<prefixLen);
    }
  }

  // 안정창/쿨다운/상태
  let stableSince = 0;
  let lastCompleteTs = 0;
  let lastPrefix = 0;

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

    const targetJ = normalizeToJamo(v, false);
    const L = targetJ.length;
    const minRatio =
      (L <= MATCH_PROFILE.shortLen)  ? MATCH_PROFILE.minRatioShort  :
      (L <= MATCH_PROFILE.mediumLen) ? MATCH_PROFILE.minRatioMedium :
                                       MATCH_PROFILE.minRatioLong;

    let bestPref = 0;
    for (const tr of bestTranscripts(evt)){
      const spokenJ = normalizeToJamo(tr, true);
      const pref = matchedPrefixLenContiguous(targetJ, spokenJ);
      if (pref > bestPref) bestPref = pref;
    }

    paintRead(bestPref);

    const ratio = L ? bestPref / L : 0;
    const now = Date.now();
    if (bestPref > lastPrefix){ stableSince = now; lastPrefix = bestPref; }

    const holdOk = (now - stableSince) >= MATCH_PROFILE.holdMs;
    const coolOk = (now - lastCompleteTs) >= MATCH_PROFILE.cooldownMs;
    const isFinal = evt.results[evt.results.length - 1]?.isFinal;

    // v3: 'final'일 때만 완료
    if (ratio >= minRatio && holdOk && coolOk && isFinal){
      lastCompleteTs = now;
      completeVerseWithProfile();
    }
  }

  // ---------- 자동이동/재시작 유틸 ----------
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

  async function hardRestartRecognition(delayMs = 250) {
    state.suppressAutoRestart = true; // onend 자동재시작 방지
    stopListening(false);
    try { state.recog = null; } catch(_) {}
    await new Promise(r => setTimeout(r, delayMs)); // 자원 반환 대기
    startListening(false);
    setTimeout(() => { state.suppressAutoRestart = false; }, 100);
  }

  async function completeVerseWithProfile(){
    // 카운트 업데이트
    await incVersesRead(1);

    const auto = els.autoAdvance ? !!els.autoAdvance.checked : true;
    const b = getBookByKo(state.currentBookKo);

    // 완료 후 잠깐 숨고르기
    await new Promise(r => setTimeout(r, MATCH_PROFILE.postAdvanceDelayMs));

    if (auto) {
      // onend 자동재시작이 끼어들지 않도록 억제 후 정지
      state.suppressAutoRestart = true;
      stopListening(false);

      const moved = await advanceToNextVerse();
      if (!moved) {
        await markChapterDone(b.id, state.currentChapter);
        state.myStats.last.verse = 0;
        state.myStats.last.chapter = state.currentChapter;
        saveLastPosition();
        alert("장 완료! 다음 장으로 이동하세요.");
        state.suppressAutoRestart = false; // 해제
        return;
      }

      // 매칭 상태 초기화
      stableSince = 0; lastPrefix = 0;

      // 음성인식 완전 재기동
      await hardRestartRecognition(250); // 200~400 사이에서 환경에 맞게 조절 가능
    }
  }

  function startListening(showAlert=true){
    if (state.listening) return;
    state.recog = getRecognition();
    if (!state.recog){
      els.listenHint && (els.listenHint.innerHTML="⚠️ 음성인식 미지원(데스크톱 Chrome 권장)");
      if (showAlert) alert("이 브라우저는 음성인식을 지원하지 않습니다.");
      return;
    }
    stableSince=0; lastPrefix=0;

    state.recog.onresult = onSpeechResult;

    // onend 자동 재시작: 억제 가드가 꺼져 있고, listening=true일 때만
    state.recog.onend = () => {
      if (state.listening && !state.suppressAutoRestart) {
        try { state.recog.start(); } catch(_) {}
      }
    };

    try {
      state.recog.start();
      state.listening = true;
      els.btnToggleMic && (els.btnToggleMic.textContent="⏹️");
    } catch(e){
      alert("음성인식 시작 실패: " + e.message);
    }
  }

  function stopListening(resetBtn=true){
    if (state.recog){
      try{ state.recog.onresult=null; state.recog.onend=null; state.recog.stop(); }catch(_){}
    }
    state.listening=false;
    if (resetBtn && els.btnToggleMic) els.btnToggleMic.textContent="🎙️";
  }

  els.btnToggleMic?.addEventListener("click", ()=>{ if(!state.listening) startListening(); else stopListening(); });
  els.btnNextVerse?.addEventListener("click", ()=>{ if(!state.verses.length) return; state.suppressAutoRestart = true; stopListening(false);
    if(state.currentVerseIdx<state.verses.length-1){ state.currentVerseIdx++; state.myStats.last.verse=state.currentVerseIdx+1; saveLastPosition(); updateVerseText(); stableSince=0; lastPrefix=0; hardRestartRecognition(200); } else { state.suppressAutoRestart=false; } });
  els.btnPrevVerse?.addEventListener("click", ()=>{ if(!state.verses.length) return; state.suppressAutoRestart = true; stopListening(false);
    if(state.currentVerseIdx>0){ state.currentVerseIdx--; state.myStats.last.verse=state.currentVerseIdx+1; saveLastPosition(); updateVerseText(); stableSince=0; lastPrefix=0; hardRestartRecognition(200); } else { state.suppressAutoRestart=false; } });

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

})();
