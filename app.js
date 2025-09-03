// =========================
// app.js — 이전 레이아웃 회귀 + 어절(단어) 단위 자동 진행 강화
// Firebase Auth + Firestore + 동그란 장 버튼 + 절수 + 본문 + 순위
// 진행도 저장(절 기준) 유지, 자동 진행은 '어절' 기준으로 세밀화
// =========================
(function () {
  'use strict';

  // ===== 설정 =====
  const VERSION_ID = '개역한글'; // ← Firestore bible/{여기}/books/... 실제 문서명으로 변경하세요.

  // ===== 유틸 =====
  const $ = (s, r=document)=>r.querySelector(s);
  const $$= (s, r=document)=>Array.from(r.querySelectorAll(s));
  const on= (el,ev,fn,op)=>el&&el.addEventListener(ev,fn,op);
  const log=(...a)=>console.log('[APP]',...a);
  const BOUND=new WeakSet();

  // ===== Firebase =====
  try{
    const cfg=(window.firebaseConfig||window.FIREBASE_CONFIG||window.firebase_config)||firebaseConfig||null;
    if(!firebase.apps.length) firebase.initializeApp(cfg||{});
  }catch(e){ console.error('Firebase init 오류:',e); }
  const auth=firebase.auth(), db=firebase.firestore();

  // ===== 요소 =====
  const views={ auth:$('#authView'), app:$('#appView') };
  const els={
    signupForm:$('#signupForm'), loginForm:$('#loginForm'),
    signupEmail:$('#signupEmail'), signupPassword:$('#signupPassword'),
    loginEmail:$('#loginEmail'), loginPassword:$('#loginPassword'),
    signupBtn:$('#signupBtn'), loginBtn:$('#loginBtn'), logoutBtn:$('#logoutBtn'),
    userEmail:$('#userEmail'), welcome:$('#welcomeText'),

    bookSelect:$('#bookSelect'),
    chapterCircles:$('#chapterCircles'),
    verseInfo:$('#verseInfo'),
    passageText:$('#passageText'),

    micBtn:$('#micBtn'), asrText:$('#asrText'),
    autoAdv:$('#autoAdvance'), matchInfo:$('#matchInfo'), softAdv:$('#softAdvanceBtn'),
    rankList:$('#rankList'),
  };

  // ===== 상태 =====
  const state={
    userId:null,
    book:null, chapter:null,
    verses:{},                         // { "1": "태초에 ..." }
    verseTokens: new Map(),            // verse -> [tokens] (어절 배열)
    currentVerse:1,
    currentWord:0,                     // 어절 포인터(0-based)
    versesReadSet:new Set(),           // 절 단위 진행 저장(기존 유지)
    // 어절 단위 매칭 파라미터
    match:{
      PASS:0.78,     // 자동 어절 진행
      SOFT:0.64,     // 무난 진행 버튼 허용
      WIN_MIN:3,     // 어절 윈도 최소
      WIN_MAX:6,     // 어절 윈도 최대
      LOOKAHEAD_VERSE:0 // 현재 절만 비교(원하면 1로 늘려 인접 절 포함)
    }
  };

  // ===== 진행도 저장/로드(절 기준 기존 유지) =====
  function progressDocRef(book,chapter){ if(!state.userId) return null; return db.collection('users').doc(state.userId).collection('progress').doc(`${book}-${chapter}`); }
  async function loadProgress(book,chapter){
    state.versesReadSet=new Set();
    const ref=progressDocRef(book,chapter); if(!ref) return;
    const s=await ref.get(); const d=s.data();
    if(d?.readVerses) d.readVerses.forEach(v=>state.versesReadSet.add(String(v)));
  }
  let _saveTimer=null;
  function saveProgressDebounced(book,chapter){ clearTimeout(_saveTimer); _saveTimer=setTimeout(()=>saveProgress(book,chapter),400); }
  async function saveProgress(book,chapter){
    const ref=progressDocRef(book,chapter); if(!ref) return;
    const arr=Array.from(state.versesReadSet).sort((a,b)=>Number(a)-Number(b));
    await ref.set({readVerses:arr,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
  }

  // ===== 로딩 =====
  async function loadBooks(){
    try{
      const snap=await db.collection('bible').doc(VERSION_ID).collection('books').get();
      els.bookSelect.innerHTML='';
      if(snap.empty){
        const o=document.createElement('option'); o.value=''; o.textContent=`책 데이터가 없습니다(bible/${VERSION_ID}/books)`;
        els.bookSelect.appendChild(o); return;
      }
      snap.forEach(d=>{ const o=document.createElement('option'); o.value=d.id; o.textContent=d.id; els.bookSelect.appendChild(o); });
    }catch(e){
      console.error('loadBooks 오류:',e);
      const o=document.createElement('option'); o.value=''; o.textContent='불러오기 오류'; els.bookSelect.appendChild(o);
    }
  }
  async function loadChapters(book){
    state.book=book;
    els.chapterCircles.innerHTML='';
    try{
      const snap=await db.collection('bible').doc(VERSION_ID).collection('books').doc(book).collection('chapters').get();
      const ids=snap.docs.map(d=>d.id).sort((a,b)=>Number(a)-Number(b));
      ids.forEach(id=>{
        const b=document.createElement('button');
        b.type='button'; b.className='circle-btn'; b.textContent=id;
        if(id===state.chapter) b.classList.add('active');
        b.addEventListener('click', async ()=>{
          state.chapter=id;
          els.chapterCircles.querySelectorAll('.circle-btn.active').forEach(x=>x.classList.remove('active'));
          b.classList.add('active');
          await loadPassage(book, id);
        });
        els.chapterCircles.appendChild(b);
      });
    }catch(e){ console.error('loadChapters 오류:',e); }
  }

  async function loadPassage(book, chapter){
    state.book=book; state.chapter=chapter;
    // 본문
    const doc=await db.collection('bible').doc(VERSION_ID).collection('books').doc(book).collection('chapters').doc(chapter).get();
    state.verses = doc.data()?.verses || {};
    await loadProgress(book, chapter);

    // 절수 표시
    const count=Object.keys(state.verses).length;
    els.verseInfo.textContent = count ? `${count}절` : '0절';

    // 토큰화(어절)
    buildVerseTokens();

    // 본문 렌더(어절 span으로 감싸서 하이라이트 가능)
    renderPassage();

    // 포인터 리셋
    state.currentVerse = 1;
    state.currentWord  = 0;
    highlightPointer();

    // 순위 초기화
    renderRank([]);
  }

  // ===== 본문 토큰화/렌더/하이라이트 =====
  function normalizeKR(s){
    return s.replace(/[“”"‘’'`]/g,'')
            .replace(/\s+/g,' ')
            .trim();
  }
  function buildVerseTokens(){
    state.verseTokens.clear();
    const keys=Object.keys(state.verses).sort((a,b)=>Number(a)-Number(b));
    for(const k of keys){
      const txt = normalizeKR(state.verses[k]||'');
      // 공백 기준 간단 어절 분리 (필요 시 형태소/어절 라이브러리로 교체 가능)
      const tokens = txt.length ? txt.split(' ') : [];
      state.verseTokens.set(Number(k), tokens);
    }
  }

  function renderPassage(){
    els.passageText.innerHTML='';
    const keys=Object.keys(state.verses).sort((a,b)=>Number(a)-Number(b));
    const frag=document.createDocumentFragment();
    for(const k of keys){
      const line=document.createElement('div');
      line.className='verse-line'; line.id=`v-${k}`;
      const num = document.createElement('span');
      num.style.opacity='.7'; num.style.marginRight='6px';
      num.textContent = `${k}.`;
      line.appendChild(num);

      const tokens = state.verseTokens.get(Number(k))||[];
      tokens.forEach((w,idx)=>{
        const sp=document.createElement('span');
        sp.className='word';
        sp.id = `w-${k}-${idx}`;
        sp.textContent = w + (idx<tokens.length-1?' ':'');
        line.appendChild(sp);
      });

      frag.appendChild(line);
    }
    els.passageText.appendChild(frag);
  }

  function highlightPointer(){
    // 모두 해제
    $$('.word.active').forEach(w=>w.classList.remove('active'));
    // 완료 어절 색 바꾸기(현재 절 기준)
    const toks = state.verseTokens.get(state.currentVerse)||[];
    for(let i=0;i<toks.length;i++){
      const el = $(`#w-${state.currentVerse}-${i}`);
      if(!el) continue;
      el.classList.toggle('done', i < state.currentWord);
      if(i===state.currentWord) el.scrollIntoView({behavior:'smooth', block:'center'});
    }
    const curEl = $(`#w-${state.currentVerse}-${state.currentWord}`);
    if(curEl) curEl.classList.add('active');
  }

  function advanceWord(span=1){
    const toks = state.verseTokens.get(state.currentVerse)||[];
    state.currentWord += span;
    if(state.currentWord >= toks.length){
      // 절 완료
      state.versesReadSet.add(String(state.currentVerse));
      saveProgressDebounced(state.book, state.chapter);
      // 다음 절로
      state.currentVerse += 1;
      state.currentWord = 0;
      // 다음 절이 없으면 종료
      if(!state.verseTokens.has(state.currentVerse)){
        state.currentVerse -= 1; // 마지막 절로 고정
        state.currentWord = (state.verseTokens.get(state.currentVerse)||[]).length-1;
      }
    }
    highlightPointer();
  }

  // ===== ASR (어절 매칭) =====
  let recognition=null, recognizing=false, pendingSoft=null;

  function ensureRecognition(){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR) return null;
    const rec=new SR(); rec.lang='ko-KR'; rec.interimResults=true; rec.continuous=false; rec.maxAlternatives=5;
    return rec;
  }
  function setMicVisual(on){
    els.micBtn?.classList.toggle('recording', !!on);
    if(els.micBtn) els.micBtn.textContent = on ? '🛑 인식 중지' : '🎤 음성으로 읽기';
  }
  async function startASR(){
    if(recognizing) return;
    recognition=ensureRecognition();
    if(!recognition){ els.asrText && (els.asrText.textContent='이 브라우저는 음성 인식을 지원하지 않습니다.'); return; }
    recognizing=true; setMicVisual(true); els.asrText && (els.asrText.textContent='듣는 중…');
    recognition.onresult=async(e)=>{
      let finals=[], finalText='', interim='';
      for(let i=e.resultIndex;i<e.results.length;i++){
        const r=e.results[i];
        if(r.isFinal){ finalText += r[0].transcript; finals = Array.from({length:Math.min(r.length,5)},(_,k)=>r[k]?.transcript).filter(Boolean); }
        else interim += r[0].transcript;
      }
      els.asrText && (els.asrText.textContent = finalText || interim);
      if(finals.length) await matchAndAdvanceByWords(finals);
    };
    recognition.onerror=(e)=>{ els.asrText && (els.asrText.textContent=`인식 오류: ${e.error||'unknown'}`); };
    recognition.onend=()=>{ recognizing=false; setMicVisual(false); };
    recognition.start();
  }
  function stopASR(){ if(recognition&&recognizing) recognition.stop(); }

  // ===== 매칭(어절 n-gram 창 대비) =====
  function cleanText(s){
    return s
      .replace(/[“”"‘’'`]/g,'')
      .replace(/[.,!?;:·…、，。]/g,' ')
      .replace(/\(.*?\)|\[.*?\]/g,' ')
      .replace(/[\u3165-\u318F]/g,'')
      .replace(/[^0-9A-Za-z가-힣\s]/g,' ')
      .replace(/\s+/g,' ')
      .trim()
      .toLowerCase();
  }
  function tokenize(s){ return cleanText(s).split(' ').filter(Boolean); }

  function levenshteinTokens(A,B){
    const dp=Array(B.length+1).fill(0).map((_,i)=>i);
    for(let i=1;i<=A.length;i++){
      let prev=i-1; dp[0]=i;
      for(let j=1;j<=B.length;j++){
        const tmp=dp[j];
        dp[j] = (A[i-1]===B[j-1]) ? prev : 1+Math.min(prev, dp[j-1], dp[j]);
        prev=tmp;
      }
    }
    return dp[B.length];
  }
  function sim(aStr,bTokens){
    const A=tokenize(aStr); const B=bTokens;
    if(!A.length || !B.length) return 0;
    const dist=levenshteinTokens(A,B);
    const wer = dist / Math.max(A.length, B.length);
    return 1-wer;
  }

  function buildWordWindows(){
    // 현재 절 기준: currentWord에서 WIN_MIN..WIN_MAX n-gram
    const out=[];
    const v=state.currentVerse;
    const toks = state.verseTokens.get(v)||[];
    for(let n=state.match.WIN_MIN; n<=state.match.WIN_MAX; n++){
      const end = state.currentWord + n;
      if(end>toks.length) break;
      out.push({verse:v, start:state.currentWord, span:n, tokens:toks.slice(state.currentWord, end)});
    }
    // 필요 시 다음 절의 앞부분도 후보로 포함(LOOKAHEAD_VERSE)
    if(state.match.LOOKAHEAD_VERSE>0){
      const v2=v+1;
      if(state.verseTokens.has(v2)){
        const toks2 = state.verseTokens.get(v2)||[];
        for(let n=state.match.WIN_MIN; n<=state.match.WIN_MAX; n++){
          if(n>toks2.length) break;
          out.push({verse:v2, start:0, span:n, tokens:toks2.slice(0,n)});
        }
      }
    }
    return out;
  }

  async function matchAndAdvanceByWords(finals){
    const windows = buildWordWindows();
    if(!windows.length) return;

    const scored=[];
    for(const w of windows){
      for(const hyp of finals){
        const score = sim(hyp, w.tokens);
        scored.push({w,hyp,score});
      }
    }
    scored.sort((a,b)=>b.score-a.score);

    // 순위 UI(상위 5개)
    renderRank(scored.slice(0,5));

    const best = scored[0];
    if(els.matchInfo){
      const pct = best ? Math.round(best.score*100) : 0;
      const range = best ? `${best.w.verse}절 ${best.w.start+1}~${best.w.start+best.w.span}어절` : '-';
      els.matchInfo.textContent = `유사도: ${pct}% (${range})`;
    }
    if(!best) return;

    if(best.score >= state.match.PASS && els.autoAdv?.checked){
      // 어절 자동 진행
      if(best.w.verse !== state.currentVerse){
        // 다음 절로 점프 (현재 절 완료 처리)
        const curToks = state.verseTokens.get(state.currentVerse)||[];
        state.currentWord = curToks.length; // 끝으로
        advanceWord(0); // 절 넘김 로직 실행
      }
      advanceWord(best.w.span);
      pendingSoft=null; els.softAdv && (els.softAdv.disabled=true);
    } else if(best.score >= state.match.SOFT){
      pendingSoft = { verse:best.w.verse, start:best.w.start, span:best.w.span };
      els.softAdv && (els.softAdv.disabled=false);
    } else {
      els.asrText && (els.asrText.textContent += ' (조금만 더 또박또박!)');
    }
  }

  function renderRank(items){
    els.rankList.innerHTML='';
    items.forEach(({w,hyp,score})=>{
      const li=document.createElement('li');
      li.textContent = `${Math.round(score*100)}% — ${w.verse}절 ${w.start+1}~${w.start+w.span}어절  |  “${hyp}”`;
      els.rankList.appendChild(li);
    });
  }

  // ===== 이벤트 =====
  function bindSafely(el,ev,fn){ if(!el||BOUND.has(el)) return; on(el,ev,fn); BOUND.add(el); }
  function wire(){
    // 인증
    bindSafely(els.signupForm,'submit',async e=>{e.preventDefault(); const email=els.signupEmail.value.trim(), pw=els.signupPassword.value; await auth.createUserWithEmailAndPassword(email,pw).catch(err=>alert(err.message)); });
    bindSafely(els.loginForm,'submit',async e=>{e.preventDefault(); const email=els.loginEmail.value.trim(), pw=els.loginPassword.value; await auth.signInWithEmailAndPassword(email,pw).catch(err=>alert(err.message)); });
    bindSafely(els.signupBtn,'click',e=>els.signupForm?.dispatchEvent(new Event('submit')));
    bindSafely(els.loginBtn,'click',e=>els.loginForm?.dispatchEvent(new Event('submit')));
    bindSafely(els.logoutBtn,'click',async()=>{ await auth.signOut(); });

    // 권 변경 → 장 로드
    bindSafely(els.bookSelect,'change', async ()=>{ await loadChapters(els.bookSelect.value); });

    // 음성
    bindSafely(els.micBtn,'click', ()=>{ recognizing?stopASR():startASR(); });
    bindSafely(els.softAdv,'click', ()=>{
      if(!pendingSoft) return;
      if(pendingSoft.verse !== state.currentVerse){
        const curToks = state.verseTokens.get(state.currentVerse)||[];
        state.currentWord = curToks.length;
        advanceWord(0);
      }
      advanceWord(pendingSoft.span);
      pendingSoft=null; els.softAdv.disabled=true;
    });
    if(els.softAdv) els.softAdv.disabled=true;
  }
  document.readyState==='loading'?on(document,'DOMContentLoaded',wire,{once:true}):wire();

  // ===== 인증 상태 =====
  auth.onAuthStateChanged(async user=>{
    if(user){
      state.userId=user.uid;
      els.userEmail&&(els.userEmail.textContent=user.email||'(알 수 없음)');
      els.welcome&&(els.welcome.textContent='샬롬! 말씀읽기를 시작해볼까요?');
      views.auth?.classList.add('hidden'); views.app?.classList.remove('hidden');

      await loadBooks();
      // 첫 권 자동 선택 및 장 로드
      const first = els.bookSelect?.options?.[0]?.value;
      if(first){ els.bookSelect.value=first; await loadChapters(first); }
    }else{
      state.userId=null;
      views.app?.classList.add('hidden'); views.auth?.classList.remove('hidden');
    }
  });

})();
