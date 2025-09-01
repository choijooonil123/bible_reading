/* 말씀읽기APP — Email/Password 로그인 + bible.json + 음성인식 + 진도저장
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
    displayName: document.getElementById("displayName"), // 선택(Auth만)
    nickname: document.getElementById("nickname"),       // 선택(Firestore)
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
    progress:{}, myStats:{versesRead:0,chaptersRead:0,last:{bookKo:null,chapter:null,verse:0}}
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
    const name  = (els.displayName.value || "").trim(); // 선택 입력
    const nick  = (els.nickname?.value || "").trim();   // 선택 입력
    if (!email || !pw) { alert("이메일/비밀번호를 입력하세요."); return; }

    try {
      const cred = await auth.createUserWithEmailAndPassword(email, pw);
      user = cred.user;
      if (name) { await user.updateProfile({ displayName: name }); } // Auth 프로필만 갱신
      await safeEnsureUserDoc(user, { nickname: nick });             // 닉네임은 Firestore에
    } catch (e) {
      console.error(e);
      alert("회원가입 실패: " + mapAuthError(e));
    }
  }));

  els.btnLogin?.addEventListener("click", () => withBusy(els.btnLogin, async () => {
    const email = (els.email.value || "").trim();
    const pw    = (els.password.value || "").trim();
    const name  = (els.displayName.value || "").trim(); // 선택 입력
    const nick  = (els.nickname?.value || "").trim();   // 선택 입력
    if (!email || !pw) { alert("이메일/비밀번호를 입력하세요."); return; }

    try {
      const cred = await auth.signInWithEmailAndPassword(email, pw);
      user = cred.user;
      if (name) { await user.updateProfile({ displayName: name }); } // Auth 프로필만 갱신
      await safeEnsureUserDoc(user, { nickname: nick });             // 닉네임은 Firestore에
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
    // 닉네임 입력 시에만 병합 저장
    if (opts.nickname && opts.nickname.trim()) {
      data.nickname = opts.nickname.trim();
    }
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

  // ---------- Speech Recognition ----------
  const getRecognition = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return null;
    const r = new SR(); r.lang='ko-KR'; r.continuous=true; r.interimResults=true; return r;
  };
  function normalize(s){ return (s||"").replace(/[^\p{L}\p{N}\s]/gu," ").replace(/\s+/g," ").trim().toLowerCase(); }
  function matchedPrefixLen(target, spoken){ const t=normalize(target), s=normalize(spoken); if(!s) return 0; let ti=0,si=0,c=0; while(ti<t.length && si<s.length){ if(t[ti]===s[si]){c++;ti++;si++;} else {si++;} } return Math.min(c, target.length); }
  function paintRead(prefixLen){ if(!els.verseText) return; const spans=els.verseText.childNodes; for(let i=0;i<spans.length;i++){ spans[i].classList?.toggle("read", i<prefixLen); } }
  function onSpeechResult(evt){ const v=state.verses[state.currentVerseIdx]||""; let transcript=""; for(const res of evt.results){ transcript+=res[0].transcript+" "; } const pref=matchedPrefixLen(v, transcript); paintRead(pref); const ratio=pref/v.length; if(ratio>=0.92 && !evt.results[evt.results.length-1].isFinal){ completeVerse(); } }
  async function completeVerse(){ stopListening(false); await incVersesRead(1); const b=getBookByKo(state.currentBookKo); const auto=els.autoAdvance?els.autoAdvance.checked:true; if(auto){ if(state.currentVerseIdx<state.verses.length-1){ state.currentVerseIdx++; state.myStats.last.verse=state.currentVerseIdx+1; saveLastPosition(); updateVerseText(); startListening(false); } else { await markChapterDone(b.id, state.currentChapter); state.myStats.last.verse=0; state.myStats.last.chapter=state.currentChapter; saveLastPosition(); alert("장 완료! 다음 장으로 이동하세요."); } } }
  function startListening(showAlert=true){ if(state.listening) return; state.recog=getRecognition(); if(!state.recog){ els.listenHint && (els.listenHint.innerHTML="⚠️ 음성인식 미지원(데스크톱 Chrome 권장)"); if(showAlert) alert("이 브라우저는 음성인식을 지원하지 않습니다."); return; } state.recog.onresult=onSpeechResult; state.recog.onend=()=>{ if(state.listening){ try{ state.recog.start(); }catch(_){} } }; try{ state.recog.start(); state.listening=true; els.btnToggleMic && (els.btnToggleMic.textContent="⏹️"); }catch(e){ alert("음성인식 시작 실패: "+e.message); } }
  function stopListening(resetBtn=true){ if(state.recog){ try{ state.recog.onresult=null; state.recog.onend=null; state.recog.stop(); }catch(_){} } state.listening=false; if(resetBtn && els.btnToggleMic) els.btnToggleMic.textContent="🎙️"; }
  els.btnToggleMic?.addEventListener("click", ()=>{ if(!state.listening) startListening(); else stopListening(); });
  els.btnNextVerse?.addEventListener("click", ()=>{ if(!state.verses.length) return; stopListening(false); if(state.currentVerseIdx<state.verses.length-1){ state.currentVerseIdx++; state.myStats.last.verse=state.currentVerseIdx+1; saveLastPosition(); updateVerseText(); startListening(false); } });
  els.btnPrevVerse?.addEventListener("click", ()=>{ if(!state.verses.length) return; stopListening(false); if(state.currentVerseIdx>0){ state.currentVerseIdx--; state.myStats.last.verse=state.currentVerseIdx+1; saveLastPosition(); updateVerseText(); startListening(false); } });

  // ---------- Leaderboard (닉네임 > 이메일앞부분) ----------
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
