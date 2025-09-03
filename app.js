// =========================
// app.js — 말씀읽기APP v2 (최종)
// Firebase Auth + Firestore + 3줄 숫자 현황표(백/십/일) + 절/장 토글
// 읽음 진행률 저장 + 음성인식 + 본문 매칭(유사도 기반 자동·무난 진행)
// =========================
(function () {
  'use strict';

  // ---------- 유틸 ----------
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
  const log = (...a) => console.log('[APP]', ...a);
  const BOUND = new WeakSet();

  // ✅ [추가] 성경 버전 문서 ID 한 곳에서 관리 (필수 최소 수정)
  const VERSION_ID = '개역한글'; // Firestore: bible/{여기}/books/...

  // (선택) 아주 얇은 안전 가드: 비어있을 때 사용자에게 보이는 한 줄 안내에만 사용
  const EMPTY_LABEL_BOOKS = '책 데이터가 없습니다 (bible/'+VERSION_ID+'/books 확인)';
  const EMPTY_LABEL_CHAPS = '장 데이터가 없습니다';

  // ---------- Firebase 초기화 ----------
  try {
    const cfg = (window && (window.firebaseConfig || window.FIREBASE_CONFIG || window.firebase_config)) || (typeof firebaseConfig !== 'undefined' ? firebaseConfig : null);
    if (!cfg) console.warn('firebaseConfig가 감지되지 않았습니다. firebaseConfig.js 로딩 순서를 확인하세요.');
    if (!firebase.apps.length) { firebase.initializeApp(cfg || {}); log('Firebase initialized'); }
    else { log('Firebase already initialized'); }
  } catch (err) { console.error('Firebase 초기화 오류:', err); }

  const auth = firebase.auth();
  const db   = firebase.firestore();

  // ---------- 요소 ----------
  const views = {
    auth: $('#authView') || $('[data-view="auth"]'),
    app:  $('#appView')  || $('[data-view="app"]'),
  };
  const els = {
    // 인증
    email: $('#email') || $('#loginEmail') || $('#signupEmail'),
    password: $('#password') || $('#loginPassword') || $('#signupPassword'),
    signupEmail: $('#signupEmail') || $('#email'),
    signupPassword: $('#signupPassword') || $('#password'),
    signupBtn: $('#signupBtn') || $('[data-action="signup"]'),
    loginBtn:  $('#loginBtn')  || $('[data-action="login"]'),
    logoutBtn: $('#logoutBtn') || $('[data-action="logout"]'),
    signupForm: $('#signupForm') || $('form[data-form="signup"]'),
    loginForm:  $('#loginForm')  || $('form[data-form="login"]'),
    userEmail: $('#userEmail'),
    welcome:   $('#welcomeText'),

    // 뷰어
    bookSelect: $('#bookSelect'),
    chapterSelect: $('#chapterSelect'),
    passageText: $('#passageText'),
    statusBoard: $('#statusBoard'),
    digitGrid: $('#digitGrid'),

    // 모드
    modeChapter: $('#modeChapter'),
    modeVerse:   $('#modeVerse'),

    // 음성/매칭
    micBtn: $('#micBtn'),
    asrText: $('#asrText'),
    autoAdv: $('#autoAdvance'),
    matchInfo: $('#matchInfo'),
    softAdv: $('#softAdvanceBtn'),
  };

  // ---------- 상태 ----------
  const state = {
    mode: 'chapter',              // 'chapter' | 'verse'
    currentVersesCount: 0,
    versesReadSet: new Set(),     // 현재 장의 읽은 절
    userId: null,
    saving: false,
    currentVersePtr: 1,           // 자동 진행 기준 포인터(절번호)
    match: {                      // 매칭 기준
      PASS: 0.78,                 // 자동 진행
      SOFT: 0.65,                 // 무난 진행 버튼 권장
      windowBack: 0,              // 현재절에서 뒤로 허용
      windowFwd: 2,               // 앞으로 허용
    }
  };

  // ---------- 에러 문구 ----------
  const errorText = (code, msg) => ({
    'auth/invalid-email':'이메일 형식이 올바르지 않습니다.',
    'auth/email-already-in-use':'이미 가입된 이메일입니다.',
    'auth/weak-password':'비밀번호가 너무 약합니다(최소 6자 이상 권장).',
    'auth/user-not-found':'가입된 사용자가 없습니다.',
    'auth/wrong-password':'비밀번호가 올바르지 않습니다.',
    'auth/too-many-requests':'요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
  }[code] || (msg || '알 수 없는 오류가 발생했습니다.'));

  // ---------- UI 토글 ----------
  function show(view){
    if (views.auth) views.auth.classList.add('hidden');
    if (views.app)  views.app.classList.add('hidden');
    if (view && view.classList) view.classList.remove('hidden');
  }

  // ---------- 사용자 문서 ----------
  async function ensureUserDoc(user){
    if (!user) return;
    const ref = db.collection('users').doc(user.uid);
    const snap = await ref.get();
    if (!snap.exists){
      await ref.set({
        uid:user.uid, email:user.email||null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        displayName:user.displayName||null,
        provider:(user.providerData?.[0]?.providerId)||'password',
      });
      log('사용자 문서 생성');
    }
  }

  // ---------- 진행도 저장/로드 ----------
  function progressDocRef(book, chapter){
    if (!state.userId) return null;
    return db.collection('users').doc(state.userId)
             .collection('progress').doc(`${book}-${chapter}`);
  }
  async function loadProgress(book, chapter){
    state.versesReadSet = new Set();
    const ref = progressDocRef(book, chapter); if (!ref) return;
    const snap = await ref.get(); const data = snap.data();
    if (data?.readVerses) data.readVerses.forEach(v => state.versesReadSet.add(String(v)));
  }
  let _saveTimer = null;
  function saveProgressDebounced(book, chapter){
    clearTimeout(_saveTimer); _saveTimer = setTimeout(()=>saveProgress(book, chapter), 400);
  }
  async function saveProgress(book, chapter){
    const ref = progressDocRef(book, chapter); if (!ref) return;
    const arr = Array.from(state.versesReadSet).sort((a,b)=>Number(a)-Number(b));
    state.saving = true;
    try{
      await ref.set({ readVerses:arr, updatedAt:firebase.firestore.FieldValue.serverTimestamp() }, {merge:true});
    } finally { state.saving = false; }
  }

  // ---------- 성경 불러오기 ----------
  // ✅ [수정] '개역한글' → VERSION_ID 로만 변경 + 아주 얇은 빈 결과 안내
  async function loadBibleBooks(){
    try {
      const snap = await db.collection('bible').doc(VERSION_ID).collection('books').get();
      els.bookSelect.innerHTML = '';
      if (snap.empty) {
        const opt = document.createElement('option');
        opt.value = ''; opt.textContent = EMPTY_LABEL_BOOKS;
        els.bookSelect.appendChild(opt);
        return;
      }
      snap.forEach(doc=>{
        const opt = document.createElement('option'); opt.value = doc.id; opt.textContent = doc.id;
        els.bookSelect.appendChild(opt);
      });
      await fillChapters();
    } catch (e) {
      console.error('loadBibleBooks 오류:', e);
      els.bookSelect.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = '불러오기 오류 (콘솔 확인)';
      els.bookSelect.appendChild(opt);
    }
  }

  // ✅ [수정] '개역한글' → VERSION_ID 로만 변경 + 빈 결과 한 줄 안내
  async function fillChapters(){
    const book = els.bookSelect?.value; if (!book) return;
    try {
      const snap = await db.collection('bible').doc(VERSION_ID).collection('books').doc(book).collection('chapters').get();
      const chapterIds = snap.docs.map(d=>d.id).sort((a,b)=>Number(a)-Number(b));
      if (els.chapterSelect){
        els.chapterSelect.innerHTML = '';
        if (chapterIds.length === 0) {
          const opt = document.createElement('option'); opt.value = ''; opt.textContent = EMPTY_LABEL_CHAPS;
          els.chapterSelect.appendChild(opt);
          renderStatusBoard(0);
          return;
        }
        chapterIds.forEach(id=>{
          const opt = document.createElement('option'); opt.value = id; opt.textContent = `${id}장`;
          els.chapterSelect.appendChild(opt);
        });
      }
      if (state.mode==='chapter') renderStatusBoard(chapterIds.length);
    } catch (e) {
      console.error('fillChapters 오류:', e);
      if (els.chapterSelect){
        els.chapterSelect.innerHTML = '';
        const opt = document.createElement('option'); opt.value = ''; opt.textContent = '장 불러오기 오류';
        els.chapterSelect.appendChild(opt);
      }
      renderStatusBoard(0);
    }
  }

  // ✅ [수정] 본문 조회 경로의 '개역한글' → VERSION_ID 만 변경 (기능 동일)
  async function renderPassage(){
    if (!els.bookSelect || !els.chapterSelect || !els.passageText) return;
    const book = els.bookSelect.value, chapter = els.chapterSelect.value; if (!book || !chapter) return;

    const doc = await db.collection('bible').doc(VERSION_ID).collection('books').doc(book).collection('chapters').doc(chapter).get();
    const verses = doc.data()?.verses || {};

    await loadProgress(book, chapter);

    const verseNums = Object.keys(verses).sort((a,b)=>Number(a)-Number(b));
    state.currentVersesCount = verseNums.length;

    const frag = document.createDocumentFragment();
    verseNums.forEach(n=>{
      const line = document.createElement('div');
      line.id = `v-${n}`; line.style.padding = '6px 0'; line.style.scrollMarginTop = '96px';
      line.innerText = `${n}. ${verses[n]}`;
      frag.appendChild(line);
    });
    els.passageText.innerHTML = ''; els.passageText.appendChild(frag);

    // 포인터 리셋(장 이동 시 1절로)
    state.currentVersePtr = verseNums.length ? Number(verseNums[0]) : 1;

    if (state.mode==='verse') renderStatusBoard(state.currentVersesCount);
    syncStatusActive();
  }

  // ---------- 현황표(3줄 숫자: 백/십/일) ----------
  function splitHTO(n){
    const s = String(n).padStart(3,'0');
    return { h:s[0], t:s[1], o:s[2] };
  }
  function renderStatusBoard(total){
    if (!els.digitGrid) return;
    els.digitGrid.innerHTML = '';
    const isVerseMode = state.mode==='verse';

    for (let n=1; n<=total; n++){
      const {h,t,o} = splitHTO(n);
      const btn = document.createElement('button');
      btn.className = 'digit-btn'; btn.type='button';
      btn.setAttribute(isVerseMode ? 'data-verse':'data-chapter', String(n));
      btn.setAttribute('aria-label', isVerseMode ? `${n}절 바로가기` : `${n}장 바로가기`);

      const top=document.createElement('div'); top.className='digit-line top'; top.textContent=h;
      const mid=document.createElement('div'); mid.className='digit-line mid'; mid.textContent=t;
      const bot=document.createElement('div'); bot.className='digit-line bottom'; bot.textContent=o;
      btn.append(top, mid, bot);

      if (isVerseMode && state.versesReadSet.has(String(n))) btn.classList.add('read');
      if (!isVerseMode && String(n)===(els.chapterSelect?.value||'')) btn.classList.add('active');

      btn.addEventListener('click', async ()=>{
        if (isVerseMode){
          const num = String(n);
          if (state.versesReadSet.has(num)){ state.versesReadSet.delete(num); btn.classList.remove('read'); }
          else { state.versesReadSet.add(num); btn.classList.add('read'); }
          saveProgressDebounced(els.bookSelect.value, els.chapterSelect.value);

          // 포인터 이동 & 스크롤
          state.currentVersePtr = n;
          const target = document.getElementById(`v-${num}`);
          if (target) target.scrollIntoView({behavior:'smooth', block:'start'});
        } else {
          if (els.chapterSelect) els.chapterSelect.value = String(n);
          els.digitGrid.querySelectorAll('.digit-btn.active').forEach(b=>b.classList.remove('active'));
          btn.classList.add('active');
          await renderPassage();
          const box = $('#passageBox'); if (box && box.scrollIntoView) box.scrollIntoView({behavior:'smooth', block:'start'});
        }
      });

      els.digitGrid.appendChild(btn);
    }
  }
  function syncStatusActive(){
    if (!els.digitGrid) return;
    if (state.mode==='chapter'){
      const val = els.chapterSelect?.value || '';
      els.digitGrid.querySelectorAll('.digit-btn').forEach(btn=>{
        btn.classList.toggle('active', btn.getAttribute('data-chapter')===val);
      });
    } else {
      els.digitGrid.querySelectorAll('.digit-btn').forEach(btn=>{
        const v = btn.getAttribute('data-verse'); if (!v) return;
        btn.classList.toggle('read', state.versesReadSet.has(v));
      });
    }
  }

  // ---------- 음성 인식 (Web Speech API) ----------
  let recognition=null, recognizing=false, pendingSoftAdvance=null;

  function ensureRecognition(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const rec = new SR();
    rec.lang='ko-KR'; rec.interimResults=true; rec.continuous=false; rec.maxAlternatives=5;
    return rec;
  }
  function setMicVisual(on){
    if (!els.micBtn) return;
    els.micBtn.classList.toggle('recording', !!on);
    els.micBtn.textContent = on ? '🛑 인식 중지' : '🎤 음성으로 찾기';
  }
  async function startASR(){
    if (recognizing) return;
    recognition = ensureRecognition();
    if (!recognition){ els.asrText && (els.asrText.textContent='이 브라우저는 음성 인식을 지원하지 않습니다. (크롬/엣지 권장)'); return; }

    recognizing=true; setMicVisual(true); els.asrText && (els.asrText.textContent='듣는 중…');

    recognition.onresult = async (e)=>{
      let finalText='', interim=''; let finals=[];
      for (let i=e.resultIndex;i<e.results.length;i++){
        const res=e.results[i];
        if (res.isFinal){
          finalText += res[0].transcript;
          finals = Array.from({length:Math.min(res.length,5)},(_,k)=>res[k]?.transcript).filter(Boolean);
        } else { interim += res[0].transcript; }
      }
      els.asrText && (els.asrText.textContent = finalText || interim);

      if (finals.length){
        await tryAutoAdvanceWithASR(finals);
        // 자동 진행 체크는 내부에서 처리(PASS는 자동, SOFT는 버튼 대기)
      }
    };
    recognition.onerror = (e)=>{ els.asrText && (els.asrText.textContent=`인식 오류: ${e.error||'unknown'}`); };
    recognition.onend = ()=>{ recognizing=false; setMicVisual(false); };

    recognition.start();
  }
  function stopASR(){ if (recognition && recognizing) recognition.stop(); }

  // ---------- 매칭 유틸 (정규화/유사도) ----------
  function normalizeBibleKR(s){
    if (!s) return '';
    return s
      .replace(/[“”"‘’'`]/g,'')
      .replace(/[.,!?;:·…、，。]/g,' ')
      .replace(/\(.*?\)|\[.*?\]/g,' ')
      .replace(/[\u3165-\u318F]/g,'')          // 호환자모
      .replace(/[^0-9A-Za-z가-힣\s]/g,' ')
      .replace(/\s+/g,' ').trim().toLowerCase();
  }
  const STOPWORDS = new Set(['은','는','이','가','을','를','에','에게','에서','으로','와','과','도','만','뿐','마다','보다','부터','까지']);
  const NUM_WORDS = {'영':0,'공':0,'한':1,'하나':1,'두':2,'둘':2,'세':3,'셋':3,'네':4,'넷':4,'다섯':5,'여섯':6,'일곱':7,'여덟':8,'아홉':9,'열':10};
  function koreanNumsToArabic(tokens){ return tokens.map(t => (t in NUM_WORDS) ? String(NUM_WORDS[t]) : t); }
  function tokenizeKR(s){
    const t = normalizeBibleKR(s).split(' ').filter(Boolean);
    const numFixed = koreanNumsToArabic(t);
    return numFixed.filter(x=>!STOPWORDS.has(x));
  }
  function levenshtein(a,b){
    const dp = Array(b.length+1).fill(0).map((_,i)=>i);
    for (let i=1;i<=a.length;i++){
      let prev=i-1; dp[0]=i;
      for (let j=1;j<=b.length;j++){
        const tmp=dp[j];
        dp[j] = (a[i-1]===b[j-1]) ? prev : 1+Math.min(prev, dp[j-1], dp[j]);
        prev=tmp;
      }
    }
    return dp[b.length];
  }
  function tokenSimilarity(aStr,bStr){
    const A=tokenizeKR(aStr), B=tokenizeKR(bStr);
    if (!A.length||!B.length) return 0;
    const dist=levenshtein(A,B); const wer=dist/Math.max(A.length,B.length);
    return 1-wer; // 0~1
  }

  function buildVerseWindowTexts(book, chapter, startVerse, count=3){
    const texts=[]; let cur=startVerse;
    for (let span=1; span<=count; span++){
      const parts=[];
      for (let k=0;k<span;k++){
        const el = document.getElementById(`v-${cur+k}`); if (!el) break;
        parts.push(el.innerText.replace(/^\d+\.\s*/, ''));
      }
      if (parts.length) texts.push({ start:startVerse, span:parts.length, text:parts.join(' ') });
    }
    return texts;
  }

  async function tryAutoAdvanceWithASR(finalTexts){
    const book=els.bookSelect?.value, chapter=els.chapterSelect?.value; if (!book||!chapter) return;
    const ptr = state.currentVersePtr || 1;

    const cand=[];
    for (let v=ptr - state.match.windowBack; v<=ptr + state.match.windowFwd; v++){
      if (v<1) continue;
      const variants = buildVerseWindowTexts(book, chapter, v, 3);
      for (const w of variants){
        for (const hyp of finalTexts){
          const score = tokenSimilarity(hyp, w.text);
          cand.push({verse:v, span:w.span, hyp, score});
        }
      }
    }
    cand.sort((x,y)=>y.score-x.score);
    const best=cand[0];

    if (els.matchInfo){
      const pct = best ? Math.round(best.score*100) : 0;
      els.matchInfo.textContent = `유사도: ${pct}% (${best ? `${best.verse}~${best.verse+best.span-1}절` : '-'})`;
    }

    if (!best) return;

    if (best.score >= state.match.PASS){
      await markVersesReadAndAdvance(book, chapter, best.verse, best.span);
      pendingSoftAdvance = null;
      els.softAdv && (els.softAdv.disabled = true);
    } else if (best.score >= state.match.SOFT){
      pendingSoftAdvance = {book, chapter, verse:best.verse, span:best.span};
      els.softAdv && (els.softAdv.disabled = false);
    } else {
      els.asrText && (els.asrText.textContent += '  (다시 또박또박 읽어주세요)');
    }
  }

  async function markVersesReadAndAdvance(book, chapter, startVerse, span){
    for (let v=startVerse; v<startVerse+span; v++){
      state.versesReadSet.add(String(v));
    }
    saveProgressDebounced(book, chapter);

    const next = startVerse + span;
    state.currentVersePtr = next;

    const target = document.getElementById(`v-${next}`);
    if (target) target.scrollIntoView({behavior:'smooth', block:'start'});

    if (state.mode==='verse') syncStatusActive();
  }

  // ---------- 이벤트 바인딩 ----------
  function bindSafely(el, ev, fn){ if (!el||BOUND.has(el)) return; on(el, ev, fn); BOUND.add(el); }
  function wireEvents(){
    // 인증
    bindSafely(els.signupBtn,'click',handleSignup);
    bindSafely(els.loginBtn,'click',handleLogin);
    bindSafely(els.logoutBtn,'click',handleLogout);
    bindSafely(els.signupForm,'submit',handleSignup);
    bindSafely(els.loginForm,'submit',handleLogin);

    // 권/장
    bindSafely(els.bookSelect,'change', async ()=>{ await fillChapters(); await renderPassage(); });
    bindSafely(els.chapterSelect,'change', async ()=>{ await renderPassage(); syncStatusActive(); state.currentVersePtr=1; });

    // 모드 토글
    bindSafely(els.modeChapter,'click', async ()=>{
      state.mode='chapter';
      els.modeChapter.classList.add('active'); els.modeChapter.setAttribute('aria-pressed','true');
      els.modeVerse.classList.remove('active'); els.modeVerse.setAttribute('aria-pressed','false');
      await fillChapters(); syncStatusActive();
    });
    bindSafely(els.modeVerse,'click', async ()=>{
      state.mode='verse';
      els.modeVerse.classList.add('active'); els.modeVerse.setAttribute('aria-pressed','true');
      els.modeChapter.classList.remove('active'); els.modeChapter.setAttribute('aria-pressed','false');
      await renderPassage(); // 절 수 반영 → 현황표 갱신
    });

    // 음성
    bindSafely(els.micBtn,'click', ()=>{ recognizing ? stopASR() : startASR(); });

    // 무난 진행 버튼
    bindSafely(els.softAdv,'click', async ()=>{
      if (!pendingSoftAdvance) return;
      const {book, chapter, verse, span} = pendingSoftAdvance;
      await markVersesReadAndAdvance(book, chapter, verse, span);
      pendingSoftAdvance=null; els.softAdv.disabled=true;
    });

    // data-action 여분 버튼 대응
    $$('[data-action="signup"]').forEach(b=>bindSafely(b,'click',handleSignup));
    $$('[data-action="login"]').forEach(b=>bindSafely(b,'click',handleLogin));
    $$('[data-action="logout"]').forEach(b=>bindSafely(b,'click',handleLogout));

    log('이벤트 바인딩 완료');
  }
  if (document.readyState==='loading') on(document,'DOMContentLoaded',wireEvents,{once:true}); else wireEvents();

  // ---------- 인증 액션 ----------
  async function handleSignup(e){
    if (e) e.preventDefault();
    const form=els.signupForm||document;
    const email=(els.signupEmail?.value?.trim())||(form.querySelector('#signupEmail')?.value?.trim())||'';
    const password=(els.signupPassword?.value)||(form.querySelector('#signupPassword')?.value)||'';
    try{
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw {code:'auth/invalid-email'};
      if (!password || password.length<6) throw {code:'auth/weak-password'};
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      log('회원가입 완료', cred.user?.uid);
    } catch(err){ alert(errorText(err.code, err.message)); console.error('회원가입 오류:', err); }
  }
  async function handleLogin(e){
    if (e) e.preventDefault();
    const form=els.loginForm||document;
    const email=(els.email?.value?.trim())||(form.querySelector('#loginEmail')?.value?.trim())||'';
    const password=(els.password?.value)||(form.querySelector('#loginPassword')?.value)||'';
    try{
      const cred = await auth.signInWithEmailAndPassword(email, password);
      log('로그인 완료', cred.user?.uid);
    } catch(err){ alert(errorText(err.code, err.message)); console.error('로그인 오류:', err); }
  }
  async function handleLogout(e){
    if (e) e.preventDefault();
    try{ await auth.signOut(); log('로그아웃 완료'); }
    catch(err){ alert('로그아웃 실패: '+(err.message||'알 수 없는 오류')); }
  }

  // ---------- 인증 상태 ----------
  auth.onAuthStateChanged( async (user)=>{
    if (user){
      state.userId = user.uid; await ensureUserDoc(user);
      if (els.userEmail) els.userEmail.textContent = user.email || user.displayName || '(알 수 없음)';
      if (els.welcome) els.welcome.textContent = '샬롬! 말씀읽기를 시작해볼까요?';
      show(views.app||document.body);

      await loadBibleBooks();
      await fillChapters();
      await renderPassage();
      syncStatusActive();
    } else {
      state.userId=null; show(views.auth||document.body);
    }
  });

})();
