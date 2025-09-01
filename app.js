/* 말씀읽기APP — bible.json 스키마:
  {
    "창세기": { "1": { "1": "태초에…", "2": "…" }, "2": {...} },
    ...
    "요한계시록": { "22": {...} }
  }
*/
(() => {
  // ===================== Firebase =====================
  let app, auth, db, user;

  function initFirebase() {
    if (typeof firebase === "undefined") {
      console.error("[Firebase] SDK 미로드");
      return;
    }
    if (!window.firebaseConfig) {
      console.error("[Firebase] window.firebaseConfig 누락");
      return;
    }
    try {
      app = firebase.initializeApp(window.firebaseConfig);
      auth = firebase.auth();
      db   = firebase.firestore();
      console.log("[Firebase] 초기화 OK");
    } catch (e) {
      console.error("[Firebase] 초기화 실패:", e);
    }
  }
  initFirebase();

  // ===================== DOM Refs =====================
  const els = {
    // auth/ui
    signedOut: document.getElementById('signedOut'),
    signedIn: document.getElementById('signedIn'),
    btnGoogle: document.getElementById('btnGoogle'),
    btnAnon: document.getElementById('btnAnon'),
    btnSignOut: document.getElementById('btnSignOut'),
    userName: document.getElementById('userName'),
    userPhoto: document.getElementById('userPhoto'),

    // selectors
    bookSelect: document.getElementById('bookSelect'),
    chapterGrid: document.getElementById('chapterGrid'),
    verseGrid: document.getElementById('verseGrid'),

    // reader
    verseText: document.getElementById('verseText'),
    verseCount: document.getElementById('verseCount'),
    locLabel: document.getElementById('locLabel'),
    btnPrevVerse: document.getElementById('btnPrevVerse'),
    btnNextVerse: document.getElementById('btnNextVerse'),
    btnToggleMic: document.getElementById('btnToggleMic'),
    listenHint: document.getElementById('listenHint'),
    autoAdvance: document.getElementById('autoAdvance'),

    // stats/leaderboard
    myStats: document.getElementById('myStats'),
    leaderList: document.getElementById('leaderList'),
    resumeInfo: document.getElementById('resumeInfo'),

    // matrix modal
    btnProgressMatrix: document.getElementById('btnProgressMatrix'),
    btnCloseMatrix: document.getElementById('btnCloseMatrix'),
    matrixModal: document.getElementById('matrixModal'),
    matrixWrap: document.getElementById('matrixWrap')
  };

  // ===================== State =====================
  const state = {
    bible: null,
    currentBookKo: null,       // "창세기"
    currentChapter: null,      // number
    verses: [],                // string[]
    currentVerseIdx: 0,        // number
    listening: false,
    recog: null,
    progress: {},              // { [bookId]: { readChapters: Set<number> } }
    myStats: {versesRead:0, chaptersRead:0, last:{bookKo:null, chapter:null, verse:0}}
  };
  const BOOKS = window.BOOKS || [];
  const getBookByKo = (ko) => BOOKS.find(b => b.ko === ko);

  // ===================== Load bible.json =====================
  async function loadBible() {
    try {
      const res = await fetch('bible.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error("bible.json not found");
      state.bible = await res.json();
    } catch (e) {
      console.error("[bible.json] 로딩 실패:", e);
      els.verseText.innerHTML = `<span class="muted">루트에 <code>bible.json</code> 필요. 스키마: {"창세기":{"1":{"1":"..."}}}</span>`;
    }
  }
  loadBible();

  // ===================== Auth UI helpers =====================
  function uiSignedIn(u) {
    els.signedOut.classList.add('hidden');
    els.signedIn.classList.remove('hidden');
    els.userName.textContent = u.displayName || "익명 사용자";
    els.userPhoto.src = u.photoURL || "https://avatars.githubusercontent.com/u/9919?s=200&v=4";
  }
  function uiSignedOut() {
    els.signedIn.classList.add('hidden');
    els.signedOut.classList.remove('hidden');
  }

  // ===================== Auth Handlers (Redirect 전용) =====================
  auth?.getRedirectResult?.()
    .then(r => { if (r?.user) console.log("[Auth] redirect success:", r.user.uid); })
    .catch(e => console.warn("[Auth] getRedirectResult error:", e));

  els.btnGoogle?.addEventListener('click', () => {
    if (!auth) return alert("Firebase 초기화 실패");
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithRedirect(provider);
  });
  els.btnAnon?.addEventListener('click', () => auth?.signInAnonymously());
  els.btnSignOut?.addEventListener('click', () => auth?.signOut());

  auth?.onAuthStateChanged(async (u) => {
    user = u;
    if (!u) { uiSignedOut(); clearUI(); return; }

    uiSignedIn(u);
    try { await ensureUserDoc(u); } catch(e){ console.warn("[ensureUserDoc]", e); }
    try { await loadMyStats(); } catch(e){ console.warn("[loadMyStats]", e); }

    try { buildBookSelect(); } catch(e){ console.error("[buildBookSelect]", e); }
    try { loadLeaderboard(); } catch(e){ console.warn("[loadLeaderboard]", e); }

    if (state.myStats?.last?.bookKo && state.myStats?.last?.chapter) {
      const {bookKo, chapter} = state.myStats.last;
      els.resumeInfo.textContent = `마지막 위치: ${bookKo} ${chapter}장`;
    } else {
      els.resumeInfo.textContent = "";
    }
  });

  async function ensureUserDoc(u){
    if (!db) return;
    const ref = db.collection("users").doc(u.uid);
    await ref.set({
      displayName: u.displayName || "익명",
      photoURL: u.photoURL || "",
      versesRead: firebase.firestore.FieldValue.increment(0),
      chaptersRead: firebase.firestore.FieldValue.increment(0),
      last: state.myStats.last || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, {merge:true});
  }

  async function loadMyStats(){
    if (!db || !user) return;
    let snap;
    try {
      snap = await db.collection("users").doc(user.uid).get();
    } catch (e) {
      console.warn('users/{uid} 읽기 실패(규칙?):', e);
      return;
    }
    if (snap?.exists){
      const d = snap.data();
      state.myStats.versesRead = d.versesRead || 0;
      state.myStats.chaptersRead = d.chaptersRead || 0;
      state.myStats.last = d.last || {bookKo:null, chapter:null, verse:0};
      els.myStats.textContent = `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`;
    }
    // per-book progress
    const p = {};
    try {
      const qs = await db.collection("users").doc(user.uid).collection("progress").get();
      qs.forEach(doc => { p[doc.id] = {readChapters: new Set((doc.data().readChapters)||[])}; });
    } catch (e) { console.warn('progress 읽기 실패:', e); }
    state.progress = p;
  }

  async function saveLastPosition(){
    if (!db || !user) return;
    try {
      await db.collection("users").doc(user.uid).set({
        last: state.myStats.last,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, {merge:true});
    } catch(e){ console.warn("saveLastPosition 실패:", e); }
  }

  async function markChapterDone(bookId, chapter){
    if (!state.progress[bookId]) state.progress[bookId] = {readChapters:new Set()};
    state.progress[bookId].readChapters.add(chapter);
    if (db && user){
      try {
        await db.collection("users").doc(user.uid).collection("progress").doc(bookId)
          .set({readChapters: Array.from(state.progress[bookId].readChapters)}, {merge:true});
        await db.collection("users").doc(user.uid)
          .set({chaptersRead: firebase.firestore.FieldValue.increment(1),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()}, {merge:true});
        state.myStats.chaptersRead += 1;
        els.myStats.textContent = `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`;
        buildChapterGrid();
        buildMatrix();
      } catch(e){ console.warn("markChapterDone 실패:", e); }
    }
  }

  async function incVersesRead(n=1){
    state.myStats.versesRead += n;
    els.myStats.textContent = `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`;
    if (db && user){
      try {
        await db.collection("users").doc(user.uid)
          .set({versesRead: firebase.firestore.FieldValue.increment(n),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()}, {merge:true});
      } catch(e){ console.warn("incVersesRead 실패:", e); }
    }
  }

  // ===================== UI builders =====================
  function clearUI(){
    els.bookSelect.innerHTML = "";
    els.chapterGrid.innerHTML = "";
    els.verseGrid.innerHTML = "";
    els.verseText.textContent = "로그인 후 사용하세요.";
    els.leaderList.innerHTML = "";
    els.myStats.textContent = "—";
    els.locLabel.textContent = "";
    els.verseCount.textContent = "";
    state.currentBookKo = null;
    state.currentChapter = null;
    state.verses = [];
    state.currentVerseIdx = 0;
  }

  function buildBookSelect(){
    els.bookSelect.innerHTML = "";
    for (const b of BOOKS){
      const opt = document.createElement('option');
      opt.value = b.ko; opt.textContent = b.ko;
      els.bookSelect.appendChild(opt);
    }
    const last = state.myStats?.last;
    if (last?.bookKo){
      els.bookSelect.value = last.bookKo;
      state.currentBookKo = last.bookKo;
      buildChapterGrid();
      if (last.chapter){
        selectChapter(last.chapter).then(()=>{
          if (Number.isInteger(last.verse)){
            state.currentVerseIdx = Math.max(0, (last.verse||1)-1);
            updateVerseText();
          }
        });
      }
    } else {
      els.bookSelect.value = BOOKS[0]?.ko || "";
      state.currentBookKo = els.bookSelect.value;
      buildChapterGrid();
    }
  }

  function buildChapterGrid(){
    const b = getBookByKo(state.currentBookKo); if (!b) return;
    els.chapterGrid.innerHTML = "";
    for (let i=1;i<=b.ch;i++){
      const btn = document.createElement('button');
      btn.className = "chip" + (state.progress[b.id]?.readChapters?.has(i) ? " done" : "");
      btn.textContent = i;
      btn.addEventListener('click', () => selectChapter(i));
      if (state.currentChapter === i) btn.classList.add('active');
      els.chapterGrid.appendChild(btn);
    }
  }

  function buildVerseGrid(){
    els.verseGrid.innerHTML = "";
    for (let i=1;i<=state.verses.length;i++){
      const btn = document.createElement('button');
      btn.className = "chip"; btn.textContent = i;
      btn.addEventListener('click', () => {
        state.currentVerseIdx = i-1;
        updateVerseText();
        state.myStats.last.verse = i;
        saveLastPosition();
      });
      if (state.currentVerseIdx === i-1) btn.classList.add('active');
      els.verseGrid.appendChild(btn);
    }
  }

  els.bookSelect?.addEventListener('change', () => {
    state.currentBookKo = els.bookSelect.value;
    state.currentChapter = null; state.verses = []; state.currentVerseIdx = 0;
    els.verseGrid.innerHTML = ""; els.verseText.textContent = "장과 절을 선택하세요.";
    buildChapterGrid();
    state.myStats.last = {bookKo: state.currentBookKo, chapter: null, verse: 0};
    saveLastPosition();
  });

  // ===================== Chapter/Verse load =====================
  async function selectChapter(chapter){
    state.currentChapter = chapter;
    state.currentVerseIdx = 0;
    const b = getBookByKo(state.currentBookKo);
    els.locLabel.textContent = `${b?.ko||""} ${chapter}장`;
    els.verseText.textContent = "로딩 중…";

    if (!state.bible) {
      await loadBible();
      if (!state.bible) { els.verseText.innerHTML = `<span class="muted">bible.json 로딩 실패</span>`; return; }
    }
    const bookData = state.bible[state.currentBookKo];
    const chObj = bookData ? bookData[String(chapter)] : null;
    if (!chObj){
      els.verseText.innerHTML = `<span class="muted">${b.ko} ${chapter}장 본문 없음</span>`;
      els.verseCount.textContent = "";
      els.verseGrid.innerHTML = "";
      return;
    }
    const entries = Object.entries(chObj)
      .map(([k,v]) => [parseInt(k,10), String(v)])
      .sort((a,b)=>a[0]-b[0]);
    state.verses = entries.map(e=>e[1]);

    els.verseCount.textContent = `(${state.verses.length}절)`;
    buildVerseGrid();
    updateVerseText();
    state.myStats.last = {bookKo: b.ko, chapter, verse: 1};
    saveLastPosition();
  }

  function updateVerseText(){
    const v = state.verses[state.currentVerseIdx] || "";
    els.locLabel.textContent = `${state.currentBookKo} ${state.currentChapter}장 ${state.currentVerseIdx+1}절`;
    els.verseText.innerHTML = "";
    for (let i=0;i<v.length;i++){
      const span=document.createElement('span');
      span.textContent=v[i];
      els.verseText.appendChild(span);
    }
    els.verseCount.textContent = `(${state.verses.length}절 중 ${state.currentVerseIdx+1}절)`;
    [...els.verseGrid.children].forEach((btn, idx) => btn.classList.toggle('active', idx===state.currentVerseIdx));
  }

  // ===================== Speech Recognition =====================
  const getRecognition = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR(); r.lang='ko-KR'; r.continuous=true; r.interimResults=true; return r;
  };
  function normalize(s){ return (s||"").replace(/[^\p{L}\p{N}\s]/gu," ").replace(/\s+/g," ").trim().toLowerCase(); }
  function matchedPrefixLen(target, spoken){
    const t=normalize(target), s=normalize(spoken); if(!s) return 0;
    let ti=0, si=0, cnt=0; while(ti<t.length && si<s.length){ if(t[ti]===s[si]){cnt++;ti++;si++;} else {si++;} }
    return Math.min(cnt, target.length);
  }
  function paintRead(prefixLen){
    const spans=els.verseText.childNodes;
    for(let i=0;i<spans.length;i++){ spans[i].classList.toggle('read', i<prefixLen); }
  }
  function onSpeechResult(evt){
    const v = state.verses[state.currentVerseIdx] || ""; let transcript="";
    for (const res of evt.results){ transcript += res[0].transcript + " "; }
    const pref = matchedPrefixLen(v, transcript); paintRead(pref);
    const ratio = pref / v.length;
    if (ratio >= 0.92 && !evt.results[evt.results.length-1].isFinal){ completeVerse(); }
  }
  async function completeVerse(){
    stopListening(false);
    await incVersesRead(1);
    const b = getBookByKo(state.currentBookKo);
    if (els.autoAdvance?.checked){
      if (state.currentVerseIdx < state.verses.length-1){
        state.currentVerseIdx++;
        state.myStats.last.verse = state.currentVerseIdx+1;
        saveLastPosition();
        updateVerseText();
        startListening(false);
      } else {
        await markChapterDone(b.id, state.currentChapter);
        state.myStats.last.verse=0; state.myStats.last.chapter=state.currentChapter;
        saveLastPosition();
        alert("장 완료! 다음 장으로 이동하세요.");
      }
    }
  }
  function startListening(showAlert=true){
    if (state.listening) return;
    state.recog = getRecognition();
    if (!state.recog){
      els.listenHint.innerHTML="⚠️ 이 브라우저는 음성인식을 지원하지 않습니다.";
      if (showAlert) alert("데스크톱 Chrome을 권장합니다.");
      return;
    }
    state.recog.onresult = onSpeechResult;
    state.recog.onend = () => { if (state.listening){ try{ state.recog.start(); }catch(_){}} };
    try {
      state.recog.start();
      state.listening=true;
      els.btnToggleMic.textContent="⏹️ 음성인식 정지";
    } catch(e){ alert("음성인식 시작 실패: "+e.message); }
  }
  function stopListening(resetBtn=true){
    if (state.recog){ try{ state.recog.onresult=null; state.recog.onend=null; state.recog.stop(); }catch(_){ } }
    state.listening=false;
    if (resetBtn) els.btnToggleMic.textContent="🎙️ 음성인식 시작";
  }
  els.btnToggleMic?.addEventListener('click', ()=>{ if(!state.listening) startListening(); else stopListening(); });
  els.btnNextVerse?.addEventListener('click', ()=>{ if(!state.verses.length) return; stopListening(false); if(state.currentVerseIdx<state.verses.length-1){ state.currentVerseIdx++; updateVerseText(); startListening(false); } });
  els.btnPrevVerse?.addEventListener('click', ()=>{ if(!state.verses.length) return; stopListening(false); if(state.currentVerseIdx>0){ state.currentVerseIdx--; updateVerseText(); startListening(false); } });

  // ===================== Leaderboard & Matrix =====================
  async function loadLeaderboard(){
    if (!db) return;
    let qs;
    try {
      qs = await db.collection("users").orderBy("versesRead","desc").limit(20).get();
    } catch (e) { console.warn('리더보드 로드 실패:', e); return; }
    const list=[]; qs.forEach(doc=>list.push({id:doc.id, ...doc.data()}));
    els.leaderList.innerHTML="";
    list.forEach((u,idx)=>{
      const li=document.createElement('li');
      const name=u.displayName||"익명";
      li.innerHTML = `<strong>${idx+1}위</strong> ${name} · 절 ${Number(u.versesRead||0).toLocaleString()} · 장 ${Number(u.chaptersRead||0).toLocaleString()}`;
      els.leaderList.appendChild(li);
    });
  }

  function buildMatrix(){
    if (!user) return;
    const maxCh = Math.max(...BOOKS.map(b=>b.ch));
    const table=document.createElement('table'); table.className="matrix";
    const thead=document.createElement('thead'); const trh=document.createElement('tr');
    const th0=document.createElement('th'); th0.className="book"; th0.textContent="권/장"; trh.appendChild(th0);
    for(let c=1;c<=maxCh;c++){ const th=document.createElement('th'); th.textContent=String(c); trh.appendChild(th); }
    thead.appendChild(trh); table.appendChild(thead);
    const tbody=document.createElement('tbody');
    for (const b of BOOKS){
      const tr=document.createElement('tr');
      const th=document.createElement('th'); th.className="book"; th.textContent=b.ko; tr.appendChild(th);
      const read = state.progress[b.id]?.readChapters || new Set();
      for(let c=1;c<=maxCh;c++){
        const td=document.createElement('td');
        if (c<=b.ch){
          td.textContent=" ";
          td.style.background = read.has(c) ? "rgba(67,209,122,0.6)" : "rgba(120,120,140,0.25)";
          td.title=`${b.ko} ${c}장`;
        } else td.style.background="transparent";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    els.matrixWrap.innerHTML=""; els.matrixWrap.appendChild(table);
  }

  // ===================== Modal (robust) =====================
  function openMatrix(){
    buildMatrix();
    els.matrixModal.classList.add('show');
    els.matrixModal.classList.remove('hidden');
  }
  function closeMatrix(){
    els.matrixModal.classList.remove('show');
    els.matrixModal.classList.add('hidden');
  }
  els.btnProgressMatrix?.addEventListener('click', openMatrix);
  els.btnCloseMatrix?.addEventListener('click', (e)=>{ e?.preventDefault?.(); e?.stopPropagation?.(); closeMatrix(); });
  els.matrixModal?.addEventListener('click', (e)=>{
    const body = els.matrixModal.querySelector('.modal-body');
    if (!body || !e.target) return;
    if (!body.contains(e.target)) closeMatrix();
  });
  window.addEventListener('keydown', (e)=>{ if (e.key==='Escape' && els.matrixModal && els.matrixModal.classList.contains('show')) closeMatrix(); });
  // 위임 보강: 혹시 버튼 리스너가 로드 전 건너뛰었을 때
  document.addEventListener('click', (e)=>{
    const t=e.target;
    if (t && (t.id==='btnCloseMatrix' || t.closest?.('#btnCloseMatrix'))) {
      e.preventDefault(); e.stopPropagation(); closeMatrix();
    }
  });

})();
