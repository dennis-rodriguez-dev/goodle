'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server');

let app;
let base;
let tmp;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goodle-test-'));
  app = createApp({ dataDir: tmp });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Minimal client with its own cookie jar.
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair;
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    return { status: res.status, data };
  };
}

const admin = client();
const player = client();

test('first registered user is admin, second is not', async () => {
  const a = await admin('POST', '/api/register', { username: 'alice', password: 'correct horse' });
  assert.equal(a.status, 201);
  assert.equal(a.data.user.isAdmin, true);
  const b = await player('POST', '/api/register', { username: 'bob_1', password: 'battery staple' });
  assert.equal(b.status, 201);
  assert.equal(b.data.user.isAdmin, false);
});

test('registration validates input and rejects duplicates', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/register', { username: 'x', password: 'longenough' })).status, 400);
  assert.equal((await c('POST', '/api/register', { username: 'carol', password: 'short' })).status, 400);
  assert.equal((await c('POST', '/api/register', { username: 'ALICE', password: 'longenough' })).status, 409);
});

test('login works, wrong password is rejected, /api/me reflects session', async () => {
  const c = client();
  assert.equal((await c('GET', '/api/me')).data.user, null);
  assert.equal((await c('POST', '/api/login', { username: 'alice', password: 'nope nope' })).status, 401);
  const ok = await c('POST', '/api/login', { username: 'alice', password: 'correct horse' });
  assert.equal(ok.status, 200);
  assert.equal((await c('GET', '/api/me')).data.user.username, 'alice');
  await c('POST', '/api/logout', {});
  assert.equal((await c('GET', '/api/me')).data.user, null);
});

test('API requires JSON content type for writes', async () => {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=alice&password=correct horse',
  });
  assert.equal(res.status, 415);
});

test('settings are validated and saved per user', async () => {
  const bad = await player('PUT', '/api/settings', {
    scoring: true,
    darkMode: false,
    secondsPerQuestion: 1,
    numQuestions: 5,
  });
  assert.equal(bad.status, 400);
  const good = await player('PUT', '/api/settings', {
    scoring: true,
    darkMode: true,
    secondsPerQuestion: 30,
    numQuestions: 5,
  });
  assert.equal(good.status, 200);
  assert.deepEqual(good.data.settings, { scoring: true, darkMode: true, secondsPerQuestion: 30, numQuestions: 5 });
  const other = await admin('GET', '/api/settings');
  assert.equal(other.data.settings.darkMode, false); // admin's own settings unaffected
});

test('quiz does not leak answers, grades server-side, and cannot be submitted twice', async () => {
  const start = await player('POST', '/api/quiz/start', {});
  assert.equal(start.status, 200);
  assert.equal(start.data.questions.length, 5);
  for (const q of start.data.questions) {
    assert.equal(q.answer, undefined);
    assert.ok(Array.isArray(q.options) && q.options.length >= 2);
  }

  // Admin can look up the real answers to build a perfect submission.
  const all = await admin('GET', '/api/admin/questions');
  const answerById = new Map(all.data.questions.map((q) => [q.id, q.answer]));
  const answers = start.data.questions.map((q) => answerById.get(q.id));

  const done = await player('POST', '/api/quiz/submit', { attemptId: start.data.attemptId, answers });
  assert.equal(done.status, 200);
  assert.equal(done.data.correct, 5);
  assert.equal(done.data.points, 50);
  assert.equal(done.data.saved, true);

  const again = await player('POST', '/api/quiz/submit', { attemptId: start.data.attemptId, answers });
  assert.equal(again.status, 409);

  const history = await player('GET', '/api/history');
  assert.equal(history.data.history.length, 1);
  const board = await player('GET', '/api/leaderboard');
  assert.equal(board.data.leaderboard[0].username, 'bob_1');
  assert.equal(board.data.leaderboard[0].best, 50);
});

test('wrong and missing answers score zero', async () => {
  const start = await player('POST', '/api/quiz/start', {});
  const all = await admin('GET', '/api/admin/questions');
  const answerById = new Map(all.data.questions.map((q) => [q.id, q.answer]));
  const answers = start.data.questions.map((q, i) => (i === 0 ? null : (answerById.get(q.id) + 1) % q.options.length));
  const done = await player('POST', '/api/quiz/submit', { attemptId: start.data.attemptId, answers });
  assert.equal(done.data.correct, 0);
  assert.equal(done.data.points, 0);
});

test('with scoring off the result is not saved', async () => {
  await player('PUT', '/api/settings', { scoring: false, darkMode: false, secondsPerQuestion: 20, numQuestions: 3 });
  const before = (await player('GET', '/api/history')).data.history.length;
  const start = await player('POST', '/api/quiz/start', {});
  const done = await player('POST', '/api/quiz/submit', {
    attemptId: start.data.attemptId,
    answers: start.data.questions.map(() => 0),
  });
  assert.equal(done.data.saved, false);
  assert.equal((await player('GET', '/api/history')).data.history.length, before);
});

test("one user cannot submit another user's quiz", async () => {
  const start = await player('POST', '/api/quiz/start', {});
  const res = await admin('POST', '/api/quiz/submit', {
    attemptId: start.data.attemptId,
    answers: start.data.questions.map(() => 0),
  });
  assert.equal(res.status, 404);
});

test('admin question endpoints are admin-only and validated', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/admin/questions')).status, 401);
  assert.equal((await player('GET', '/api/admin/questions')).status, 403);

  const bad = await admin('POST', '/api/admin/questions', { text: 'Pick one', options: ['a', 'b'], answer: 5 });
  assert.equal(bad.status, 400);

  const created = await admin('POST', '/api/admin/questions', {
    text: 'What is 2 + 2?',
    options: ['3', '4'],
    answer: 1,
    category: 'Math',
  });
  assert.equal(created.status, 201);
  const id = created.data.question.id;

  const updated = await admin('PUT', `/api/admin/questions/${id}`, {
    text: 'What is 3 + 3?',
    options: ['5', '6', '7'],
    answer: 1,
  });
  assert.equal(updated.status, 200);

  assert.equal((await admin('DELETE', `/api/admin/questions/${id}`)).status, 200);
  assert.equal((await admin('DELETE', `/api/admin/questions/${id}`)).status, 404);
});

test('feedback is saved and visible to the admin only', async () => {
  assert.equal((await player('POST', '/api/feedback', { message: 'ok' })).status, 400);
  assert.equal((await player('POST', '/api/feedback', { message: 'Love the dark mode!' })).status, 201);
  const inbox = await admin('GET', '/api/admin/feedback');
  assert.equal(inbox.data.feedback[0].message, 'Love the dark mode!');
  assert.equal((await player('GET', '/api/admin/feedback')).status, 403);
});

test('static files are served and path traversal is blocked', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /goodle/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

  // Use a raw request: fetch() would normalise "..", which hides the attack.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: app.server.address().port, path: '/%2e%2e/server.js', method: 'GET' },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.ok(status === 403 || status === 404, `expected 403/404, got ${status}`);
});
