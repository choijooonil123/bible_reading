(() => {
  let app, auth, db, user;
  const els = {
    btnGoogle: document.getElementById('btnGoogle'),
    btnAnon: document.getElementById('btnAnon'),
    btnSignOut: document.getElementById('btnSignOut'),
    signedOut: document.getElementById('signedOut'),
    signedIn: document.getElementById('signedIn'),
    userName: document.getElementById('userName'),
    userPhoto: document.getElementById('userPhoto'),
    bookSelect: document.getElementById('bookSelect'),
    chapterGrid: document.getElementById('chapterGrid'),
    verseGrid: document.getElementById('verseGrid'),
    verseText: document.getElementById('verseText'),
    verseCount: document.getElementById('verseCount'),
    locLabel: document.getElementById('locLabel'),
    btnPrevVerse: document.getElementById('btnPrevVerse'),
    btnNextVerse: document.getElementById('btnNextVerse'),
    btnToggleMic: document.getElementById('btnToggleMic'),
    myStats: document.getElementById('myStats'),
    leaderList: document.getElementById('leaderList'),
    btnProgressMatrix: document.getElementById('btnProgressMatrix'),
    btnCloseMatrix: document.getElementById('btnCloseMatrix'),
    matrixModal: document.getElementById('matrixModal'),
    matrixWrap: document.getElementById('matrixWrap'),
    autoAdvance: document.getElementById('autoAdvance'),
    resumeInfo: document.getElementById('resumeInfo'),
    listenHint: document.getElementById('listenHint')
  };

  const state = { bible:null, currentBookKo:null, currentChapter:null, verses:[], currentVerseIdx:0 };
  const BOOKS = window.BOOKS || [];
  const getBookByKo = (ko) => BOOKS.find(b => b.ko === ko);

  // Firebase 초기화
  if (window.firebaseConfig) {
    app = firebase.initializeApp(window.firebaseConfig);
    auth = firebase.auth();
    db   = firebase.firestore();
    console.log("[Firebase] 초기화 OK");
  }

  // bible.json 불러오기
  async function loadBible(){
    const res = await fetch('bible.json');
    state.bible = await res.json();
  }
  loadBible();

  // 로그인 처리
  auth?.getRedirectResult?.().then(r=>{
    if(r?.user) console.log("[Auth] redirect success:", r.user.uid);
  });
  els.btnGoogle?.addEventListener('click', ()=>{
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithRedirect(provider);
  });
  els.btnAnon?.addEventListener('click', ()=>auth.signInAnonymously());
  els.btnSignOut?.addEventListener('click', ()=>auth.signOut());

  auth?.onAuthStateChanged(u=>{
    user=u;
    if(u){ els.signedOut.classList.add("hidden"); els.signedIn.classList.remove("hidden"); els.userName.textContent=u.displayName||"익명"; }
    else { els.signedIn.classList.add("hidden"); els.signedOut.classList.remove("hidden"); }
  });

  // ---------- 모달 ----------
  function openMatrix() {
    els.matrixModal.classList.add('show');
    els.matrixModal.classList.remove('hidden');
  }
  function closeMatrix() {
    els.matrixModal.classList.remove('show');
    els.matrixModal.classList.add('hidden');
  }
  els.btnProgressMatrix?.addEventListener('click', openMatrix);
  els.btnCloseMatrix?.addEventListener('click', (e) => { e.preventDefault(); closeMatrix(); });
  els.matrixModal?.addEventListener('click', (e) => {
    const body = els.matrixModal.querySelector('.modal-body');
    if (!body.contains(e.target)) closeMatrix();
  });
  window.addEventListener('keydown', (e) => { if (e.key==='Escape') closeMatrix(); });
})();
