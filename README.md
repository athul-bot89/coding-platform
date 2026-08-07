# Coding Platform - HackerRank Clone

Online coding assessment platform built with Next.js, using Judge0 for code execution.

## Features

### Proctored assessments (the main flow)

Build a timed, multi-question test, mint one link per candidate, copy it into your
own email. Candidate opens the link, signs in with the invited Google account,
accepts the rules, and gets a locked-down test screen.

- **Invite links** — one token per candidate, single-use, with an expiry window.
  The Google account used to sign in **must match** the invited address.
- **Server-authoritative timer** — `endsAt` is frozen when the candidate presses
  Start. Refreshing, closing the tab, or changing the system clock does nothing;
  every endpoint independently rejects work that arrives late.
- **Multi-question screen** — question rail with per-question state, Run (samples
  only) vs Submit (all cases), unlimited submissions, **best score per question**.
- **Autosave** — a refresh or crash restores the exact code and language.
- **Single-tab lock** — opening the test twice evicts the older window.
- **Per-candidate report** — score breakdown, the exact source that earned the
  points, a proctoring timeline, and paste-detection flags.

### Enforcement

- **Fullscreen is enforced, not just logged.** Leaving fullscreen hides the test
  behind a blocking overlay while the clock keeps running. Returning requires a
  click (the Fullscreen API cannot be re-entered without a user gesture, and
  `Escape` cannot be intercepted — the overlay is the only workable pattern).
- **Copy and paste are completely blocked, including inside Monaco**, across five
  layers: capture-phase clipboard listeners, Monaco keybinding overrides, the
  editor context menu, drag-and-drop and middle-click, and a content-jump
  detector as the backstop.
- **Auto-submit after N warnings** (per test, default 3; 0 disables). Fullscreen
  exits, tab switches and window blur count; blocked paste attempts are recorded
  but don't burn a warning. Adjust in `src/lib/proctor-config.ts`.
- **Code-integrity signals** — insertions larger than 40 chars are recorded as
  bursts, so code transcribed from a phone or second machine is flagged even
  though the clipboard was never involved.
- DevTools shortcuts, right-click and print are blocked and logged.

### Also

- **Google OAuth** — Secure authentication
- **Code Editor** — Monaco Editor (same as VS Code)
- **Multi-language support** — Python, C++, Java, JavaScript, TypeScript, Rust, C
- **Practice mode** — the un-proctored `/test/[slug]` flow is still there
- **Local SQLite database** (switch to Postgres/cloud later)
- **Judge0 integration** — Batch submissions, async polling

## Setup

### 1. Install dependencies

```bash
cd coding-platform
npm install
```

### 2. Environment variables

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

Required values:
- `JUDGE0_URL` — Your Judge0 server (default: `http://65.0.29.135:2358`)
- `JUDGE0_TOKEN` — Auth token from `secret.txt`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — From [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
- `NEXTAUTH_SECRET` — Generate with `openssl rand -base64 32`
- `NEXTAUTH_URL` — `http://localhost:3000`
- `NEXT_PUBLIC_BASE_URL` — Base for invite links. **Change this at deploy time**
  or every generated link will point at localhost.

### 3. Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create/select a project
3. Enable "Google+ API" or "Google Identity"
4. Go to Credentials → Create OAuth 2.0 Client
5. Add authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
6. Copy Client ID and Secret to `.env`

### 4. Initialize database

```bash
npx prisma db push
npx ts-node prisma/seed.ts
```

### 5. Make yourself admin

After signing in for the first time, run:
```bash
npx prisma studio
```
Find your user in the User table and change `role` to `admin`.

### 6. Run dev server

```bash
npm run dev
```

Open http://localhost:3000

## Running a real test

1. Sign in, then make yourself admin (step 5 above).
2. Go to **Admin → Tests & candidate links** (`/admin/assessments`).
3. **New test** — set a title, duration, and warning limit.
4. Add questions with point values, reorder them, and **Save changes**.
5. Paste candidates one per line (`Asha Menon <asha@example.com>`, `Name, email`,
   or a bare email), set how long the link stays valid, and **Generate links**.
6. **Copy link** per candidate and send it from your own email client.
7. When they finish, **View report** on that row shows the score breakdown, their
   code, the proctoring timeline, and any paste flags.

> **Before sending links to real candidates:** if your Google OAuth consent screen
> is still in *Testing* mode it only admits up to 100 manually-listed test users,
> so every candidate email must be added in Google Cloud Console first. Publish
> the app to lift that limit. This is the most common reason a link silently
> fails for an outside candidate.

## Architecture

Data model: **Assessment** (questions + duration + warning limit) → **Invitation**
(one link per candidate) → **TestSession** (one candidate's run, holding the
frozen clock, warning count, drafts, submissions and events).

```
src/
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/  — Google OAuth
│   │   ├── invites/[token]/start — Begin a test (idempotent, email-matched)
│   │   ├── session/[id]/        — Proctored test: state, heartbeat, draft,
│   │   │                          submit, event, metrics, finish
│   │   ├── submit/              — Practice submissions
│   │   ├── attempts/[id]/       — Poll grading results
│   │   ├── problems/            — List/get problems
│   │   ├── proctor/             — Practice-mode event log
│   │   └── admin/               — Assessments, invitations, session reports
│   ├── invite/[token]/          — Candidate gate: sign in, match, rules
│   ├── session/[id]/            — The proctored test screen
│   ├── admin/assessments/       — Build tests, generate candidate links
│   ├── admin/sessions/[id]/     — Per-candidate report
│   ├── test/[slug]/             — Un-proctored practice page
│   ├── problems/                — Problem list
│   └── admin/                   — Admin dashboard
├── components/
│   ├── CodeEditor.tsx           — Monaco wrapper + clipboard kill + metrics
│   ├── ProctorGuard.tsx         — Detection and blocking
│   ├── FullscreenGate.tsx       — Blocking overlay when not fullscreen
│   ├── TestTimer.tsx            — Countdown (display only)
│   └── SessionProvider.tsx      — Auth context
├── lib/
│   ├── assessment.ts            — Tokens, scoring, finalize, expiry sweep
│   ├── grading.ts               — Judge0 dispatch + poll + score (shared)
│   ├── session-guard.ts         — Ownership + liveness + clock check
│   ├── admin-guard.ts           — Admin-only route guard
│   ├── proctor-config.ts        — Violation policy and thresholds
│   ├── languages.ts             — Judge0 language IDs (single source)
│   ├── markdown.ts              — Problem/instruction rendering
│   ├── auth.ts                  — NextAuth config
│   ├── judge0.ts                — Judge0 API client
│   └── prisma.ts                — Database client
prisma/
├── schema.prisma                — Database schema
└── seed.ts                      — Sample problems + a sample assessment
```

### Timing and cleanup

There is no cron. Sessions whose clock expired while nobody was watching are
finalized lazily by `sweepExpiredSessions()`, called from session reads and the
admin list endpoints — so a candidate who closes their laptop still gets scored.

## Switching to Cloud Database

1. Change `datasource` in `prisma/schema.prisma`:
   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```
2. Update `DATABASE_URL` in `.env` to your Postgres connection string
3. Run `npx prisma db push`

## Judge0 API

The platform uses async batch submissions (never `wait=true`) per the Judge0 API reference.
All submissions use `base64_encoded=true` to handle compiler output with non-UTF-8 characters.
