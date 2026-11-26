(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const screens = Array.from(document.querySelectorAll('main > section'));

  let user = null;
  let settings = null;
  let quiz = null;
  let authMode = 'login';
  let lastScreen = 'home';

  // ---------- helpers ----------
  function show(name) {
    lastScreen = name;
    for (const s of screens) s.hidden = s.id !== `screen-${name}`;
    const first = document.querySelector(`#screen-${name} input:not([type=hidden]), #screen-${name} button.primary`);
    if (first && name !== 'quiz') first.focus({ preventScroll: true });
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON response */
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) node.append(c);
    return node;
  }

  function setMsg(id, text) {
    const node = $(id);
    node.textContent = text || '';
    node.hidden = !text;
  }

  function applyTheme(dark) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem('goodle-theme', dark ? 'dark' : 'light');
    } catch {
      /* storage unavailable */
    }
  }

  function initialTheme() {
    try {
      const saved = localStorage.getItem('goodle-theme');
      if (saved) return saved === 'dark';
    } catch {
      /* ignore */
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  const fmtTime = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  function fmtDate(sqliteUtc) {
    // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC
    const d = new Date(String(sqliteUtc).replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? String(sqliteUtc) : d.toLocaleString();
  }

  function goHome() {
    $('home-greeting').textContent = `Signed in as ${user.username}${user.isAdmin ? ' (admin)' : ''}`;
    $('btn-admin').hidden = !user.isAdmin;
    setMsg('home-error', '');
    show('home');
  }

  function onSignedIn(data) {
    user = data.user;
    settings = data.settings;
    applyTheme(settings.darkMode);
    goHome();
  }

  function onSignedOut() {
    user = null;
    settings = null;
    quiz = null;
    $('auth-password').value = '';
    setAuthMode('login');
    show('auth');
  }

  // ---------- auth ----------
  function setAuthMode(mode) {
    authMode = mode;
    $('tab-login').classList.toggle('active', mode === 'login');
    $('tab-register').classList.toggle('active', mode === 'register');
    $('tab-login').setAttribute('aria-selected', String(mode === 'login'));
    $('tab-register').setAttribute('aria-selected', String(mode === 'register'));
    $('auth-hint').hidden = mode !== 'register';
    $('auth-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('auth-submit').textContent = mode === 'register' ? 'Create account' : 'Continue';
    setMsg('auth-error', '');
  }

  $('tab-login').addEventListener('click', () => setAuthMode('login'));
  $('tab-register').addEventListener('click', () => setAuthMode('register'));

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('auth-error', '');
    const btn = $('auth-submit');
    btn.disabled = true;
    try {
      const data = await api('POST', authMode === 'register' ? '/api/register' : '/api/login', {
        username: $('auth-username').value,
        password: $('auth-password').value,
      });
      $('auth-password').value = '';
      onSignedIn(data);
    } catch (err) {
      setMsg('auth-error', err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-logout').addEventListener('click', async () => {
    try {
      await api('POST', '/api/logout', {});
    } catch {
      /* log out locally regardless */
    }
    onSignedOut();
  });

  // ---------- navigation ----------
  document.querySelectorAll('button.back').forEach((b) => b.addEventListener('click', goHome));
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-scores').addEventListener('click', openScores);
  $('btn-admin').addEventListener('click', openAdmin);
  $('btn-feedback').addEventListener('click', () => {
    $('feedback-text').value = '';
    setMsg('feedback-status', '');
    setMsg('feedback-error', '');
    show('feedback');
  });
  $('btn-start').addEventListener('click', startQuiz);

  // ---------- settings ----------
  async function openSettings() {
    setMsg('settings-status', '');
    setMsg('settings-error', '');
    try {
      const data = await api('GET', '/api/settings');
      settings = data.settings;
      $('set-scoring').checked = settings.scoring;
      $('set-dark').checked = settings.darkMode;
      $('set-seconds').value = settings.secondsPerQuestion;
      $('set-count').value = settings.numQuestions;
      $('set-count').max = String(data.maxQuestions);
      $('set-max').textContent = `(max ${data.maxQuestions})`;
      show('settings');
    } catch (err) {
      setMsg('home-error', err.message);
    }
  }

  $('set-dark').addEventListener('change', () => applyTheme($('set-dark').checked));

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('settings-status', '');
    setMsg('settings-error', '');
    try {
      const data = await api('PUT', '/api/settings', {
        scoring: $('set-scoring').checked,
        darkMode: $('set-dark').checked,
        secondsPerQuestion: Number($('set-seconds').value),
        numQuestions: Number($('set-count').value),
      });
      settings = data.settings;
      applyTheme(settings.darkMode);
      $('settings-status').hidden = false;
    } catch (err) {
      setMsg('settings-error', err.message);
    }
  });

  // ---------- quiz ----------
  async function startQuiz() {
    setMsg('home-error', '');
    setMsg('result-error', '');
    try {
      const data = await api('POST', '/api/quiz/start', {});
      quiz = {
        attemptId: data.attemptId,
        questions: data.questions,
        secondsPer: data.secondsPerQuestion,
        scoring: data.scoring,
        idx: 0,
        selected: null,
        answers: [],
        timerId: null,
        deadline: 0,
        finishing: false,
      };
      setMsg('quiz-error', '');
      show('quiz');
      renderQuestion();
    } catch (err) {
      // Could be launched from the home or result screen.
      setMsg(lastScreen === 'result' ? 'result-error' : 'home-error', err.message);
    }
  }

  function renderQuestion() {
    const item = quiz.questions[quiz.idx];
    quiz.selected = null;
    $('quiz-progress').textContent = `Question ${quiz.idx + 1} / ${quiz.questions.length}`;
    $('quiz-text').textContent = item.text;
    $('quiz-submit').disabled = true;
    $('quiz-submit').textContent = quiz.idx === quiz.questions.length - 1 ? 'Submit' : 'Submit answer';

    const box = $('quiz-options');
    box.replaceChildren();
    item.options.forEach((opt, i) => {
      const btn = el(
        'button',
        {
          type: 'button',
          class: 'option',
          role: 'radio',
          'aria-checked': 'false',
          onclick: () => selectOption(i),
        },
        [el('span', { class: 'key', text: `${i + 1}.` }), el('span', { text: opt })]
      );
      box.append(btn);
    });
    startTimer();
  }

  function selectOption(i) {
    if (!quiz || quiz.finishing) return;
    quiz.selected = i;
    $('quiz-options').querySelectorAll('.option').forEach((b, j) => b.setAttribute('aria-checked', String(j === i)));
    $('quiz-submit').disabled = false;
  }

  function startTimer() {
    clearInterval(quiz.timerId);
    const total = quiz.secondsPer * 1000;
    quiz.deadline = Date.now() + total;
    const tick = () => {
      const msLeft = Math.max(0, quiz.deadline - Date.now());
      const secs = Math.ceil(msLeft / 1000);
      $('quiz-timer').textContent = fmtTime(secs);
      $('quiz-timer').classList.toggle('low', secs <= 5);
      $('quiz-bar').style.width = `${(msLeft / total) * 100}%`;
      if (msLeft <= 0) advance();
    };
    tick();
    quiz.timerId = setInterval(tick, 200);
  }

  function advance() {
    if (!quiz || quiz.finishing) return;
    clearInterval(quiz.timerId);
    quiz.answers[quiz.idx] = quiz.selected;
    quiz.idx += 1;
    if (quiz.idx >= quiz.questions.length) finishQuiz();
    else renderQuestion();
  }

  async function finishQuiz() {
    quiz.finishing = true;
    clearInterval(quiz.timerId);
    $('quiz-submit').disabled = true;
    try {
      const result = await api('POST', '/api/quiz/submit', {
        attemptId: quiz.attemptId,
        answers: quiz.answers,
      });
      renderResult(result);
      show('result');
    } catch (err) {
      setMsg('quiz-error', `${err.message}. Your answers could not be submitted.`);
      $('quiz-submit').disabled = false;
      $('quiz-submit').textContent = 'Retry submit';
      quiz.finishing = false;
      quiz.idx = quiz.questions.length - 1;
      quiz.retrySubmit = true;
    }
  }

  $('quiz-submit').addEventListener('click', () => {
    if (quiz && quiz.retrySubmit) {
      quiz.retrySubmit = false;
      setMsg('quiz-error', '');
      return finishQuiz();
    }
    advance();
  });

  $('quiz-quit').addEventListener('click', () => {
    if (!quiz) return goHome();
    if (confirm('Quit this quiz? Your progress will not be saved.')) {
      clearInterval(quiz.timerId);
      quiz = null;
      goHome();
    }
  });

  document.addEventListener('keydown', (e) => {
    if ($('screen-quiz').hidden || !quiz || quiz.finishing) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < quiz.questions[quiz.idx].options.length) selectOption(i);
    } else if (e.key === 'Enter' && quiz.selected !== null && document.activeElement.tagName !== 'BUTTON') {
      advance();
    }
  });

  // ---------- result ----------
  function renderResult(r) {
    quiz = null;
    $('result-score').textContent = `${r.correct} / ${r.total}`;
    $('result-points').textContent = r.scoring ? `Points: ${r.points}` : '';
    const note = $('result-note');
    if (!r.scoring) note.textContent = 'Scoring is off, so this result was not saved.';
    else if (r.late) note.textContent = 'You went over the time allowance, so no points were awarded.';
    else note.textContent = 'Saved to your history.';
    note.hidden = false;

    const list = $('result-review');
    list.replaceChildren();
    for (const item of r.review) {
      const yours = item.chosen === null ? 'No answer' : item.options[item.chosen];
      const answerText = item.answer >= 0 ? item.options[item.answer] : '';
      const li = el('li', { class: item.isCorrect ? 'right' : 'wrong' }, [
        el('div', { class: 'q', text: item.text }),
        el('div', { class: 'a', text: `Your answer: ${yours}` }),
      ]);
      if (!item.isCorrect && answerText) li.append(el('div', { class: 'a', text: `Correct answer: ${answerText}` }));
      list.append(li);
    }
  }

  $('result-again').addEventListener('click', startQuiz);
  $('result-quit').addEventListener('click', goHome);

  // ---------- scores ----------
  async function openScores() {
    setMsg('home-error', '');
    try {
      const [h, b] = await Promise.all([api('GET', '/api/history'), api('GET', '/api/leaderboard')]);
      const hb = $('history-table').tBodies[0];
      hb.replaceChildren();
      for (const r of h.history) {
        hb.append(
          el('tr', {}, [
            el('td', { text: fmtDate(r.createdAt) }),
            el('td', { text: `${r.correct} / ${r.total}` }),
            el('td', { text: String(r.points) }),
          ])
        );
      }
      $('history-table').hidden = h.history.length === 0;
      $('history-empty').hidden = h.history.length !== 0;

      const bb = $('board-table').tBodies[0];
      bb.replaceChildren();
      b.leaderboard.forEach((r, i) => {
        bb.append(
          el('tr', {}, [
            el('td', { text: String(i + 1) }),
            el('td', { text: r.username }),
            el('td', { text: String(r.best) }),
            el('td', { text: String(r.plays) }),
          ])
        );
      });
      $('board-table').hidden = b.leaderboard.length === 0;
      $('board-empty').hidden = b.leaderboard.length !== 0;
      show('scores');
    } catch (err) {
      setMsg('home-error', err.message);
    }
  }

  // ---------- feedback ----------
  $('feedback-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('feedback-status', '');
    setMsg('feedback-error', '');
    try {
      await api('POST', '/api/feedback', { message: $('feedback-text').value });
      $('feedback-text').value = '';
      $('feedback-status').hidden = false;
    } catch (err) {
      setMsg('feedback-error', err.message);
    }
  });

  // ---------- admin ----------
  async function openAdmin() {
    setMsg('home-error', '');
    try {
      resetQuestionForm();
      await refreshAdmin();
      show('admin');
    } catch (err) {
      setMsg('home-error', err.message);
    }
  }

  let adminQuestions = [];

  async function refreshAdmin() {
    const [qs, fb] = await Promise.all([api('GET', '/api/admin/questions'), api('GET', '/api/admin/feedback')]);
    adminQuestions = qs.questions;
    $('q-count').textContent = String(adminQuestions.length);
    const list = $('q-list');
    list.replaceChildren();
    for (const q of adminQuestions) {
      const answerText = q.options[q.answer];
      list.append(
        el('li', {}, [
          el('div', { text: q.text }),
          el('div', { class: 'meta', text: `Answer: ${answerText}${q.category ? ` · ${q.category}` : ''}` }),
          el('div', { class: 'actions' }, [
            el('button', { type: 'button', text: 'Edit', onclick: () => editQuestion(q) }),
            el('button', { type: 'button', class: 'danger', text: 'Delete', onclick: () => deleteQuestion(q) }),
          ]),
        ])
      );
    }
    const fl = $('fb-list');
    fl.replaceChildren();
    for (const f of fb.feedback) {
      fl.append(
        el('li', {}, [
          el('div', { text: f.message }),
          el('div', { class: 'meta', text: `${f.username} · ${fmtDate(f.createdAt)}` }),
        ])
      );
    }
    $('fb-empty').hidden = fb.feedback.length !== 0;
  }

  function resetQuestionForm() {
    $('q-id').value = '';
    $('q-text').value = '';
    $('q-category').value = '';
    for (let i = 0; i < 4; i += 1) $(`q-opt-${i}`).value = '';
    document.querySelector('input[name="q-correct"][value="0"]').checked = true;
    $('q-form-title').textContent = 'Add a question';
    $('q-save').textContent = 'Add question';
    $('q-cancel').hidden = true;
    setMsg('q-error', '');
  }

  function editQuestion(q) {
    $('q-id').value = String(q.id);
    $('q-text').value = q.text;
    $('q-category').value = q.category || '';
    for (let i = 0; i < 4; i += 1) $(`q-opt-${i}`).value = q.options[i] || '';
    const radio = document.querySelector(`input[name="q-correct"][value="${Math.min(q.answer, 3)}"]`);
    if (radio) radio.checked = true;
    $('q-form-title').textContent = `Edit question #${q.id}`;
    $('q-save').textContent = 'Save changes';
    $('q-cancel').hidden = false;
    setMsg('q-error', '');
    $('q-text').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('q-text').focus({ preventScroll: true });
  }

  async function deleteQuestion(q) {
    if (!confirm(`Delete this question?\n\n${q.text}`)) return;
    try {
      await api('DELETE', `/api/admin/questions/${q.id}`);
      await refreshAdmin();
    } catch (err) {
      setMsg('q-error', err.message);
    }
  }

  $('q-cancel').addEventListener('click', resetQuestionForm);

  $('q-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('q-error', '');
    // Collect non-empty options and remap the correct index to the compacted list.
    const picked = Number(document.querySelector('input[name="q-correct"]:checked').value);
    const options = [];
    let answer = -1;
    for (let i = 0; i < 4; i += 1) {
      const v = $(`q-opt-${i}`).value.trim();
      if (!v) continue;
      if (i === picked) answer = options.length;
      options.push(v);
    }
    if (answer < 0) return setMsg('q-error', 'The option marked correct is empty.');
    const body = { text: $('q-text').value, options, answer, category: $('q-category').value };
    const id = $('q-id').value;
    try {
      if (id) await api('PUT', `/api/admin/questions/${id}`, body);
      else await api('POST', '/api/admin/questions', body);
      resetQuestionForm();
      await refreshAdmin();
    } catch (err) {
      setMsg('q-error', err.message);
    }
  });

  // ---------- boot ----------
  async function boot() {
    applyTheme(initialTheme());
    setAuthMode('login');
    try {
      const data = await api('GET', '/api/me');
      if (data.user) onSignedIn(data);
      else show('auth');
    } catch {
      show('auth');
    }
  }

  boot();
})();
