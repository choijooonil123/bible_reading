/* 말씀읽기APP — Email/Password 로그인 + bible.json
   - 어절단위 음성매칭(초-관대)
   - Mic은 버튼으로만 ON/OFF (자동 재시작 없음)
   - 절 완료 시 VerseGrid 버튼에 done 표시, 장 완료 시 ChapterGrid done 표시 유지
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
    verses: [], currentVerseIdx: 0,
    listening:false, recog:null,
    progress:{}, myStats:{versesRead:0,chaptersRead:0,last:{bookKo:null,chapter:null,verse:0}},
    completedVerses: new Set(),     // 현재 장 내에서 완료된 절들(번호)
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
    state.completedVerses.clear();
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
    state.completedVerses.clear();
    els.verseGrid && (els.verseGrid.innerHTML = "");
    els.verseText && (els.verseText.textContent = "장과 절을 선택하세요.");
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
      btn.className = "chip";
      if (state.completedVerses.has(i)) btn.classList.add("done"); // 완료 색상
      if (state.currentVerseIdx === i - 1) btn.classList.add("active"); // 현재 절 색상
      btn.textContent = i;
      btn.addEventListener("click", () => {
        state.currentVerseIdx = i - 1; updateVerseText();
        state.myStats.last.verse = i; saveLastPosition();
      });
      els.verseGrid.appendChild(btn);
    }
  }

  async function selectChapter(chapter) {
    state.currentChapter = chapter; state.currentVerseIdx = 0;
    state.completedVerses.clear(); // 장 변경 시 절 완료표시 초기화
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

  // ---------- 어절 렌더링 ----------
  let eojeols = [];
  let prefixLensByWord = [];
  let paintedWordIdx = -1;
  let ignoreUntilTs = 0;      // 자동이동/절 변경 직후 잔여 인식 무시

  function splitToEojeols(str){
    const raw = (str||"").replace(/\s+/g, " ").trim();
    return raw.length ? raw.split(" ") : [];
  }

  function rebuildVerseAsWords(){
    const v = state.verses[state.currentVerseIdx] || "";
    const words = splitToEojeols(v);
    eojeols = words.map(w => ({ text: w, jamo: normalizeToJamo(w, false) }));
    prefixLensByWord = [];
    let acc = 0;
    for (const w of eojeols) { acc += w.jamo.length; prefixLensByWord.push(acc); }

    if (els.verseText) {
      els.verseText.innerHTML = "";
      words.forEach((w, idx) => {
        const span = document.createElement("span");
        span.className = "word";
        span.textContent = w + (idx < words.length - 1 ? " " : "");
        els.verseText.appendChild(span);
      });
    }
    paintedWordIdx = -1;
  }

  function updateVerseText() {
    const v = state.verses[state.currentVerseIdx] || "";
    els.locLabel && (els.locLabel.textContent =
      `${state.currentBookKo} ${state.currentChapter}장 ${state.currentVerseIdx + 1}절`);
    rebuildVerseAsWords();
    els.verseCount && (els.verseCount.textContent =
      `(${state.verses.length}절 중 ${state.currentVerseIdx + 1}절)`);
    if (els.verseGrid) {
      [...els.verseGrid.children].forEach((btn, idx) => {
        btn.classList.toggle("active", idx===state.currentVerseIdx);
        btn.classList.toggle("done", state.completedVerses.has(idx+1));
      });
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
    try { r.maxAlternatives = 5; } catch(_) {}
    return r;
  };

  // 모바일 환경 가드 & 워밍업
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

  // 정규화/자모
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
  const pronunciationHeuristics = s => s.replace(/의/g,"에");
  function normalizeToJamo(s, forSpoken=false){
    let t = (s||"").normalize("NFKC").replace(/[“”‘’"'\u200B-\u200D`´^~]/g,"").toLowerCase();
    if (forSpoken) t = pronunciationHeuristics(t);
    t = t.replace(/[^\p{L}\p{N} ]/gu," ").replace(/\s+/g," ").trim();
    t = decomposeJamo(t).replace(/\s+/g,"");
    return t;
  }

  // ----- 어절 단위 매칭(매우 관대) -----
  // 절 전체 자모열 targetJ, 발화 spokenJ -> 앞에서부터 관대한 매칭 길이(자모 수)
  function softPrefixJamo(targetJ, spokenJ){
    if (!targetJ || !spokenJ) return 0;
    let ti=0, si=0, matched=0, errors=0, skips=0;
    const L = targetJ.length;
    // ★ 매우 관대: 8자마다 1오류, 최대 7까지 / 18자마다 1스킵, 최대 5까지
    const MAX_ERR   = Math.min(7, Math.floor(L/8)+1);
    const MAX_SKIPS = Math.min(5, Math.floor(L/18)+1);
    while (ti<L && si<spokenJ.length){
      if (targetJ[ti] === spokenJ[si]) { ti++; si++; matched++; continue; }
      if (errors < MAX_ERR){ errors++; ti++; si++; matched++; continue; }
      if (skips < MAX_SKIPS && si+1<spokenJ.length && targetJ[ti]===spokenJ[si+1]) { si++; skips++; continue; }
      if (skips < MAX_SKIPS && ti+1<L && targetJ[ti+1]===spokenJ[si]) { ti++; skips++; matched++; continue; }
      break;
    }
    return matched;
  }

  function coveredToWordIdx(coveredJamo){
    let idx = -1;
    for (let i=0;i<prefixLensByWord.length;i++){
      if (coveredJamo >= prefixLensByWord[i]) idx = i; else break;
    }
    return idx;
  }

  function paintByWord(doneIdx){
    if (!els.verseText) return;
    const spans = els.verseText.querySelectorAll(".word");
    for (let i=0;i<spans.length;i++){
      spans[i].classList.toggle("read", i<=doneIdx);
    }
    paintedWordIdx = doneIdx;
  }

  // ★ 완료 판정도 관대: 0.72
  function isVerseComplete(covered, total){
    if (!total) return false;
    return (covered / total) >= 0.72;
  }

  // ---------- 인식 콜백 ----------
  function bestTranscripts(evt){
    const cand=[];
    for (let i=0;i<evt.results.length;i++){
      const res=evt.results[i];
      const maxAlt=Math.min(res.length,5);
      for (let a=0;a<maxAlt;a++) cand.push(res[a].transcript);
    }
    cand.sort((a,b)=>b.length-a.length);
    return cand.slice(0,5);
  }

  function onSpeechResult(evt){
    const v = state.verses[state.currentVerseIdx] || "";
    if (!v || !eojeols.length) return;

    const nowTs = Date.now();
    if (nowTs < ignoreUntilTs) return;

    const targetJ = normalizeToJamo(v, false);
    let bestCovered = 0;
    for (const tr of bestTranscripts(evt)){
      const spokenJ = normalizeToJamo(tr, true);
      const covered = softPrefixJamo(targetJ, spokenJ);
      if (covered > bestCovered) bestCovered = covered;
    }

    const doneIdx = coveredToWordIdx(bestCovered);
    if (doneIdx > paintedWordIdx) paintByWord(doneIdx);

    const totalJ = targetJ.length;
    const isFinal = evt.results[evt.results.length - 1]?.isFinal;
    if (isFinal && isVerseComplete(bestCovered, totalJ)) {
      completeVerse();
    }
  }

  // ---------- 자동이동 ----------
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
    // 절 버튼 완료 색상
    state.completedVerses.add(state.currentVerseIdx + 1);
    // VerseGrid 갱신
    if (els.verseGrid) {
      const btn = els.verseGrid.children[state.currentVerseIdx];
      if (btn) btn.classList.add("done");
    }

    await incVersesRead(1);
    const auto = els.autoAdvance ? !!els.autoAdvance.checked : true;
    const b = getBookByKo(state.currentBookKo);

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
      // 다음 절 바로 시작 시 앞서 칠해짐 방지
      ignoreUntilTs = Date.now() + 450;
    }
  }

  // ---------- Mic: 버튼으로만 ON/OFF ----------
  async function startListening(showAlert=true){
    if (!envGuardBeforeStart()) return;
    if (state.listening) return;

    state.recog = getRecognition();
    if (!state.recog){
      els.listenHint && (els.listenHint.innerHTML="⚠️ 음성인식 미지원(Chrome/Safari 권장)");
      if (showAlert) alert("이 브라우저는 음성인식을 지원하지 않습니다.");
      return;
    }

    state.recog.onresult = onSpeechResult;
    // 자동 재시작 금지 — 종료되면 버튼 상태만 복구
    state.recog.onend = () => {
      state.listening = false;
      els.btnToggleMic && (els.btnToggleMic.textContent="🎙️");
      stopMicLevel();
    };
    state.recog.onerror = (e) => {
      console.warn("[SR] error:", e?.error, e);
    };

    try {
      await primeMicOnce();
      state.recog.start();
      state.listening = true;
      els.btnToggleMic && (els.btnToggleMic.textContent="⏹️");
      startMicLevel();
    } catch(e){
      alert("음성인식 시작 실패: " + e.message);
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
  }

  els.btnToggleMic?.addEventListener("click", ()=>{ if(!state.listening) startListening(); else stopListening(); });

  // 앞/뒤 절 이동: Mic는 건드리지 않음 + 상태 표시/무시창
  els.btnNextVerse?.addEventListener("click", ()=>{
    if(!state.verses.length) return;
    if(state.currentVerseIdx<state.verses.length-1){
      state.currentVerseIdx++;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
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
      const bar = document.getElementById("micBar");
      const dbLabel = document.getElementById("micDb");

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
        if (bar) bar.style.width = Math.min(100, Math.max(0, rms * 400)) + "%";
        if (dbLabel) dbLabel.textContent = (db <= -60 ? "-∞" : db.toFixed(0)) + " dB";
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
    const bar = document.getElementById("micBar"); if (bar) bar.style.width = "0%";
    const dbLabel = document.getElementById("micDb"); if (dbLabel) dbLabel.textContent = "-∞ dB";
  }

})();
