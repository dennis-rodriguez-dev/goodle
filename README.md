# goodle (dynamic edition)

A timed trivia quiz with real accounts, a database and an admin editor. It recreates the screens of the
static [goodle](https://mimura-arieljr.github.io/goodle/) (login, Start, Settings, timer, Submit, RESULT,
Try Again / Quit, "Any feedback?", Logout), but everything is served and stored by a backend.

## Run it

Requires **Node 22.13 or newer** (uses the built-in `node:sqlite`). No `npm install` needed: there are no dependencies.

```bash
npm start            # http://127.0.0.1:3000
npm test             # 12 API tests
```

Options (environment variables): `PORT` (default 3000), `HOST` (default 127.0.0.1), `DATA_DIR` (default `./data`),
`COOKIE_SECURE=1` when served over HTTPS.

The **first account you register becomes the admin** and gets an Admin button to add, edit and delete questions
and read feedback. 35 general-trivia questions are seeded automatically on first run.

## What is dynamic

| Static original | This version |
| --- | --- |
| One shared password in the page | Per-user accounts, scrypt-hashed passwords, HttpOnly session cookies |
| Questions baked into the JS | Questions in SQLite, edited from the Admin screen |
| Settings lost on reload | Settings saved per user in the database |
| Answers checkable in the browser | Answers never sent to the browser; grading happens on the server |
| No history | Saved results, personal history and a leaderboard |
| Feedback via email link | Feedback form stored in the database |

## Project layout

```
server.js            HTTP server, API routes, SQLite schema, static file serving
seed.js              starter questions
public/              index.html, style.css, app.js (front end, no build step)
test/smoke.test.js   API tests (node:test)
data/                created at runtime (SQLite database)
```

## API

All bodies are JSON (`Content-Type: application/json` is required for writes).

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/register`, `/api/login`, `/api/logout` | accounts and sessions |
| GET | `/api/me` | current user and settings (`user: null` if signed out) |
| GET / PUT | `/api/settings` | scoring, dark mode, seconds per question, number of questions |
| POST | `/api/quiz/start` | pick random questions (without answers) and open an attempt |
| POST | `/api/quiz/submit` | grade an attempt once; returns score, points and a review |
| GET | `/api/history`, `/api/leaderboard` | scores |
| POST | `/api/feedback` | send feedback |
| GET / POST / PUT / DELETE | `/api/admin/questions[/:id]` | admin question editor |
| GET | `/api/admin/feedback` | admin feedback inbox |

Scoring: 10 points per correct answer. If scoring is off, the result is shown but not saved. A quiz that takes
longer than its time allowance (plus 15 seconds of grace) earns no points.

## Notes

- **Express was not used.** This build environment had no network access to install packages, so the server uses
  Node's built-in `http` module. The route handlers in `handleApi` map one-to-one onto Express routes if your
  assignment requires it (`app.post('/api/login', ...)` and so on).
- `node:sqlite` prints an "ExperimentalWarning" on some Node versions; the npm scripts silence it.
- Login attempts are throttled in memory (8 failures per IP + username per 10 minutes). For a real deployment,
  put it behind HTTPS and use a persistent rate limiter.
