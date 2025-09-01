// =========================
// app.js — 말씀읽기APP v2
// (Firebase Auth + Firestore, 회원가입 버튼 작동 수정)
// =========================
(function () {
  'use strict';

  // ---- 유틸 ----
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
  const log = (...a) => console.log('[APP]', ...a);

  // 중복 바인딩 방지용 플래그
  const BOUND = new WeakSet();

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

  // ---- 뷰 참조 ----
  const views = {
    auth: $('#authView') || $('#view-auth') || $('[data-view="auth"]'),
    app: $('#appView') || $('#view-app') || $('[data-view="app"]'),
  };

  const els = {
    email: $('#email') || $('#loginEmail') || $('#signupEmail'),
    password: $('#password') || $('#loginPassword') || $('#signupPassword'),
    signupEmail: $('#signupEmail') || $('#email'),
    signupPassword: $('#signupPassword') || $('#password'),

    signupBtn: $('#signupBtn') || $('[data-action="signup"]') || $('button[name="signup"]') || $('.btn-signup'),
    loginBtn: $('#loginBtn') || $('[data-action="login"]') || $('button[name="login"]') || $('.btn-login'),
    logoutBtn: $('#logoutBtn') || $('[data-action="logout"]') || $('button[name="logout"]') || $('.btn-logout'),

    signupForm: $('#signupForm') || $('form[data-form="signup"]') || $('form#registerForm'),
    loginForm: $('#loginForm') || $('form[data-form="login"]') || $('form#signinForm'),

    welcome: $('#welcomeText') || $('#welcome') || $('[data-el="welcome"]'),
    userEmail: $('#userEmail') || $('[data-el="userEmail"]'),
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

  // ---- Auth 상태 변화 ----
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      await ensureUserDoc(user);
      if (els.userEmail) els.userEmail.textContent = user.email || user.displayName || '(알 수 없음)';
      if (els.welcome) els.welcome.textContent = '샬롬! 말씀읽기를 시작해볼까요?';
      show(views.app || document.body);
      log('로그인됨:', user.uid);
    } else {
      show(views.auth || document.body);
      log('로그아웃됨');
    }
  });

  // ---- 회원가입 ----
  async function handleSignup(e) {
    if (e) e.preventDefault();
    const form = els.signupForm || document;
    const { email, password } = {
      email: (els.signupEmail && els.signupEmail.value.trim()) || '',
      password: (els.signupPassword && els.signupPassword.value) || '',
      ...getFormValues(form, { email: '#signupEmail', password: '#signupPassword' }),
    };

    try {
      if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) throw { code: 'auth/invalid-email' };
      if (!password || password.length < 6) throw { code: 'auth/weak-password' };

      const cred = await auth.createUserWithEmailAndPassword(email, password);
      log('회원가입 완료', cred.user && cred.user.uid);
    } catch (err) {
      alert(errorText(err.code, err.message));
      console.error('회원가입 오류:', err);
    }
  }

  // ---- 로그인 ----
  async function handleLogin(e) {
    if (e) e.preventDefault();
    const form = els.loginForm || document;
    const email = (els.email && els.email.value.trim()) || (form.querySelector('#loginEmail') && form.querySelector('#loginEmail').value.trim()) || '';
    const password = (els.password && els.password.value) || (form.querySelector('#loginPassword') && form.querySelector('#loginPassword').value) || '';
    try {
      const cred = await auth.signInWithEmailAndPassword(email, password);
      log('로그인 완료', cred.user && cred.user.uid);
    } catch (err) {
      alert(errorText(err.code, err.message));
      console.error('로그인 오류:', err);
    }
  }

  // ---- 로그아웃 ----
  async function handleLogout(e) {
    if (e) e.preventDefault();
    try {
      await auth.signOut();
      log('로그아웃 완료');
    } catch (err) {
      alert('로그아웃 실패: ' + (err.message || '알 수 없는 오류'));
    }
  }

  // ---- 폼 값 추출 ----
  function getFormValues(form, map) {
    const out = {};
    for (const k in map) {
      const el = form.querySelector(map[k]) || $(map[k]);
      out[k] = el ? el.value.trim() : '';
    }
    return out;
  }

  // ---- 이벤트 안전 바인딩 ----
  function bindSafely(el, ev, fn) {
    if (!el) return;
    if (BOUND.has(el)) return;
    on(el, ev, fn);
    BOUND.add(el);
  }

  function wireEvents() {
    bindSafely(els.signupBtn, 'click', handleSignup);
    bindSafely(els.loginBtn, 'click', handleLogin);
    bindSafely(els.logoutBtn, 'click', handleLogout);

    bindSafely(els.signupForm, 'submit', handleSignup);
    bindSafely(els.loginForm, 'submit', handleLogin);

    $$('[data-action="signup"]').forEach(btn => bindSafely(btn, 'click', handleSignup));
    $$('[data-action="login"]').forEach(btn => bindSafely(btn, 'click', handleLogin));
    $$('[data-action="logout"]').forEach(btn => bindSafely(btn, 'click', handleLogout));

    log('이벤트 바인딩 완료');
  }

  if (document.readyState === 'loading') {
    on(document, 'DOMContentLoaded', wireEvents, { once: true });
  } else {
    wireEvents();
  }

})();
