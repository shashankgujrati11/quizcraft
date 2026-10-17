const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TOKEN_KEY = 'quizcraft_sql_token_v1';
const API_BASE = String(window.QUIZCRAFT_API_URL || '').replace(/\/$/, '');
let authMode = 'login';
let quizInProgress = null;
let questionIndex = 0;
let chosen = [];
let startedAt = 0;

function setMessage(selector, message, error = false) {
  const el = $(selector);
  if (el) { el.textContent = message; el.className = `message ${error ? 'error' : 'success'}`; }
}
function fmt(seconds) { return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`; }
function currentBaseUrl() {
  const url = new URL('./student.html', window.location.href);
  url.search = ''; url.hash = '';
  return url.href;
}
function apiConfigured() {
  return API_BASE && !API_BASE.includes('YOUR-BACKEND-URL') && (/^https:\/\//i.test(API_BASE) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(API_BASE));
}
async function api(path, options = {}, authenticated = false) {
  if (!apiConfigured()) throw new Error('Backend URL is not configured. Edit config.js and set QUIZCRAFT_API_URL to your deployed backend URL.');
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authenticated) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) throw new Error('Please sign in again.');
    headers.Authorization = `Bearer ${token}`;
  }
  let response;
  try { response = await fetch(`${API_BASE}${path}`, { ...options, headers }); }
  catch { throw new Error('Cannot reach the QuizCraft API. Check the backend URL, deployment status, and CORS settings.'); }
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    if (response.status === 401 && authenticated) localStorage.removeItem(TOKEN_KEY);
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
}
function setBusy(button, busy, busyText = 'Please wait…') {
  if (!button) return;
  if (busy) { button.dataset.originalText = button.innerHTML; button.disabled = true; button.textContent = busyText; }
  else { button.disabled = false; if (button.dataset.originalText) button.innerHTML = button.dataset.originalText; }
}
function makeStudentLink(code) { return `${currentBaseUrl()}?code=${encodeURIComponent(code)}`; }

async function initStudent() {
  const form = $('#studentLoginForm');
  if (!form) return;
  const params = new URLSearchParams(location.search);
  if (params.get('code')) $('#quizCode').value = params.get('code').toUpperCase();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const name = $('#studentName').value.trim();
    const code = $('#quizCode').value.trim().toUpperCase();
    if (!name) return setMessage('#studentLoginMessage', 'Enter your name to continue.', true);
    setBusy(button, true, 'Finding quiz…');
    try {
      const data = await api(`/api/public/quizzes/${encodeURIComponent(code)}`);
      if (!data.quiz.questions?.length) throw new Error('This quiz has no questions yet.');
      setMessage('#studentLoginMessage', `Access granted: ${data.quiz.title}`);
      showStudentQuiz(data.quiz, name);
    } catch (err) {
      setMessage('#studentLoginMessage', err.message, true);
      $('#studentQuizPanel').classList.add('hidden');
    } finally { setBusy(button, false); }
  });
}
function showStudentQuiz(quiz, name) {
  const panel = $('#studentQuizPanel');
  panel.classList.remove('hidden');
  quizInProgress = { ...quiz, studentName: name };
  questionIndex = 0; chosen = new Array(quiz.questions.length); startedAt = Date.now();
  renderStudentQuestion();
}
function renderStudentQuestion() {
  const panel = $('#studentQuizPanel');
  const q = quizInProgress.questions[questionIndex];
  panel.innerHTML = `<div class="quiz-session-head"><span class="pill">PRIVATE QUIZ</span><span>${questionIndex + 1} / ${quizInProgress.questions.length}</span></div><div class="progress-track"><span style="width:${(questionIndex + 1) / quizInProgress.questions.length * 100}%"></span></div><h3>${esc(q.question)}</h3><div class="session-options">${q.options.map((o, i) => `<button type="button" class="session-option ${chosen[questionIndex] === i ? 'selected' : ''}" data-choice="${i}"><span>${String.fromCharCode(65 + i)}</span>${esc(o)}</button>`).join('')}</div><div class="session-nav"><button type="button" class="btn ghost" id="studentPrev" ${questionIndex === 0 ? 'disabled' : ''}>← Previous</button><button type="button" class="btn primary" id="studentNext">${questionIndex === quizInProgress.questions.length - 1 ? 'Submit answers' : 'Next question →'}</button></div>`;
  panel.querySelectorAll('[data-choice]').forEach(b => b.addEventListener('click', () => { chosen[questionIndex] = Number(b.dataset.choice); renderStudentQuestion(); }));
  $('#studentPrev').addEventListener('click', () => { if (questionIndex > 0) { questionIndex--; renderStudentQuestion(); } });
  $('#studentNext').addEventListener('click', async () => {
    if (chosen[questionIndex] === undefined) { setMessage('#studentLoginMessage', 'Choose an answer before continuing.', true); return; }
    if (questionIndex < quizInProgress.questions.length - 1) { questionIndex++; renderStudentQuestion(); }
    else await finishStudentQuiz();
  });
}
async function finishStudentQuiz() {
  const qz = quizInProgress;
  const submit = $('#studentNext');
  setBusy(submit, true, 'Submitting…');
  try {
    const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const result = await api(`/api/public/quizzes/${encodeURIComponent(qz.code)}/submit`, {
      method: 'POST', body: JSON.stringify({ studentName: qz.studentName, answers: chosen, durationSeconds })
    });
    $('#studentQuizPanel').innerHTML = `<div class="result-medal">${result.score === result.total ? '🏆' : '✦'}</div><span class="eyebrow">SUBMISSION COMPLETE</span><h3>${result.score === result.total ? 'Perfect score!' : 'Well attempted!'}</h3><div class="result-big">${result.score}<span> / ${result.total}</span></div><p>You scored ${Math.round(result.score / result.total * 100)}% in ${fmt(result.duration)}.</p><div class="rank-card"><span>Your current rank</span><strong>#${result.rank}</strong><small>among ${result.attempts} submissions across all devices</small></div><button id="studentReturn" class="btn secondary full">Back to quiz login</button><p class="security-note">Your score was calculated by the server and saved to the shared SQL database.</p>`;
    $('#studentReturn').addEventListener('click', () => { $('#studentQuizPanel').classList.add('hidden'); $('#studentLoginForm').reset(); $('#quizCode').focus(); });
  } catch (err) {
    setMessage('#studentLoginMessage', err.message, true);
    if (submit) { submit.disabled = false; submit.textContent = 'Retry submission'; }
  }
}

function initConductor() {
  const form = $('#conductorAuthForm');
  if (!form) return;
  $$('.auth-tab').forEach(tab => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const button = $('#conductorSubmit');
    const email = $('#conductorEmail').value.trim().toLowerCase();
    const password = $('#conductorPassword').value;
    const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    setBusy(button, true, authMode === 'register' ? 'Creating account…' : 'Signing in…');
    try {
      const data = await api(endpoint, { method: 'POST', body: JSON.stringify({ email, password }) });
      localStorage.setItem(TOKEN_KEY, data.token);
      setMessage('#conductorMessage', authMode === 'register' ? 'Account created successfully.' : 'Signed in successfully.');
      await showDashboard(data.user.email);
    } catch (err) { setMessage('#conductorMessage', err.message, true); }
    finally { setBusy(button, false); }
  });
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) api('/api/auth/me', {}, true).then(data => showDashboard(data.user.email)).catch(() => localStorage.removeItem(TOKEN_KEY));
 
}
function setAuthMode(mode) {
  authMode = mode;
  $$('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  $('#conductorHeading').textContent = mode === 'login' ? 'Sign in to manage quizzes' : 'Create your conductor account';
  $('#conductorSubheading').textContent = mode === 'login' ? 'Sign in to access your quiz creator dashboard.' : 'Create a secure conductor account for your quizzes.';
  $('#conductorSubmit').innerHTML = mode === 'login' ? 'Sign in <span>→</span>' : 'Create account <span>→</span>';
  $('#conductorPassword').autocomplete(mode === 'login' ? 'current-password' : 'new-password');
  $('#conductorPassword').minLength = 8;
}
async function showDashboard(email) {
  $('#conductorAuthForm').classList.add('hidden');
  $$('.auth-tab').forEach(t => t.classList.add('hidden'));
  $('#conductorHeading').textContent = 'Your quiz studio';
  $('#conductorSubheading').textContent = `Signed in as ${email}`;
  $('#conductorMessage').textContent = '';
  $('#conductorDashboard').classList.remove('hidden');
  await renderDashboard(email);
}
async function renderDashboard(email) {
  const box = $('#conductorDashboard');
  box.innerHTML = `<div class="dashboard-title"><div><span class="eyebrow">YOUR PRIVATE QUIZZES</span><h3>Manage your quizzes</h3></div><button id="logoutConductor" class="btn ghost small">Sign out</button></div><form id="createQuizForm" class="create-quiz-form"><label for="quizTitle">Quiz title</label><input id="quizTitle" required maxlength="120" placeholder="e.g. Data Analytics Assessment"><label for="quizDescription">Description (optional)</label><input id="quizDescription" maxlength="500" placeholder="What is this quiz about?"><div class="builder-title"><h4>Questions</h4><button type="button" id="addNewQuestion" class="btn secondary small">＋ Add question</button></div><div id="newQuestionList"></div><button class="btn primary full" type="submit">Create private quiz</button></form><div id="dashboardMessage" class="message" aria-live="polite"></div><div class="my-quiz-list" id="myQuizList"><h4>Your quizzes</h4><p class="muted">Loading quizzes…</p></div>`;
  $('#logoutConductor').addEventListener('click', () => { localStorage.removeItem(TOKEN_KEY); location.reload(); });
  addQuestionForm();
  $('#addNewQuestion').addEventListener('click', addQuestionForm);
  $('#newQuestionList').addEventListener('click', e => { const b = e.target.closest('.remove-new-question'); if (b) { b.closest('.new-question-card').remove(); renumberNewQuestions(); } });
  $('#newQuestionList').addEventListener('input', e => { if (e.target.matches('.new-opt')) updateAnswerOptions(e.target.closest('.new-question-card')); });
  $('#createQuizForm').addEventListener('submit', async e => {
    e.preventDefault();
    const button = e.currentTarget.querySelector('button[type="submit"]');
    try {
      const title = $('#quizTitle').value.trim(), description = $('#quizDescription').value.trim();
      const questions = [...$('#newQuestionList').querySelectorAll('.new-question-card')].map((card, i) => {
        const question = card.querySelector('.new-q').value.trim();
        const options = [...card.querySelectorAll('.new-opt')].map(x => x.value.trim());
        const answerIndex = Number(card.querySelector('.new-answer').value);
        if (!question || options.some(x => !x) || new Set(options).size !== 4) throw new Error(`Question ${i + 1} needs text and four distinct, non-empty options.`);
        return { question, options, answerIndex };
      });
      if (!questions.length) throw new Error('Add at least one question.');
      setBusy(button, true, 'Creating quiz…');
      await api('/api/quizzes', { method: 'POST', body: JSON.stringify({ title, description, questions }) }, true);
      await renderDashboard(email);
      setMessage('#dashboardMessage', 'Quiz created successfully. Share its link or QR code with students.');
    } catch (err) { setMessage('#dashboardMessage', err.message, true); }
    finally { setBusy(button, false); }
  });
  try {
    const data = await api('/api/quizzes', {}, true);
    const list = $('#myQuizList');
    list.innerHTML = `<h4>Your quizzes <span>${data.quizzes.length}</span></h4>${data.quizzes.length ? data.quizzes.map(quizManageCard).join('') : '<p class="muted">You have not created a quiz yet. Add questions above to get started.</p>'}`;
    list.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', () => handleQuizAction(btn.dataset.action, btn.dataset.id)));
  } catch (err) { $('#myQuizList').innerHTML = `<h4>Your quizzes</h4><p class="message error">${esc(err.message)}</p>`; }
}
function quizManageCard(q) {
  const link = makeStudentLink(q.code);
  return `<article class="managed-quiz"><div class="managed-head"><div><span class="pill">${q.active ? 'PRIVATE · OPEN' : 'CLOSED'}</span><h4>${esc(q.title)}</h4><p>${q.questionCount} questions · ${q.attempts} attempts</p></div><span class="quiz-code">${esc(q.code)}</span></div>${q.description ? `<p>${esc(q.description)}</p>` : ''}<div class="share-link"><label>Student access link</label><input readonly value="${esc(link)}" id="link-${esc(q.id)}"><button type="button" class="btn secondary small" data-action="copy" data-id="${esc(q.id)}">Copy link</button></div><div class="share-actions"><button type="button" class="btn primary small" data-action="qr" data-id="${esc(q.id)}">Show QR code</button><button type="button" class="btn secondary small" data-action="leaderboard" data-id="${esc(q.id)}">View leaderboard</button><button type="button" class="btn ghost small" data-action="toggle" data-id="${esc(q.id)}" data-active="${q.active ? 'true' : 'false'}">${q.active ? 'Close quiz' : 'Reopen quiz'}</button></div><div class="qr-area hidden" id="qr-${esc(q.id)}"><div class="qr-image"></div><p>Scan to open this quiz on any device connected to the internet.</p></div><div class="mini-leaderboard hidden" id="board-${esc(q.id)}"></div></article>`;
}
function addQuestionForm() {
  const list = $('#newQuestionList');
  const n = list.querySelectorAll('.new-question-card').length;
  list.insertAdjacentHTML('beforeend', `<div class="new-question-card"><div class="builder-title"><span class="question-number">QUESTION ${n + 1}</span><button type="button" class="remove-new-question">Remove ×</button></div><label>Question</label><textarea class="new-q" required maxlength="1000" placeholder="Write your question"></textarea><div class="new-options">${[0,1,2,3].map(i => `<div><label>Option ${String.fromCharCode(65+i)}</label><input class="new-opt" required maxlength="500" placeholder="Answer ${String.fromCharCode(65+i)}"></div>`).join('')}</div><label>Correct answer</label><select class="new-answer"><option value="0">A</option><option value="1">B</option><option value="2">C</option><option value="3">D</option></select></div>`);
}
function renumberNewQuestions() { $$('#newQuestionList .new-question-card').forEach((c, i) => c.querySelector('.question-number').textContent = `QUESTION ${i + 1}`); }
function updateAnswerOptions(card) {
  const select = card.querySelector('.new-answer');
  const selected = Number(select.value);
  const opts = [...card.querySelectorAll('.new-opt')].map(i => i.value.trim());
  select.innerHTML = opts.map((o, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${String.fromCharCode(65+i)}${o ? ' — ' + esc(o.slice(0, 40)) : ''}</option>`).join('');
}
async function handleQuizAction(action, id) {
  const linkInput = $(`#link-${CSS.escape(String(id))}`);
  if (action === 'copy') {
    if (!linkInput) return;
    try { await navigator.clipboard.writeText(linkInput.value); alert('Student link copied.'); }
    catch { linkInput.focus(); linkInput.select(); alert('The link is selected. Press Ctrl+C to copy it.'); }
  } else if (action === 'qr') {
    const area = $(`#qr-${CSS.escape(String(id))}`); area.classList.toggle('hidden');
    const image = area.querySelector('.qr-image'); image.innerHTML = '';
    if (!area.classList.contains('hidden')) {
      const url = linkInput?.value;
      if (window.QRCode && url) new QRCode(image, { text: url, width: 180, height: 180, colorDark: '#201d3b', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      else image.textContent = 'QR library unavailable. Copy the student link instead.';
    }
  } else if (action === 'toggle') {
    const button = $(`[data-action="toggle"][data-id="${CSS.escape(String(id))}"]`);
    const active = button?.dataset.active !== 'true';
    try { await api(`/api/quizzes/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ active }) }, true); await renderDashboard($('#conductorSubheading').textContent.replace('Signed in as ', '')); }
    catch (err) { alert(err.message); }
  } else if (action === 'leaderboard') {
    const area = $(`#board-${CSS.escape(String(id))}`); area.classList.toggle('hidden');
    if (!area.classList.contains('hidden')) {
      area.innerHTML = '<p class="muted">Loading leaderboard…</p>';
      try {
        const data = await api(`/api/quizzes/${encodeURIComponent(id)}/leaderboard`, {}, true);
        area.innerHTML = `<h4>Leaderboard</h4>${data.leaderboard.length ? `<div class="table-scroll"><table><thead><tr><th>Rank</th><th>Student</th><th>Score</th><th>Time</th></tr></thead><tbody>${data.leaderboard.map(a => `<tr><td>#${a.rank}</td><td>${esc(a.student)}</td><td>${a.score}/${a.total}</td><td>${fmt(a.duration)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No students have submitted this quiz yet.</p>'}`;
      } catch (err) { area.innerHTML = `<p class="message error">${esc(err.message)}</p>`; }
    }
  }
}
initStudent();
initConductor();
