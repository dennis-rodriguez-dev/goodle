'use strict';

/**
 * goodle (dynamic) - a timed trivia quiz with accounts, a database and an admin editor.
 *
 * Zero dependencies: Node's built-in http, crypto and node:sqlite modules only.
 * Requires Node >= 22.13.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { SEED_QUESTIONS } = require('./seed');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1'; // set to 1 when served over HTTPS
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const POINTS_PER_CORRECT = 10;
const LATE_GRACE_MS = 15 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  const expected = Buffer.from(hashHex || '', 'hex');
  if (!saltHex || expected.length === 0) return false;
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function createApp({ dataDir = DEFAULT_DATA_DIR } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'goodle.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      options TEXT NOT NULL,
      answer INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      scoring INTEGER NOT NULL DEFAULT 1,
      dark_mode INTEGER NOT NULL DEFAULT 0,
      seconds_per_question INTEGER NOT NULL DEFAULT 20,
      num_questions INTEGER NOT NULL DEFAULT 10
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question_ids TEXT NOT NULL,
      seconds_per_question INTEGER NOT NULL,
      scoring INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      submitted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      correct INTEGER NOT NULL,
      total INTEGER NOT NULL,
      points INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed starter questions on first run.
  if (db.prepare('SELECT COUNT(*) AS c FROM questions').get().c === 0) {
    const ins = db.prepare('INSERT INTO questions (text, options, answer, category) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const [text, options, answer, category] of SEED_QUESTIONS) {
        ins.run(text, JSON.stringify(options), answer, category);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function cleanup() {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('DELETE FROM attempts WHERE started_at < ?').run(Date.now() - 24 * 60 * 60 * 1000);
  }
  cleanup();
  const cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
  cleanupTimer.unref();

  // ---- login throttling (in memory) ---------------------------------------
  const failures = new Map(); // key -> { count, resetAt }
  const MAX_FAILURES = 8;
  const FAILURE_WINDOW_MS = 10 * 60 * 1000;
  function throttled(key) {
    const f = failures.get(key);
    if (!f) return false;
    if (f.resetAt < Date.now()) {
      failures.delete(key);
      return false;
    }
    return f.count >= MAX_FAILURES;
  }
  function recordFailure(key) {
    const f = failures.get(key);
    if (!f || f.resetAt < Date.now()) failures.set(key, { count: 1, resetAt: Date.now() + FAILURE_WINDOW_MS });
    else f.count += 1;
  }

  // ---- helpers ------------------------------------------------------------
  function send(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(payload);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers['content-type'] || '');
      if (!type.toLowerCase().startsWith('application/json')) {
        reject(new HttpError(415, 'Content-Type must be application/json'));
        req.resume();
        return;
      }
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, 'Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          const parsed = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return reject(new HttpError(400, 'JSON body must be an object'));
          }
          resolve(parsed);
        } catch {
          reject(new HttpError(400, 'Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function setSessionCookie(token, maxAgeSeconds) {
    return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${COOKIE_SECURE ? '; Secure' : ''}`;
  }

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      sha256(token),
      userId,
      Date.now() + SESSION_MS
    );
    return setSessionCookie(token, Math.floor(SESSION_MS / 1000));
  }

  function currentUser(req) {
    const token = parseCookies(req).sid;
    if (!token) return null;
    const tokenHash = sha256(token);
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.is_admin, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      )
      .get(tokenHash);
    if (!row || row.expires_at < Date.now()) return null;
    return { id: Number(row.id), username: row.username, isAdmin: !!row.is_admin, tokenHash };
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Please log in');
    return user;
  }

  function requireAdmin(req) {
    const user = requireUser(req);
    if (!user.isAdmin) throw new HttpError(403, 'Admin access required');
    return user;
  }

  const publicUser = (u) => ({ id: u.id, username: u.username, isAdmin: u.isAdmin });

  function getSettings(userId) {
    const row = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId);
    return {
      scoring: !!row.scoring,
      darkMode: !!row.dark_mode,
      secondsPerQuestion: Number(row.seconds_per_question),
      numQuestions: Number(row.num_questions),
    };
  }

  function questionCount() {
    return Number(db.prepare('SELECT COUNT(*) AS c FROM questions').get().c);
  }

  function parseQuestionInput(body) {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length < 3 || text.length > 300) throw new HttpError(400, 'Question text must be 3-300 characters');
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 6) {
      throw new HttpError(400, 'Provide between 2 and 6 options');
    }
    const options = body.options.map((o) => (typeof o === 'string' ? o.trim() : ''));
    if (options.some((o) => o.length === 0 || o.length > 120)) {
      throw new HttpError(400, 'Each option must be 1-120 characters');
    }
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
      throw new HttpError(400, 'Options must be different from each other');
    }
    if (!isInt(body.answer) || body.answer < 0 || body.answer >= options.length) {
      throw new HttpError(400, 'Choose which option is correct');
    }
    const category = typeof body.category === 'string' ? body.category.trim().slice(0, 40) : '';
    return { text, options, answer: body.answer, category };
  }

  const adminQuestion = (r) => ({
    id: Number(r.id),
    text: r.text,
    options: JSON.parse(r.options),
    answer: Number(r.answer),
    category: r.category,
  });

  // ---- API ----------------------------------------------------------------
  async function handleApi(req, res, pathname) {
    const method = req.method;
    const clientIp = req.socket.remoteAddress || 'unknown';

    // Note: every route that reads a body goes through readJson(), which requires
    // Content-Type: application/json. Together with SameSite=Lax cookies, that blocks
    // cross-site form posts (CSRF).

    // --- auth ---
    if (method === 'POST' && pathname === '/api/register') {
      const body = await readJson(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
        throw new HttpError(400, 'Username must be 3-20 letters, numbers or underscores');
      }
      if (password.length < 8 || password.length > 72) {
        throw new HttpError(400, 'Password must be 8-72 characters');
      }
      const passHash = await hashPassword(password);
      const isFirst = Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c) === 0;
      let userId;
      try {
        const info = db
          .prepare('INSERT INTO users (username, pass_hash, is_admin) VALUES (?, ?, ?)')
          .run(username, passHash, isFirst ? 1 : 0);
        userId = Number(info.lastInsertRowid);
      } catch (err) {
        if (/UNIQUE/i.test(String(err.message))) throw new HttpError(409, 'That username is already taken');
        throw err;
      }
      db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(userId);
      const cookie = createSession(userId);
      return send(
        res,
        201,
        { user: { id: userId, username, isAdmin: isFirst }, settings: getSettings(userId) },
        { 'Set-Cookie': cookie }
      );
    }

    if (method === 'POST' && pathname === '/api/login') {
      const body = await readJson(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const key = `${clientIp}|${username.toLowerCase()}`;
      if (throttled(key)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
      const row = db.prepare('SELECT id, username, pass_hash, is_admin FROM users WHERE username = ?').get(username);
      // Always run a hash so timing doesn't reveal whether the username exists.
      const ok = row
        ? await verifyPassword(password, row.pass_hash)
        : (await hashPassword(password || 'x'), false);
      if (!ok) {
        recordFailure(key);
        throw new HttpError(401, 'Invalid username or password');
      }
      failures.delete(key);
      const userId = Number(row.id);
      const cookie = createSession(userId);
      return send(
        res,
        200,
        { user: { id: userId, username: row.username, isAdmin: !!row.is_admin }, settings: getSettings(userId) },
        { 'Set-Cookie': cookie }
      );
    }

    if (method === 'POST' && pathname === '/api/logout') {
      await readJson(req);
      const user = currentUser(req);
      if (user) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(user.tokenHash);
      return send(res, 200, { ok: true }, { 'Set-Cookie': setSessionCookie('', 0) });
    }

    if (method === 'GET' && pathname === '/api/me') {
      const user = currentUser(req);
      if (!user) return send(res, 200, { user: null });
      return send(res, 200, { user: publicUser(user), settings: getSettings(user.id) });
    }

    // --- settings ---
    if (method === 'GET' && pathname === '/api/settings') {
      const user = requireUser(req);
      return send(res, 200, { settings: getSettings(user.id), maxQuestions: Math.min(50, questionCount()) });
    }

    if (method === 'PUT' && pathname === '/api/settings') {
      const user = requireUser(req);
      const body = await readJson(req);
      const maxQuestions = Math.min(50, questionCount());
      if (typeof body.scoring !== 'boolean' || typeof body.darkMode !== 'boolean') {
        throw new HttpError(400, 'scoring and darkMode must be true or false');
      }
      if (!isInt(body.secondsPerQuestion) || body.secondsPerQuestion < 5 || body.secondsPerQuestion > 120) {
        throw new HttpError(400, 'Time per question must be a whole number from 5 to 120 seconds');
      }
      if (!isInt(body.numQuestions) || body.numQuestions < 1 || body.numQuestions > maxQuestions) {
        throw new HttpError(400, `Number of questions must be a whole number from 1 to ${maxQuestions}`);
      }
      db.prepare(
        `UPDATE settings SET scoring = ?, dark_mode = ?, seconds_per_question = ?, num_questions = ?
         WHERE user_id = ?`
      ).run(body.scoring ? 1 : 0, body.darkMode ? 1 : 0, body.secondsPerQuestion, body.numQuestions, user.id);
      return send(res, 200, { settings: getSettings(user.id), maxQuestions });
    }

    // --- quiz ---
    if (method === 'POST' && pathname === '/api/quiz/start') {
      const user = requireUser(req);
      await readJson(req);
      const settings = getSettings(user.id);
      const count = Math.min(settings.numQuestions, questionCount());
      if (count < 1) throw new HttpError(409, 'There are no questions yet');
      const rows = db.prepare('SELECT id, text, options FROM questions ORDER BY RANDOM() LIMIT ?').all(count);
      const attemptId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO attempts (id, user_id, question_ids, seconds_per_question, scoring, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        attemptId,
        user.id,
        JSON.stringify(rows.map((r) => Number(r.id))),
        settings.secondsPerQuestion,
        settings.scoring ? 1 : 0,
        Date.now()
      );
      return send(res, 200, {
        attemptId,
        secondsPerQuestion: settings.secondsPerQuestion,
        scoring: settings.scoring,
        questions: rows.map((r) => ({ id: Number(r.id), text: r.text, options: JSON.parse(r.options) })),
      });
    }

    if (method === 'POST' && pathname === '/api/quiz/submit') {
      const user = requireUser(req);
      const body = await readJson(req);
      const attempt = db
        .prepare('SELECT * FROM attempts WHERE id = ? AND user_id = ?')
        .get(String(body.attemptId || ''), user.id);
      if (!attempt) throw new HttpError(404, 'Quiz not found');
      const ids = JSON.parse(attempt.question_ids);
      if (!Array.isArray(body.answers) || body.answers.length !== ids.length) {
        throw new HttpError(400, 'answers must list one entry per question');
      }
      // Claim the attempt atomically so it can only be graded once.
      const claimed = db.prepare('UPDATE attempts SET submitted = 1 WHERE id = ? AND submitted = 0').run(attempt.id);
      if (Number(claimed.changes) !== 1) throw new HttpError(409, 'This quiz was already submitted');

      const getQ = db.prepare('SELECT id, text, options, answer FROM questions WHERE id = ?');
      let correct = 0;
      const review = ids.map((id, i) => {
        const q = getQ.get(id);
        if (!q) return { id, text: '(question was removed)', options: [], answer: -1, chosen: null, isCorrect: false };
        const options = JSON.parse(q.options);
        const raw = body.answers[i];
        const chosen = isInt(raw) && raw >= 0 && raw < options.length ? raw : null;
        const isCorrect = chosen === Number(q.answer);
        if (isCorrect) correct += 1;
        return { id: Number(q.id), text: q.text, options, answer: Number(q.answer), chosen, isCorrect };
      });

      const allowedMs = ids.length * Number(attempt.seconds_per_question) * 1000 + LATE_GRACE_MS;
      const late = Date.now() - Number(attempt.started_at) > allowedMs;
      const scoring = !!attempt.scoring;
      const points = scoring && !late ? correct * POINTS_PER_CORRECT : 0;
      if (scoring) {
        db.prepare('INSERT INTO results (user_id, correct, total, points) VALUES (?, ?, ?, ?)').run(
          user.id,
          correct,
          ids.length,
          points
        );
      }
      return send(res, 200, { correct, total: ids.length, points, scoring, late, saved: scoring, review });
    }

    // --- scores ---
    if (method === 'GET' && pathname === '/api/history') {
      const user = requireUser(req);
      const rows = db
        .prepare('SELECT correct, total, points, created_at FROM results WHERE user_id = ? ORDER BY id DESC LIMIT 20')
        .all(user.id);
      return send(res, 200, {
        history: rows.map((r) => ({
          correct: Number(r.correct),
          total: Number(r.total),
          points: Number(r.points),
          createdAt: r.created_at,
        })),
      });
    }

    if (method === 'GET' && pathname === '/api/leaderboard') {
      requireUser(req);
      const rows = db
        .prepare(
          `SELECT u.username AS username, MAX(r.points) AS best, COUNT(*) AS plays
           FROM results r JOIN users u ON u.id = r.user_id
           GROUP BY u.id
           ORDER BY best DESC, plays ASC, u.username ASC
           LIMIT 10`
        )
        .all();
      return send(res, 200, {
        leaderboard: rows.map((r) => ({ username: r.username, best: Number(r.best), plays: Number(r.plays) })),
      });
    }

    // --- feedback ---
    if (method === 'POST' && pathname === '/api/feedback') {
      const user = requireUser(req);
      const body = await readJson(req);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (message.length < 3 || message.length > 1000) throw new HttpError(400, 'Feedback must be 3-1000 characters');
      db.prepare('INSERT INTO feedback (user_id, message) VALUES (?, ?)').run(user.id, message);
      return send(res, 201, { ok: true });
    }

    // --- admin ---
    if (method === 'GET' && pathname === '/api/admin/questions') {
      requireAdmin(req);
      const rows = db.prepare('SELECT * FROM questions ORDER BY id DESC').all();
      return send(res, 200, { questions: rows.map(adminQuestion) });
    }

    if (method === 'POST' && pathname === '/api/admin/questions') {
      requireAdmin(req);
      const q = parseQuestionInput(await readJson(req));
      const info = db
        .prepare('INSERT INTO questions (text, options, answer, category) VALUES (?, ?, ?, ?)')
        .run(q.text, JSON.stringify(q.options), q.answer, q.category);
      return send(res, 201, { question: { id: Number(info.lastInsertRowid), ...q } });
    }

    const adminQ = pathname.match(/^\/api\/admin\/questions\/(\d+)$/);
    if (adminQ && method === 'PUT') {
      requireAdmin(req);
      const q = parseQuestionInput(await readJson(req));
      const info = db
        .prepare('UPDATE questions SET text = ?, options = ?, answer = ?, category = ? WHERE id = ?')
        .run(q.text, JSON.stringify(q.options), q.answer, q.category, Number(adminQ[1]));
      if (Number(info.changes) !== 1) throw new HttpError(404, 'Question not found');
      return send(res, 200, { question: { id: Number(adminQ[1]), ...q } });
    }
    if (adminQ && method === 'DELETE') {
      requireAdmin(req);
      const info = db.prepare('DELETE FROM questions WHERE id = ?').run(Number(adminQ[1]));
      if (Number(info.changes) !== 1) throw new HttpError(404, 'Question not found');
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/admin/feedback') {
      requireAdmin(req);
      const rows = db
        .prepare(
          `SELECT f.message, f.created_at, u.username
           FROM feedback f JOIN users u ON u.id = f.user_id
           ORDER BY f.id DESC LIMIT 50`
        )
        .all();
      return send(res, 200, {
        feedback: rows.map((r) => ({ username: r.username, message: r.message, createdAt: r.created_at })),
      });
    }

    throw new HttpError(404, 'Not found');
  }

  // ---- static files -------------------------------------------------------
  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Bad request');
    }
    if (rel.includes('\0')) throw new HttpError(400, 'Bad request');
    if (rel === '/') rel = '/index.html';
    const full = path.normalize(path.join(PUBLIC_DIR, rel));
    if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    if (!stat.isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  }

  // ---- server -------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
    );
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
      else serveStatic(req, res, pathname);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        if (pathname_isApi(req.url)) return send(res, err.status, { error: err.message });
        res.writeHead(err.status, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(err.message);
      }
      console.error(err);
      if (pathname_isApi(req.url)) return send(res, 500, { error: 'Something went wrong on the server' });
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Server error');
    }
  });

  function pathname_isApi(url) {
    return String(url || '').startsWith('/api/');
  }

  server.on('close', () => {
    clearInterval(cleanupTimer);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  return { server, db };
}

module.exports = { createApp };

if (require.main === module) {
  const { server } = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`goodle running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log('The first account you register becomes the admin.');
  });
}
