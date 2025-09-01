/* 말씀읽기APP — 모바일 퍼스트 + PWA + 전화번호 인증(+82 자동) + bible.json */
(() => {
  // ---------- PWA ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js")
        .then(reg => console.log("[SW] registered:", reg.scope))
        .catch(err => console.warn("[SW] register failed:", err));
    });
  }

  // ---------- Firebase ----------
  let auth, db, user;
  let recaptchaVerifier = null;
  let confirmationResult = null;

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

  // ---------- Screen Routing ----------
  const scrLogin = document.getElementById("screen-login");
  const scrApp   = document.getElementById("screen-app");
  function showScreen(name) {
    if (name === "login") {
      scrLogin?.classList.add("show"); scrApp?.classList.remove("show");
    } else {
      scrApp?.classList.add("show"); scrLogin?.classList.remove("show");
    }
  }

  // ---------- DOM ----------
  const els = {
    displayName: document.getElementById("displayName"),
    phoneNumber: document.getElementById("phoneNumber"),
    btnSendCode: document.getElementById("btnSendCode"),
    recaptchaContainer: document.getElementById("recaptchaContainer"),
    codeArea: document.getElementById("codeArea"),
    smsCode: document.getElementById("smsCode"),
    btnVerifyCode: document.getElementById("btnVerifyCode"),

    signedIn: document.getElementById("signedIn"),
    userName: document.getElementById("userName"),
    userPhoto: document.getElementById("userPhoto"),
    btnSignOut: document.getElementById("btnSignOut"),

    bookSelect: document.getElementById("bookSelect"),
    chapterGrid: document.getElementById("chapterGrid"),
    verseGrid: document.getElementById("verseGrid"),
    verseText: document.getElementById("verseText"),
    locLabel: document.getElementById("locLabel"),
    verseCount: document.getElementById("verseCount"),
    myStats: document.getElementById("myStats"),
    leaderList: document.getElementById("leaderList"),

    btnProgressMatrix: document.getElementById("btnProgressMatrix"),
    btnCloseMatrix: document.getElementById("btnCloseMatrix"),
    matrixModal: document.getElementById("matrixModal"),
    matrixWrap: document.getElementById("matrixWrap"),

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
    pendingDisplayName:null
  };

  // ---------- bible.json ----------
  async function loadBible() {
    try {
      const res = await fetch("bible.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("bible.json not found");
      state.bible = await res.json();
    } catch (e) {
      console.error("[bible.json] 로딩 실패:", e);
      els.verseText && (els.verseText.textContent = "루트에 bible.json 파일이 필요합니다.");
    }
  }
  loadBible();

  // ---------- KR 번호 → E.164(+82) ----------
  function toKRE164(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, "");
    if (!digits) return null;
    if (digits.startsWith("82")) return "+" + digits;
    if (digits.startsWith("0")) return "+82" + digits.slice(1);
    if (digits.length >= 8 && digits.length <= 11) return "+82" + digits;
    return null;
  }

  // ---------- reCAPTCHA ----------
  function ensureRecaptcha() {
    if (recaptchaVerifier) return recaptchaVerifier;
    recaptchaVerifier = new firebase.auth.RecaptchaVerifier("recaptchaContainer", { size: "invisible" });
    return recaptchaVerifier;
  }

  // ---------- Phone Auth (+82 자동) ----------
  els.btnSendCode?.addEventListener("click", async () => {
    const name = (els.displayName?.value || "").trim();
    const phoneRaw = (els.phoneNumber?.value || "").trim();
    if (!name) { alert("표시이름을 입력하세요."); els.displayName?.focus(); return; }

    const e164 = toKRE164(phoneRaw);
    if (!e164) { alert("올바른 휴대폰 번호를 입력하세요. 예: 010-1234-5678"); els.phoneNumber?.focus(); return; }

    state.pendingDisplayName = name;
    try {
      const appVerifier = ensureRecaptcha();
      confirmationResult = await auth.signInWithPhoneNumber(e164, appVerifier);
      els.codeArea?.classList.remove("hidden");
      alert("인증코드를 문자로 보냈습니다.");
    } catch (e) {
      console.error("[Phone] send error:", e.code, e.message);
      alert("인증코드 전송 실패: " + e.message);
      try { recaptchaVerifier?.render().then(id => grecaptcha.reset(id)); } catch (_) {}
    }
  });

  els.btnVerifyCode?.addEventListener("click", async () => {
    if (!confirmationResult) { alert("먼저 인증코드를 받아주세요."); return; }
    const code = (els.smsCode?.value || "").trim();
    if (!code) { alert("인증코드를 입력하세요."); return; }
    try {
      const res = await confirmationResult.confirm(code);
      const u = res.user;
      if (state.pendingDisplayName) {
        try { await u.updateProfile({ displayName: state.pendingDisplayName }); } catch (e) {}
        try { await ensureUserDoc(u, state.pendingDisplayName); } catch (e) {}
      }
      els.smsCode.value = "";
      els.codeArea?.classList.add("hidden");
      state.pendingDisplayName = null;
    } catch (e) {
      console.error("[Phone] confirm error:", e.code, e.message);
      alert("인증코드 확인 실패: " + e.message);
    }
  });

  els.btnSignOut?.addEventListener("click", () => auth?.signOut());

  // ---------- Auth State ----------
  auth?.onAuthStateChanged(async (u) => {
    user = u;
    if (!u) { showScreen("login"); clearAppUI(); return; }

    showScreen("app");
    els.signedIn?.classList.remove("hidden");
    els.userName && (els.userName.textContent = u.displayName || u.phoneNumber || "전화 사용자");
    els.userPhoto && (els.userPhoto.src = u.photoURL || "https://avatars.githubusercontent.com/u/9919?s=200&v=4");

    try { await ensureUserDoc(u); } catch (e) {}
    try { await loadMyStats(); } catch (e) {}
    try { buildBookSelect(); } catch (e) {}
    try { loadLeaderboard(); } catch (e) {}
  });

  // ---------- Firestore helpers ----------
  async function ensureUserDoc(u, overrideName) {
    if (!db) return;
    const disp = overrideName || u.displayName || u.phoneNumber || "전화 사용자";
    const ref = db.collection("users").doc(u.uid);
    await ref.set({
      displayName: disp,
      photoURL: u.photoURL || "",
      versesRead: firebase.firestore.FieldValue.increment(0),
      chaptersRead: firebase.firestore.FieldValue.increment(0),
      last: state.myStats.last || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
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
        els.myStats && (els.myStats.textContent = `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
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
          .set({ chaptersRead: firebase.firestore.FieldValue.increment(1), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        state.myStats.chaptersRead += 1;
        els.myStats && (els.myStats.textContent = `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
        buildChapterGrid();
        buildMatrix();
      } catch (e) {}
    }
  }

  async function incVersesRead(n = 1) {
    state.myStats.versesRead += n;
    els.myStats && (els.myStats.textContent = `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
    if (db && user) {
      try {
        await db.collection("users").doc(user.uid)
          .set({ versesRead: firebase.firestore.FieldValue.increment(n), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
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
      els.bookSelect.value = BOOKS[0]?.ko || ""; state.currentBookKo = els.bookSelect.value; buildChapterGrid();
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
    els.locLabel && (els.locLabel.textContent = `${state.currentBookKo} ${state.currentChapter}장 ${state.currentVerseIdx + 1}절`);
    if (els.verseText) {
      els.verseText.innerHTML = "";
      for (let i = 0; i < v.length; i++) { const s=document.createElement("span"); s.textContent=v[i]; els.verseText.appendChild(s); }
    }
    els.verseCount && (els.verseCount.textContent = `(${state.verses.length}절 중 ${state.currentVerseIdx + 1}절)`);
    if (els.verseGrid) { [...els.verseGrid.children].forEach((btn, idx) => btn.classList.toggle("active", idx===state.currentVerseIdx)); }
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

  // ---------- Leaderboard ----------
  async function loadLeaderboard() {
    if (!db || !els.leaderList) return;
    let qs; try { qs = await db.collection("users").orderBy("versesRead","desc").limit(20).get(); } catch (e) { return; }
    const list=[]; qs.forEach(doc=>list.push({id:doc.id, ...doc.data()}));
    els.leaderList.innerHTML=""; list.forEach((u,idx)=>{ const li=document.createElement("li"); const name=u.displayName||"익명"; li.innerHTML=`<strong>${idx+1}위</strong> ${name} · 절 ${Number(u.versesRead||0).toLocaleString()} · 장 ${Number(u.chaptersRead||0).toLocaleString()}`; els.leaderList.appendChild(li); });
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
      for(let c=1;c<=maxCh;c++){ const td=document.createElement("td"); if(c<=b.ch){ td.textContent=" "; td.style.background = read.has(c) ? "rgba(67,209,122,0.6)" : "rgba(120,120,140,0.25)"; td.title=`${b.ko} ${c}장`; } else { td.style.background="transparent"; } tr.appendChild(td); }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    els.matrixWrap.innerHTML=""; els.matrixWrap.appendChild(table);
  }
  function openMatrix(){ buildMatrix(); els.matrixModal?.classList.add("show"); els.matrixModal?.classList.remove("hidden"); }
  function closeMatrix(){ els.matrixModal?.classList.remove("show"); els.matrixModal?.classList.add("hidden"); }
  els.btnProgressMatrix?.addEventListener("click", openMatrix);
  els.btnCloseMatrix?.addEventListener("click", (e)=>{ e?.preventDefault?.(); e?.stopPropagation?.(); closeMatrix(); });
  els.matrixModal?.addEventListener("click", (e)=>{ const body=els.matrixModal.querySelector(".modal-body"); if (!body || !e.target) return; if (!body.contains(e.target)) closeMatrix(); });
  window.addEventListener("keydown", (e)=>{ if (e.key==='Escape' && els.matrixModal?.classList.contains('show')) closeMatrix(); });

})();
