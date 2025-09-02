// =========================
// app.js — 말씀읽기APP v2 (최종)
// Firebase Auth + Firestore + 장/절 현황표 + 진행률 저장
// =========================
(function () {
  'use strict';

  // ---- 유틸 ----
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
  const log = (...a) => console.log('[APP]', ...a);
  const BOUND = new WeakSet(); // 중복 바인딩 방지

  // ---- Firebase 초기화 ----
  try {
    const cfg = (window && (window.firebaseConfig || window.FIREBASE_CONFIG || window.firebase_config)) || (typeof firebaseConfig !== 'undefined' ? firebaseConfig : null);
    if (!cfg) console.warn('firebaseConfig가 감지되지 않았습니다. firebaseConfig.js 로딩 순서를 확인하세요.');
    if (!firebase.apps.length) {
      firebase.initializeApp(cfg || {});
      log('Firebase initialized');
    } else {
      log('Firebase already initialized');
    }
  } catch (err) {
    console.error('Firebase 초기화 오류:', err);
  }

  const auth = firebase.auth();
  const db = firebase.firestore();

  // ---- 뷰/엘리먼트 참조 ----
  const views = {
    auth: $('#authView') || $('#view-auth') || $('[data-view="auth"]'),
    app: $('#appView') || $('#view-app') || $('[data-view="app"]'),
  };
  const els = {
    // 로그인/가입 입력
    email: $('#email') || $('#loginEmail') || $('#signupEmail'),
    password: $('#password') || $('#loginPassword') || $('#signupPassword'),
    signupEmail: $('#signupEmail') || $('#email'),
    signupPassword: $('#signupPassword') || $('#password'),

    // 버튼/폼
    signupBtn: $('#signupBtn') || $('[data-action="signup"]') || $('button[name="signup"]') || $('.btn-signup'),
    loginBtn: $('#loginBtn') || $('[data-action="login"]') || $('button[name="login"]') || $('.btn-login'),
    logoutBtn: $('#logoutBtn') || $('[data-action="logout"]') || $('button[name="logout"]') || $('.btn-logout'),
    signupForm: $('#signupForm') || $('form[data-form="signup"]') || $('form#registerForm'),
    loginForm: $('#loginForm') || $('form[data-form="login"]') || $('form#signinForm'),

    // 앱 영역
    welcome: $('#welcomeText') || $('#welcome') || $('[data-el="welcome"]'),
    userEmail: $('#userEmail') || $('[data-el="userEmail"]'),

    // 말씀 뷰어 & 현황표
    bookSelect: $('#bookSelect'),
    chapterSelect: $('#chapterSelect'),
    passageText: $('#passageText'),
    statusBoard: $('#statusBoard'),
    digitGrid: $('#digitGrid'),

    // 모드 토글
    modeChapter: $('#modeChapter'),
    modeVerse: $('#modeVerse'),
  };

  // ---- 앱 상태 ----
  const state = {
    mode: 'chapter',           // 'chapter' | 'verse'
    currentVersesCount: 0,     // 현재 장의 절 수(절 보기용)
    versesReadSet: new Set(),  // 읽음 절 번호 Set (문자열)
    userId: null,
    saving: false,
  };

  // ---- 에러 한글화 ----
  const errorText = (code, msg) => {
    const map = {
      'auth/invalid-email': '이메일 형식이 올바르지 않습니다.',
      'auth/email-already-in-use': '이미 가입된 이메일입니다.',
      'auth/weak-password': '비밀번호가 너무 약합니다(최소 6자 이상 권장).',
      'auth/user-not-found': '가입된 사용자가 없습니다.',
      'auth/wrong-password': '비밀번호가 올바르지 않습니다.',
      'auth/too-many-requests': '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
    };
    return map[code] || (msg || '알 수 없는 오류가 발생했습니다.');
  };

  // ---- UI 토글 ----
  function show(view) {
    if (views.auth) views.auth.classList.add('hidden');
    if (views.app) views.app.classList.add('hidden');
    if (view && view.classList) view.classList.remove('hidden');
  }

  // ---- 사용자 문서 생성 ----
  async function ensureUserDoc(user) {
    if (!user) return;
    const ref = db.collection('users').doc(user.uid);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        uid: user.uid,
        email: user.email || null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        displayName: user.displayName || null,
        provider: (user.providerData && user.providerData[0] && user.providerData[0].providerId) || 'password',
      });
      log('사용자 문서 생성');
    }
  }

  // ---- 진행도(읽음 절) 저장/로드 ----
  function progressDocRef(book, chapter) {
    if (!state.userId) return null;
    return db.collection('users').doc(state.userId)
             .collection('progress').doc(`${book}-${chapter}`);
  }

  async function loadProgress(book, chapter) {
    state.versesReadSet = new Set();
    const ref = progressDocRef(book, chapter);
    if (!ref) return;
    const snap = await ref.get();
    const data = snap.data();
    if (data?.readVerses && Array.isArray(data.readVerses)) {
      data.readVerses.forEach(v => state.versesReadSet.add(String(v)));
    }
  }

  let _saveTimer = null;
  function saveProgressDebounced(book, chapter) {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => saveProgress(book, chapter), 400);
  }

  async function saveProgress(book, chapter) {
    const ref = progressDocRef(book, chapter);
    if (!ref) return;
    const arr = Array.from(state.versesReadSet.values()).sort((a,b)=>Number(a)-Number(b));
    state.saving = true;
    try {
      await ref.set(
        { readVerses: arr, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } finally {
      state.saving = false;
    }
  }

  // ---- Firestore에서 책/장/절 불러오기 ----
  async function loadBibleBooks() {
    const snap = await db.collection("bible").doc("개역한글").collection("books").get();
    els.bookSelect.innerHTML = "";
    snap.forEach(doc => {
      const opt = document.createElement("option");
      opt.value = doc.id;
      opt.textContent = doc.id;
      els.bookSelect.appendChild(opt);
    });
    await fillChapters();
  }

  async function fillChapters() {
    const book = els.bookSelect?.value;
    if (!book) return;

    const snap = await db.collection("bible")
      .doc("개역한글")
      .collection("books")
      .doc(book)
      .collection("chapters")
      .get();

    const chapterIds = snap.docs.map(d => d.id).sort((a,b)=>Number(a)-Number(b));

    if (els.chapterSelect) {
      els.chapterSelect.innerHTML = '';
      chapterIds.forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${id}장`;
        els.chapterSelect.appendChild(opt);
      });
    }

    // 장 모드일 때 장 현황표 갱신
    if (state.mode === 'chapter') {
      renderStatusBoard(chapterIds.length);
    }
  }

  async function renderPassage() {
    if (!els.bookSelect || !els.chapterSelect || !els.passageText) return;
    const book = els.bookSelect.value;
    const chapter = els.chapterSelect.value;
    if (!book || !chapter) return;

    // 절 데이터 가져오기
    const doc = await db.collection("bible")
      .doc("개역한글")
      .collection("books")
      .doc(book)
      .collection("chapters")
      .doc(chapter)
      .get();

    const verses = doc.data()?.verses || {};

    // 진행도 로드
    await loadProgress(book, chapter);

    // 절 수
    const verseNums = Object.keys(verses).sort((a,b)=>Number(a)-Number(b));
    state.currentVersesCount = verseNums.length;

    // 본문 렌더 (절별 앵커)
    const frag = document.createDocumentFragment();
    verseNums.forEach(n => {
      const line = document.createElement('div');
      line.id = `v-${n}`;
      line.style.padding = '6px 0';
      line.style.scrollMarginTop = '96px';
      line.innerText = `${n}. ${verses[n]}`;
      frag.appendChild(line);
    });
    els.passageText.innerHTML = '';
    els.passageText.appendChild(frag);

    // 현황표 갱신
    if (state.mode === 'verse') {
      renderStatusBoard(state.currentVersesCount);
    }
    syncStatusActive();
  }

  // ---- 현황표(장/절) 렌더 ----
  function renderStatusBoard(total) {
    if (!els.digitGrid) return;
    els.digitGrid.innerHTML = '';
    const isVerseMode = state.mode === 'verse';

    for (let n = 1; n <= total; n++) {
      const tens = Math.floor(n / 10); // 십의 자리 (0 포함)
      const ones = n % 10;             // 일의 자리

      const btn = document.createElement('button');
      btn.className = 'digit-btn';
      btn.type = 'button';
      btn.setAttribute(isVerseMode ? 'data-verse' : 'data-chapter', String(n));
      btn.setAttribute('aria-label', isVerseMode ? `${n}절 바로가기` : `${n}장 바로가기`);

      const top = document.createElement('div');
      top.className = 'digit-line top';
      top.textContent = String(tens);

      const bottom = document.createElement('div');
      bottom.className = 'digit-line bottom';
      bottom.textContent = String(ones);

      btn.appendChild(top);
      btn.appendChild(bottom);

      // 읽음 표시(절 모드)
      if (isVerseMode && state.versesReadSet.has(String(n))) {
        btn.classList.add('read');
      }

      // 현재 장 active(장 모드)
      if (!isVerseMode && String(n) === (els.chapterSelect?.value || '')) {
        btn.classList.add('active');
      }

      btn.addEventListener('click', async () => {
        if (isVerseMode) {
          // 절 읽음 토글 + 스크롤
          const num = String(n);
          if (state.versesReadSet.has(num)) {
            state.versesReadSet.delete(num);
            btn.classList.remove('read');
          } else {
            state.versesReadSet.add(num);
            btn.classList.add('read');
          }
          saveProgressDebounced(els.bookSelect.value, els.chapterSelect.value);

          const target = document.getElementById(`v-${num}`);
          if (target && target.scrollIntoView) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        } else {
          // 장 이동
          if (els.chapterSelect) {
            els.chapterSelect.value = String(n);
          }
          els.digitGrid.querySelectorAll('.digit-btn.active').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          await renderPassage();
          const box = document.getElementById('passageBox');
          if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });

      els.digitGrid.appendChild(btn);
    }
  }

  function syncStatusActive() {
    if (!els.digitGrid) return;
    if (state.mode === 'chapter') {
      const val = els.chapterSelect?.value || '';
      els.digitGrid.querySelectorAll('.digit-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-chapter') === val);
      });
    } else {
      // 절 모드: 읽음 표시 동기화
      els.digitGrid.querySelectorAll('.digit-btn').forEach(btn => {
        const v = btn.getAttribute('data-verse');
        if (!v) return;
        btn.classList.toggle('read', state.versesReadSet.has(v));
      });
    }
  }

  // ---- 이벤트 안전 바인딩 ----
  function bindSafely(el, ev, fn) {
    if (!el) return;
    if (BOUND.has(el)) return;
    on(el, ev, fn);
    BOUND.add(el);
  }

  function wireEvents() {
    // 버튼/폼
    bindSafely(els.signupBtn, 'click', handleSignup);
    bindSafely(els.loginBtn, 'click', handleLogin);
    bindSafely(els.logoutBtn, 'click', handleLogout);
    bindSafely(els.signupForm, 'submit', handleSignup);
    bindSafely(els.loginForm, 'submit', handleLogin);

    // data-action 자동 바인딩(여분 버튼 대응)
    $$('[data-action="signup"]').forEach(btn => bindSafely(btn, 'click', handleSignup));
    $$('[data-action="login"]').forEach(btn => bindSafely(btn, 'click', handleLogin));
    $$('[data-action="logout"]').forEach(btn => bindSafely(btn, 'click', handleLogout));

    // 권 변경 → 장/현황표 갱신 + 본문 렌더
    bindSafely(els.bookSelect, 'change', async () => {
      await fillChapters();
      await renderPassage();
    });

    // 장 변경 → 본문/현황표 동기화
    bindSafely(els.chapterSelect, 'change', async () => {
      await renderPassage();
      syncStatusActive();
    });

    // 장/절 모드 토글
    bindSafely(els.modeChapter, 'click', async () => {
      state.mode = 'chapter';
      els.modeChapter.classList.add('active');
      els.modeChapter.setAttribute('aria-pressed','true');
      els.modeVerse.classList.remove('active');
      els.modeVerse.setAttribute('aria-pressed','false');
      await fillChapters(); // 장 개수 기준 현황표
      syncStatusActive();
    });

    bindSafely(els.modeVerse, 'click', async () => {
      state.mode = 'verse';
      els.modeVerse.classList.add('active');
      els.modeVerse.setAttribute('aria-pressed','true');
      els.modeChapter.classList.remove('active');
      els.modeChapter.setAttribute('aria-pressed','false');
      await renderPassage(); // 본문 렌더 → 절 수 기준 현황표
    });

    log('이벤트 바인딩 완료');
  }

  if (document.readyState === 'loading') {
    on(document, 'DOMContentLoaded', wireEvents, { once: true });
  } else {
    wireEvents();
  }

  // ---- 회원가입/로그인/로그아웃 ----
  async function handleSignup(e) {
    if (e) e.preventDefault();
    const form = els.signupForm || document;
    const email = (els.signupEmail && els.signupEmail.value.trim()) || (form.querySelector('#signupEmail')?.value.trim()) || '';
    const password = (els.signupPassword && els.signupPassword.value) || (form.querySelector('#signupPassword')?.value) || '';
    try {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw { code: 'auth/invalid-email' };
      if (!password || password.length < 6) throw { code: 'auth/weak-password' };
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      log('회원가입 완료', cred.user && cred.user.uid);
    } catch (err) {
      alert(errorText(err.code, err.message));
      console.error('회원가입 오류:', err);
    }
  }

  async function handleLogin(e) {
    if (e) e.preventDefault();
    const form = els.loginForm || document;
    const email = (els.email && els.email.value.trim()) || (form.querySelector('#loginEmail')?.value.trim()) || '';
    const password = (els.password && els.password.value) || (form.querySelector('#loginPassword')?.value) || '';
    try {
      const cred = await auth.signInWithEmailAndPassword(email, password);
      log('로그인 완료', cred.user && cred.user.uid);
    } catch (err) {
      alert(errorText(err.code, err.message));
      console.error('로그인 오류:', err);
    }
  }

  async function handleLogout(e) {
    if (e) e.preventDefault();
    try {
      await auth.signOut();
      log('로그아웃 완료');
    } catch (err) {
      alert('로그아웃 실패: ' + (err.message || '알 수 없는 오류'));
    }
  }

  // ---- Auth 상태 변화 ----
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      state.userId = user.uid; // 사용자 ID 저장
      await ensureUserDoc(user);
      if (els.userEmail) els.userEmail.textContent = user.email || user.displayName || '(알 수 없음)';
      if (els.welcome) els.welcome.textContent = '샬롬! 말씀읽기를 시작해볼까요?';
      show(views.app || document.body);

      // 초기 로드
      await loadBibleBooks();   // 책 목록
      await fillChapters();     // 장 목록 + (장 모드 현황표)
      await renderPassage();    // 본문 + (절 모드일 경우 절 수 반영)
      syncStatusActive();
    } else {
      state.userId = null;
      show(views.auth || document.body);
    }
  });

})();
