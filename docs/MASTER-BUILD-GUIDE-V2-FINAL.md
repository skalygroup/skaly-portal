# MASTER BUILD GUIDE — V2 (FINAL)
## Scaly Business Portal — From Zero to Production
## Written for Mohammed Arslaan • Antigravity + Claude Sonnet 4.6 • Plain English, Every Step
**Version 2.0** • June 2026 • Supersedes `MASTER-BUILD-GUIDE-FROM-ZERO-PROMPT_S-RESULT.md`

---

## 0. READ THIS FIRST

You currently have:
- ✅ 14 spec documents (your blueprint — `01-PRD.md` through `14-PRE-BUILD-AUDIT.md`)
- ✅ `FIX-GUIDE-V2-COMPLETE.md` — 21 surgical fixes for the gaps the audit found
- ✅ `CRITICAL-PATCHES.md` — drop-in code for blocker/critical findings
- ✅ `SPRINT-0-READINESS-CHECKLIST.md` — the gate you cross before Sprint 1
- ❌ No code, no accounts set up, no tools installed, no project folder

**This guide is the orchestration layer.** It tells you, in order: which tool to install, which account to create, which file to make Claude write, in which order. Every other document you have is referenced from this one. You should never need to flip between three documents — this one tells you when to pull in Fix Guide V2 or the audit's patches.

**Your role:** Architect and inspector. You decide what to build, you verify each step, you say "next."

**Claude's role:** Construction crew. It writes the actual TypeScript, SQL, React, and config files based on the prompts you paste.

**The 13 spec docs are the blueprints.** Claude reads them. You don't need to.

### What "vibe coding" looks like in practice

You open Antigravity → you open your project folder → you paste a prompt block from this guide into the chat → Claude reads the relevant spec section, writes the files, you verify in the browser or terminal → you say next → repeat. **You do not write TypeScript yourself.** You read the verification output and decide if it's right. That's it.

If something is wrong, you don't fix it — you tell Claude what's wrong and let it fix it.

### What this guide will NOT do

- It will not teach you TypeScript, React, or PostgreSQL syntax. The 13 specs reference these, Claude knows them, you don't need to.
- It will not optimise for speed. The build takes 14 sprints (~14 weeks) — that's the IMPL-PLAN timeline. The goal is **right**, not fast.
- It will not let you skip verification. Every step has a verification gate. If you skip them, you'll be debugging Sprint 7 when the bug was planted in Sprint 2.

---

## PART 1 — UNDERSTAND YOUR TOOLS: ANTIGRAVITY, CLAUDE CODE, AND THE MODEL

This section is critical because the previous guide got it wrong. Read carefully.

### 1.1 What is Antigravity?

**Antigravity is Google's agentic IDE**, released November 2025. It's a desktop application that looks and feels like VS Code (it's actually a VS Code fork under the hood) but is built around AI agents that read your files and write code for you.

- Website: **`antigravity.google`** (NOT `antigravity.ai` — that's wrong)
- Available for: Mac, Windows, Linux
- Free during preview (as of the time of writing — check pricing on the site)
- Comes with multiple models you can switch between: **Claude Sonnet 4.6 (Anthropic)**, **Gemini 3 Pro (Google)**, and others
- Has a built-in "Agent" mode that can browse files, run commands, edit files, and verify its own work

**Antigravity is not Anthropic's product.** Don't expect your Anthropic account to bill you for Antigravity usage — Google bills it (or it's free during preview). Antigravity uses Claude as one of its models, but the IDE itself is Google's.

### 1.2 What is Claude Code?

**Claude Code is Anthropic's coding agent.** It's a separate product from Antigravity. It comes in several forms:

| Form | Description |
|---|---|
| **CLI** | Run `claude` in your terminal. Talks to your codebase via the command line. |
| **VS Code extension** | Install from the VS Code marketplace. Runs inside VS Code (and any VS Code fork, including Antigravity). |
| **Desktop app** | Standalone application — "Claude Code" or "Claude Cowork" depending on the edition. |
| **Mobile app** | Run delegated coding tasks from your phone. |

Claude Code uses Claude Sonnet 4.6 (or whichever Anthropic model you pick) and is billed by Anthropic.

### 1.3 Three paths — pick one

You have three valid setups. **Recommendation: Path A** (simplest for your goal of vibe coding).

#### Path A — Antigravity + Claude Sonnet 4.6 (RECOMMENDED)

You use Antigravity as your IDE. Inside Antigravity, you switch the active model to Claude Sonnet 4.6 (or 4.7 if available). Antigravity's built-in agent does the file reading and writing. Everything happens in one app. No CLI to install. No extra subscription.

- **Pros:** One tool, one account, free during preview, Google handles billing
- **Cons:** Tied to Antigravity's UX — if Google removes a feature you depend on, you're stuck

#### Path B — Antigravity + Claude Code CLI in its terminal

You use Antigravity as your IDE but additionally install the Claude Code CLI. You run `claude` in Antigravity's built-in terminal for specific tasks where you want Anthropic's official agent (e.g., long-running refactors, agentic test runs).

- **Pros:** Best of both — Antigravity's UI plus Claude Code's official terminal agent
- **Cons:** Two tools, two billing surfaces (Anthropic bills Claude Code usage)

#### Path C — Plain VS Code + Claude Code VS Code extension

You skip Antigravity entirely. Use real VS Code from Microsoft. Install Claude Code's VS Code extension from the marketplace. All Anthropic, no Google.

- **Pros:** Single vendor (Anthropic), more predictable
- **Cons:** Loses Antigravity's agent-first UX

**For this guide:** I'll assume **Path A**. If you pick B or C, the only difference is *where you paste the prompts* — everything else (specs, code, structure) is identical.

### 1.4 Installing Antigravity

1. Open your browser and go to **`antigravity.google`**.
2. Click **Download** for your operating system (Mac / Windows / Linux).
3. Run the installer. On Mac it'll be a `.dmg` you drag into `/Applications`. On Windows it's an `.exe`. On Linux it's an `AppImage` or `.deb`.
4. Open Antigravity. It'll ask you to sign in — use your Google account (the one you use for Skaly Group, if you have one set up).
5. When asked to pick a default model, choose **Claude Sonnet 4.6** (or the highest Claude model offered — 4.7 if available).
6. Optional but recommended: From the Antigravity settings, install the shell command (`antigravity .` from any terminal opens the current folder). Mac: `Cmd+Shift+P` → "Install 'antigravity' command in PATH". Windows: setting available in the Settings UI.

**Verify it worked:** Open a new terminal and type:
```bash
antigravity --version
```
You should see a version number. If you get "command not found," skip the shell command and just use the app icon instead.

### 1.5 (Optional, Path B only) Installing Claude Code CLI

Skip this if you're on Path A.

1. Open a terminal and run:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
2. Then:
   ```bash
   claude --version
   ```
   You should see a version number.
3. On first use it'll prompt you to log in with your Anthropic account.

---

## PART 2 — TOOLS TO INSTALL LOCALLY

These run on your computer. Some you'll never touch directly — they're infrastructure your project needs.

### Tool 1: Node.js 20 LTS

**What it is:** The engine that runs your backend code.

**Install:**
1. Go to **`nodejs.org`**.
2. Download the version labelled **"LTS"** (Long Term Support) — currently Node 20.
3. Run the installer with all defaults.

**Verify:**
```bash
node --version
```
You should see `v20.x.x`. Anything starting with `v20` is correct. (If you have v22 LTS by the time you read this, that's fine too — the project's `engines` field accepts `>=20`.)

### Tool 2: pnpm 9

**What it is:** Package manager. Faster than npm, handles monorepos better.

**Why pnpm:** The 13 spec docs use pnpm everywhere (TRD §3, INFRA §3 CI, IMPLEMENTATION-PLAN). Don't use npm or yarn — the lockfile won't match and CI will fail.

**Install:**
```bash
npm install -g pnpm@9
```

**Verify:**
```bash
pnpm --version
```
You should see `9.x.x`.

### Tool 3: Docker Desktop

**What it is:** Runs a small virtual computer on your machine that hosts your local PostgreSQL database and Redis cache.

**Why you need it:** Your dev environment must match production (Postgres 16, Redis 7). Docker gives you exact versions without polluting your machine with random installs.

**Install:**
1. Go to **`docker.com/products/docker-desktop`**.
2. Download Docker Desktop for your OS.
3. Install it. **You'll need to restart your computer** after install.

**Verify:** After restart, look for the Docker whale icon in your taskbar (Windows) or menu bar (Mac). It should say "Docker Desktop is running" (steady icon, not animated). Then:
```bash
docker --version
docker compose version
```
Both should print versions.

### Tool 4: Git

**What it is:** Tracks every change to your code. Connects your machine to GitHub.

**Install:**
1. Go to **`git-scm.com/downloads`**.
2. Download for your OS, install with defaults.

**Verify:**
```bash
git --version
```
Should print a version. Then configure your name/email so commits are attributed correctly:
```bash
git config --global user.name "Mohammed Arslaan"
git config --global user.email "your-skaly-email@skaly.in"
```

### Tool 5: (Already done in Part 1) Antigravity

You installed this in Part 1. If you skipped Part 1, scroll back.

### Tool 6: (Optional but useful) `openssl`

**Why:** You'll need to generate random secrets (CRON_SECRET, etc.) in Part 6. `openssl` is the cross-platform way.

**Verify:**
```bash
openssl version
```
Mac/Linux: pre-installed. Windows: install Git for Windows (which you already did) — it includes openssl.

---

## PART 3 — ACCOUNTS TO CREATE

You need accounts on **7 services**. None require a credit card to start. Go through them in this order.

### Account 1: GitHub

**What it is:** Stores your code online. Vercel and Railway watch GitHub to deploy automatically.

**Steps:**
1. Go to **`github.com`** → Sign up.
2. Use your professional email (your Skaly Group email).
3. Verify email.

**Create the repository:**
1. Click the **"+"** menu → **New repository**.
2. Name: **`skaly-portal`**.
3. **Set to Private.** This is an internal business tool.
4. **Do NOT check** "Add a README file." (You'll create your own in Sprint 0.)
5. **Do NOT add** a .gitignore or licence yet.
6. Click **Create repository**.

**Set the description (per audit L-6):** Repository → Settings → top, add description: "Internal operations portal for Skaly Group."

**Note your GitHub username** — you'll need it in Part 4.

### Account 2: Vercel

**What it is:** Hosts your frontend (the website at `portal.skaly.in`).

**Why Vercel:** It's built by the team that makes Next.js. Optimal hosting for your stack.

**Steps:**
1. Go to **`vercel.com`** → Sign up.
2. Choose **"Continue with GitHub"** — this connects Vercel to your GitHub account.
3. Authorise the connection.

**Do NOT click "Add New Project" yet.** You'll connect the project in Sprint 0 STEP 14, after you have something to deploy. (Triggering a build now wastes a build credit and fills your dashboard with failures — see audit M-9.)

### Account 3: Railway

**What it is:** Hosts your backend API server and your PostgreSQL database.

**Steps:**
1. Go to **`railway.app`** → Sign in with GitHub.
2. Authorise the connection.
3. Click **New Project** → **Empty Project**.
4. Name it: **`skaly-portal`**.
5. Inside the project, click **+ New** → **Database** → **PostgreSQL**. (You'll add the API service in Sprint 0 STEP 14.)
6. Once PostgreSQL is provisioned, click on the database card → **Connect** tab. **Copy and save** the `DATABASE_URL` somewhere safe (a password manager or a temporary text file). You'll paste it into `.env` later.

### Account 4: Supabase

**What it is:** Manages authentication (login, signup, MFA). Your portal uses Supabase **only** for auth — no operational data lives in Supabase.

**Steps:**
1. Go to **`supabase.com`** → **Start your project** → Sign in with GitHub.
2. Click **New project**.
3. Organisation: Create one called **"Skaly Group"**.
4. Project name: **`skaly-portal`**.
5. **Database password:** Click "Generate a password." **SAVE THIS** — you'll never see it again.
6. Region: Pick closest to Hyderabad — **`Singapore (ap-southeast-1)`** or **`Mumbai (ap-south-1)`** if available.
7. Pricing: **Free tier**.
8. Click **Create new project**. Provisioning takes ~2 minutes.

**Once provisioned:**
- Go to **Project Settings** → **API**. Copy and save these:
  - `Project URL` → becomes `SUPABASE_URL`
  - `anon` `public` key → becomes `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `service_role` `secret` key → becomes `SUPABASE_SERVICE_ROLE_KEY`
- Go to **Authentication** → **Providers**:
  - Email: enabled by default (leave as is)
  - Google: enable it (you'll need a Google OAuth client — set this up when you do Sprint 1 auth work; not needed in Sprint 0)
- **Authentication** → **Settings** → scroll to **Multi-Factor Authentication** → enable **TOTP**.
- **Authentication** → **URL Configuration**:
  - Site URL: `http://localhost:3000` (Sprint 0 dev)
  - Redirect URLs: add `http://localhost:3000/**`, `https://portal.skaly.in/**` (you'll add staging later)

### Account 5: Upstash (Redis)

**What it is:** Redis cache. Stores bot session memory, online presence, rate-limit state.

**Steps:**
1. Go to **`upstash.com`** → **Start for free** → Sign in with GitHub.
2. Click **Create Database**.
3. Name: **`skaly-portal-staging`** (you'll create prod when ready to deploy).
4. Type: **Regional**.
5. Region: Closest to your Railway region — Singapore or Mumbai.
6. Enable **TLS**.
7. Click **Create**.

**Get the connection URL:**
- On the database page → **Details** tab → copy the **`REDIS_URL`** (the one starting with `rediss://`). Save it.

### Account 6: Cloudflare (R2)

**What it is:** Object storage for files — task attachments, staff CVs, generated PDFs.

**Steps:**
1. Go to **`cloudflare.com`** → Sign up with your Skaly email.
2. In the dashboard, find **R2 Object Storage** in the left sidebar.
3. Click **R2** → if not enabled, click **Subscribe to R2** (no payment required for the free tier).
4. Click **Create bucket**.
5. Name: **`skaly-portal-staging`** (you'll create `skaly-portal-prod` when ready to deploy).
6. Keep default settings → **Create bucket**.

**Get API credentials:**
- Click **R2 Object Storage** → **Manage R2 API Tokens** → **Create API Token**.
- Name: **`skaly-portal-api`**.
- Permissions: **Object Read & Write**.
- TTL: leave blank (token doesn't expire).
- Click **Create API Token**.
- **Copy and save**: Access Key ID, Secret Access Key, S3 API endpoint URL. (The endpoint looks like `https://<account-id>.r2.cloudflarestorage.com`.)

### Account 7: Anthropic API

**What it is:** Powers the AI bot. You need an API key to call Claude Sonnet 4.6 / Haiku 4.5.

**Steps:**
1. Go to **`console.anthropic.com`** → Sign up.
2. Add a payment method (the bot is the only paid integration in MVP — budget ~$10–30/month for 50 users at Haiku dev rates).
3. Go to **API Keys** → **Create Key**. Name: **`skaly-portal-backend`**.
4. **Copy the key immediately** (starts with `sk-ant-...`). Save it. You can't view it again.
5. Set a monthly spend limit: **$50** initially. **Billing** → **Limits**.

### (Defer to Sprint 13) Account 8: Sentry

Per Fix Guide V2 H-07, Sentry setup is a Sprint 13 task. Don't create the account now. Note it for later.

### Saving your credentials

You now have a pile of secrets:
- GitHub: username
- Vercel: linked via GitHub
- Railway: DATABASE_URL
- Supabase: SUPABASE_URL, anon key, service role key, JWT secret (find it under Project Settings → API → JWT Settings)
- Upstash: REDIS_URL
- Cloudflare: R2 endpoint, access key ID, secret access key
- Anthropic: API key

**Save them in a password manager** (1Password, Bitwarden, etc.). **Do not** save them in a text file on your desktop. **Never** commit them to GitHub — your `.gitignore` will protect against this in Sprint 0, but discipline matters.

---

## PART 4 — SET UP YOUR LOCAL WORKSPACE

### 4.1 Decide where to keep the project

A good location is inside your `Documents` folder. On Mac/Linux:
```bash
cd ~/Documents
mkdir -p projects
cd projects
```

On Windows (PowerShell):
```powershell
cd $env:USERPROFILE\Documents
mkdir projects -ErrorAction SilentlyContinue
cd projects
```

### 4.2 Clone your empty GitHub repo

```bash
git clone https://github.com/YOUR-GITHUB-USERNAME/skaly-portal.git
cd skaly-portal
```

Replace `YOUR-GITHUB-USERNAME` with your actual GitHub username.

You're now inside an empty folder named `skaly-portal/` that's connected to your GitHub repo.

### 4.3 Open the folder in Antigravity

```bash
antigravity .
```

(Or open Antigravity from your Applications and use **File → Open Folder → ~/Documents/projects/skaly-portal**.)

You should see Antigravity open with an empty file tree.

### 4.4 Copy your 14 spec documents into a `docs/` folder

This is critical. Claude needs to be able to read your specs from inside the project.

In Antigravity's built-in terminal:
```bash
mkdir docs
```

Then copy these 14 files into the `docs/` folder (download them to your machine first if you only have them in Claude.ai chat):
- `01-PRD.md`
- `02-TRD.md`
- `03-UIUX.md`
- `04-APPFLOW.md`
- `05-BACKEND-SCHEMA.md`
- `06-IMPLEMENTATION-PLAN.md`
- `07-API-CONTRACT.md`
- `08-AUTH-MATRIX.md`
- `09-ERROR-HANDLING.md`
- `10-INFRA-DEPLOYMENT.md`
- `11-THIRD-PARTY-INTEGRATIONS.md`
- `12-TESTING-STRATEGY.md`
- `13-NFRS.md`
- `14-PRE-BUILD-AUDIT.md`

Also copy these reference docs:
- `CRITICAL-PATCHES.md` (drop-in code for audit items)
- `FIX-GUIDE-V2-COMPLETE.md` (21 surgical fix prompts)
- `SPRINT-0-READINESS-CHECKLIST.md` (gate before Sprint 1)
- This file: `MASTER-BUILD-GUIDE-V2-FINAL.md`

Place them all in `docs/`. Refresh the Antigravity file tree (Cmd+Shift+P → "Refresh Explorer" if needed). You should see 18 files inside `docs/`.

### 4.5 Start Docker

Open Docker Desktop from your Applications/Start menu. Wait until the whale icon shows steady (not animated). It should say "Docker Desktop is Running."

Verify Docker is reachable:
```bash
docker ps
```
Should print a column header row (and no containers yet). If you get "Cannot connect to the Docker daemon," Docker isn't fully started — wait 30 seconds and retry.

---

## PART 5 — THE PROJECT YOU'RE ABOUT TO BUILD

Before you give Claude its first prompt, understand what you're building.

### 5.1 The monorepo layout (per TRD §3)

```
skaly-portal/
│
├── apps/
│   ├── web/                 ← Next.js 15 frontend (browser app)
│   │   ├── app/             ← App Router pages
│   │   │   ├── (auth)/      ← /login, /signup, /mfa-setup
│   │   │   └── (portal)/    ← all authenticated pages
│   │   ├── components/      ← React components
│   │   ├── hooks/           ← custom React hooks
│   │   ├── lib/             ← API client, utils
│   │   └── store/           ← Zustand stores
│   │
│   └── api/                 ← Fastify 5 backend (server)
│       └── src/
│           ├── routes/      ← API endpoints
│           ├── services/    ← business logic
│           ├── middleware/  ← Fastify plugins (auth, RBAC, internal secret, socket watchers)
│           ├── bot/         ← AI bot + tools
│           ├── jobs/        ← rollover scheduler, backup
│           ├── events/      ← EventEmitter bus for cross-module triggers
│           ├── lib/         ← shared utilities
│           └── scripts/     ← CLI scripts: migrate, seed, refresh-views
│
├── packages/
│   ├── shared/              ← Zod schemas, TypeScript types — used by both apps
│   └── config/              ← ESLint, Prettier, TypeScript base configs
│
├── database/
│   ├── migrations/          ← Kysely migration files (001 → 026)
│   └── seeds/               ← system actor + dev data seeds
│
├── docs/                    ← Your 18 reference documents (already here)
│
├── .github/
│   └── workflows/           ← CI/CD pipelines
│
├── docker-compose.yml       ← Local Postgres + Redis
├── pnpm-workspace.yaml      ← Monorepo workspace declaration
├── package.json             ← Root package — orchestrates sub-projects
├── .gitignore               ← Files Git should ignore
├── .nvmrc                   ← Node version pin
├── .prettierrc              ← Code formatting
└── README.md                ← Setup instructions
```

**Phase 2 (not now):** `apps/mobile/` for React Native + Expo. Don't create this folder in Sprint 0. (Per audit B-3.)

### 5.2 How the pieces talk to each other

```
Browser (Next.js, port 3000)
    │
    │  HTTPS API calls (fetch / TanStack Query)
    ↓
Fastify API (port 3001)
    │       │       │       │
    ↓       ↓       ↓       ↓
  Postgres Redis  R2   Anthropic
  (data)  (cache) (files) (bot)
                  │
                  Supabase (auth tokens) ← Browser also talks here for login
```

- **Browser** loads pages from Next.js, gets a JWT from Supabase on login
- **Browser** sends API requests to Fastify with the JWT in the `Authorization` header
- **Fastify** validates the JWT against `SUPABASE_JWT_SECRET`, looks up the staff row, attaches it to the request, then runs the actual route handler
- **Fastify** talks to Postgres (via Kysely), Redis (via ioredis), R2 (via AWS S3 SDK), and Anthropic (via @anthropic-ai/sdk)
- **Browser** also opens a WebSocket to Fastify for real-time (chat messages, notifications, bot streaming)

That's the whole architecture. Every spec document elaborates on one slice of this picture.

---

## PART 6 — HOW TO PROMPT CLAUDE INSIDE ANTIGRAVITY

This pattern repeats for every prompt in this guide. Internalise it.

### 6.1 The 3-part prompt structure

Every prompt you paste should contain three things:

```
1. WHERE  → Point Claude at the right spec section
            "Read docs/02-TRD.md Section 3"
            
2. WHAT   → Describe the deliverable concretely
            "Create the monorepo structure at the root..."
            
3. RULES  → Constraints Claude must respect
            "Use the exact folder names from TRD §3.
             Do not create apps/mobile — that's Phase 2.
             Use relative tsconfig paths, not @skaly/config."
```

### 6.2 The "Verify Before Moving On" loop

After every prompt:

1. **Read what Claude wrote.** Don't trust it sight unseen.
2. **Run the verification command** (each step in this guide has one).
3. **Open the browser / API endpoint / generated file** and check it matches what you asked for.
4. **If it's wrong:** Paste back the actual output and say "this doesn't match the spec — `docs/X.md §Y` says it should be Z." Let Claude fix it.
5. **If it's right:** Commit to git, move to the next step.

You will be tempted to skip verification. Don't. Five unverified steps stack into untrappable bugs.

### 6.3 Recovery prompts (memorise these)

When Claude's output is wrong:
```
This doesn't match the spec.
According to docs/<file>.md §<section>, it should be:
<paste the relevant spec text>

What you produced is:
<paste the wrong thing>

Rebuild it to exactly match the spec.
```

When Claude seems lost (long session, multiple files):
```
Context check: this is a Next.js 15 frontend (apps/web/) talking to a
Fastify 5 backend (apps/api/). PostgreSQL via Kysely. Supabase auth only.
Socket.io for real-time. All 18 reference documents are in docs/.
Currently working on <feature>. Read docs/<relevant>.md before continuing.
```

When you don't know which file to change:
```
According to docs/02-TRD.md §3 (project structure), which file should
contain <the thing you're building>? Show me the path, then create or
modify it.
```

---

(Continued in PART 7 — Sprint 0 prompts)

## PART 7 — SPRINT 0: THE EXACT PROMPTS, IN ORDER

Sprint 0 is **foundation only**. No features. You're scaffolding the project skeleton, applying database migrations, dropping in security plugins, and connecting deploy targets. When this part is green, Sprint 1 starts.

**Estimated time:** 3–5 working days (per `06-IMPLEMENTATION-PLAN.md` §3.4). If you've never set up a Next.js + Fastify monorepo before, budget the full 5 days. Don't rush.

Every step below has:
- **Goal:** what you're producing
- **Prompt:** paste this verbatim into Antigravity's Claude chat
- **Verify:** the command and the expected output

---

### SPRINT 0 — STEP 1: Initialise the monorepo skeleton

**Goal:** All folders exist. Root `package.json`, `pnpm-workspace.yaml`, `docker-compose.yml`, `.gitignore`, `.nvmrc` are in place.

**Prompt:**

> I'm building the Scaly Business Portal — an internal operations platform for Skaly Group. Read `docs/02-TRD.md` §3 (the monorepo structure) and `docs/10-INFRA-DEPLOYMENT.md` §2 (the docker compose for local dev).
>
> Create the complete monorepo skeleton at the root of this project. Do not create any application code yet — just the structure and config files.
>
> Tasks:
>
> 1. Create `pnpm-workspace.yaml` with:
>    ```yaml
>    packages:
>      - 'apps/*'
>      - 'packages/*'
>    ```
>
> 2. Create root `package.json` with:
>    - name: `skaly-portal`
>    - private: true
>    - version: `0.1.0`
>    - engines: `node >=20`, `pnpm >=9`
>    - engineStrict: true
>    - scripts: `dev` (runs both apps in parallel using `pnpm -r --parallel dev`), `build` (`pnpm -r build`), `test` (`pnpm -r test`), `typecheck` (`pnpm -r exec tsc --noEmit`), `lint` (`pnpm -r exec eslint .`)
>    - packageManager: `pnpm@9.0.0`
>
> 3. Create empty folders with a single `.gitkeep` file in each:
>    - `apps/web` (will be filled in STEP 4)
>    - `apps/api` (will be filled in STEP 5)
>    - `packages/shared`
>    - `packages/config`
>    - `database/migrations`
>    - `database/seeds`
>
>    **Do NOT create `apps/mobile`** — mobile is Phase 2, per `docs/02-TRD.md` §1.
>
> 4. Create `docker-compose.yml` at the root **verbatim from `docs/10-INFRA-DEPLOYMENT.md` §2 (Local Dev — Docker Compose)**. Postgres 16-alpine on port 5432 with user `skaly`, password `localdev`, db `skaly_dev`. Redis 7-alpine on port 6379 with maxmemory 256mb and allkeys-lru policy. Include the healthcheck for Postgres exactly as in the spec.
>
> 5. Create `.gitignore` at root that ignores:
>    ```
>    node_modules/
>    .pnpm-store/
>    .env
>    .env.local
>    .env.*.local
>    dist/
>    build/
>    .next/
>    .turbo/
>    coverage/
>    *.log
>    .DS_Store
>    Thumbs.db
>    .vscode/
>    .idea/
>    *.tsbuildinfo
>    ```
>
> 6. Create `.nvmrc` at root containing just: `20`
>
> 7. Create `.editorconfig` at root with standard settings (2-space indent, LF line endings, UTF-8, trim trailing whitespace, insert final newline).
>
> After creating everything, list the file tree so I can verify.

**Verify:**

In the Antigravity terminal:
```bash
ls -la
ls -la apps packages database
```

You should see all folders present with `.gitkeep` files, plus the root config files (`package.json`, `pnpm-workspace.yaml`, `docker-compose.yml`, `.gitignore`, `.nvmrc`, `.editorconfig`).

---

### SPRINT 0 — STEP 2: TypeScript and config packages

**Goal:** Shared TypeScript base config, Prettier, ESLint configs in `packages/config/`. Per-app tsconfigs that extend the base via relative paths.

**Why relative paths and not `@skaly/config`:** The previous guide tried scoped package names, which require setting up workspace deps in three places. Relative paths are simpler and bullet-proof for Sprint 0. (Per audit B-4.)

**Prompt:**

> Read `docs/02-TRD.md` §3 (the `packages/config` purpose: ESLint, TypeScript, Prettier configs) and §2.1, §2.2 (the tech stack).
>
> Create the shared config and per-app tsconfigs.
>
> 1. Create `packages/config/package.json`:
>    ```json
>    {
>      "name": "@skaly/config",
>      "version": "0.1.0",
>      "private": true,
>      "main": "index.js"
>    }
>    ```
>    (We keep the name for future, but apps will extend via relative path for now.)
>
> 2. Create `packages/config/tsconfig.base.json`:
>    ```json
>    {
>      "$schema": "https://json.schemastore.org/tsconfig",
>      "compilerOptions": {
>        "target": "ES2022",
>        "lib": ["ES2022"],
>        "module": "ESNext",
>        "strict": true,
>        "esModuleInterop": true,
>        "skipLibCheck": true,
>        "forceConsistentCasingInFileNames": true,
>        "resolveJsonModule": true,
>        "isolatedModules": true,
>        "noUncheckedIndexedAccess": true,
>        "noImplicitOverride": true
>      }
>    }
>    ```
>
> 3. Create `packages/config/eslint.config.js` (ESLint v9 flat config) that exports a base config array with:
>    - `@typescript-eslint/parser` and recommended rules
>    - `eslint-plugin-import` ordered imports
>    - Globals for `node` and `es2022`
>    - Override for `*.test.ts` files allowing `any`
>
> 4. Create `packages/config/prettier.config.js`:
>    ```js
>    module.exports = {
>      printWidth: 100,
>      semi: true,
>      singleQuote: true,
>      trailingComma: 'all',
>      arrowParens: 'always',
>      endOfLine: 'lf',
>    };
>    ```
>
> 5. Create root `.prettierrc.js`:
>    ```js
>    module.exports = require('./packages/config/prettier.config.js');
>    ```
>
> 6. Create root `eslint.config.js`:
>    ```js
>    import base from './packages/config/eslint.config.js';
>    export default base;
>    ```
>
> 7. Create `packages/shared/package.json`:
>    ```json
>    {
>      "name": "@skaly/shared",
>      "version": "0.1.0",
>      "private": true,
>      "main": "./src/index.ts",
>      "types": "./src/index.ts"
>    }
>    ```
>    With dependencies: `zod` (latest). DevDependencies: `typescript`, `@types/node`.
>
> 8. Create `packages/shared/tsconfig.json`:
>    ```json
>    {
>      "extends": "../config/tsconfig.base.json",
>      "compilerOptions": {
>        "outDir": "dist",
>        "rootDir": "src"
>      },
>      "include": ["src/**/*.ts"]
>    }
>    ```
>
> 9. Create `packages/shared/src/index.ts` with just:
>    ```ts
>    // Shared Zod schemas and TypeScript types live here.
>    // Filled in incrementally per sprint (Sprint 2 onward).
>    export {};
>    ```

**Verify:**

```bash
ls packages/config packages/shared
cat packages/config/tsconfig.base.json
```

You should see all the config files. The base tsconfig should be valid JSON.

---

### SPRINT 0 — STEP 3: Initialise the Next.js frontend

**Goal:** Working Next.js 15 app at `apps/web/` with App Router, Tailwind 4, TypeScript, the three fonts from TRD §2.5, and placeholder routes for every module.

**Prompt:**

> Read `docs/02-TRD.md` §2.1 (frontend stack), §2.5 (the three-font stack — Big Shoulders Display + DM Sans + DM Mono — exactly as the code block in that section is written), §3 (frontend folder structure under `apps/web/`).
>
> Then read `docs/03-UIUX.md` §2.1 (the authoritative CSS variables block) and §3 (typography rules).
>
> Create the Next.js 15 frontend at `apps/web/`. **Use `next` directly, not `create-next-app`**, because we already have a workspace package.json — running create-next-app would conflict.
>
> Tasks:
>
> 1. Create `apps/web/package.json`:
>    - name: `@skaly/web`
>    - private: true
>    - scripts: `dev` (`next dev`), `build` (`next build`), `start` (`next start`), `lint` (`next lint`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`)
>    - dependencies (latest versions unless noted):
>      `next@15`, `react@19`, `react-dom@19`, `tailwindcss@4`, `@tailwindcss/postcss@4`,
>      `framer-motion@11`,
>      `@tanstack/react-query@5`, `@tanstack/react-table@8`, `@tanstack/react-virtual@3`,
>      `zustand@5`, `zod`, `date-fns`, `cmdk`, `socket.io-client@4`,
>      `dompurify`, `@types/dompurify`,
>      `@supabase/supabase-js`, `@supabase/ssr`,
>      `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`,
>      `@radix-ui/react-slot`, `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`
>    - devDependencies:
>      `typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `vitest`, `@vitejs/plugin-react`, `jsdom`, `eslint`, `eslint-config-next`
>
>    **Do NOT add `shadcn/ui` as a dependency** — that's not how shadcn works (we'll init it in STEP 4).
>
> 2. Create `apps/web/tsconfig.json`:
>    ```json
>    {
>      "extends": "../../packages/config/tsconfig.base.json",
>      "compilerOptions": {
>        "lib": ["dom", "dom.iterable", "es2022"],
>        "jsx": "preserve",
>        "moduleResolution": "bundler",
>        "plugins": [{ "name": "next" }],
>        "paths": { "@/*": ["./*"] },
>        "incremental": true,
>        "noEmit": true
>      },
>      "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
>      "exclude": ["node_modules"]
>    }
>    ```
>
> 3. Create `apps/web/next.config.ts`:
>    ```ts
>    import type { NextConfig } from 'next';
>    
>    const config: NextConfig = {
>      reactStrictMode: true,
>      images: {
>        remotePatterns: [
>          // R2 presigned URL host — fill in your actual R2 endpoint host
>          { protocol: 'https', hostname: '*.r2.cloudflarestorage.com' },
>        ],
>      },
>      experimental: {
>        // Reserve for future use
>      },
>    };
>    
>    export default config;
>    ```
>
> 4. Create `apps/web/postcss.config.mjs`:
>    ```js
>    export default {
>      plugins: { '@tailwindcss/postcss': {} },
>    };
>    ```
>
> 5. Create `apps/web/app/layout.tsx` with the three-font setup **verbatim from `docs/02-TRD.md` §2.5**:
>    ```tsx
>    import type { Metadata } from 'next';
>    import { Big_Shoulders_Display, DM_Sans, DM_Mono } from 'next/font/google';
>    import './globals.css';
>    
>    const bigShoulders = Big_Shoulders_Display({
>      subsets: ['latin'],
>      display: 'swap',
>      weight: ['400', '600', '700'],
>      variable: '--font-big-shoulders',
>    });
>    
>    const dmSans = DM_Sans({
>      subsets: ['latin'],
>      display: 'swap',
>      variable: '--font-dm-sans',
>    });
>    
>    const dmMono = DM_Mono({
>      subsets: ['latin'],
>      display: 'swap',
>      weight: ['400', '500'],
>      variable: '--font-dm-mono',
>    });
>    
>    export const metadata: Metadata = {
>      title: 'Scaly Business Portal',
>      description: 'Internal operations platform for Skaly Group',
>    };
>    
>    export default function RootLayout({ children }: { children: React.ReactNode }) {
>      return (
>        <html lang="en" className={`${bigShoulders.variable} ${dmSans.variable} ${dmMono.variable}`}>
>          <body>{children}</body>
>        </html>
>      );
>    }
>    ```
>
> 6. Create `apps/web/app/globals.css` containing:
>    - The Tailwind 4 import: `@import 'tailwindcss';`
>    - The `@theme` block configuring Tailwind to reference our CSS variables
>    - **All CSS variables verbatim from `docs/03-UIUX.md` §2.1** — every variable from `--bg-base` through `--font-mono` exactly as written
>    - A `body` rule applying `var(--font-body)` and `background: var(--bg-base)` and `color: var(--text-primary)`
>
> 7. Create `apps/web/app/page.tsx`:
>    ```tsx
>    export default function Home() {
>      return (
>        <main className="min-h-screen flex items-center justify-center">
>          <div className="text-center">
>            <h1 style={{ fontFamily: 'var(--font-display)', color: 'var(--accent-gold)' }}
>                className="text-5xl font-bold">Scaly Business Portal</h1>
>            <p style={{ fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}
>               className="mt-4">Sprint 0 foundation ready</p>
>          </div>
>        </main>
>      );
>    }
>    ```
>
> 8. Create empty placeholder route pages, each containing a single `<h1>` with the route name:
>    - `app/(auth)/login/page.tsx` — "Login"
>    - `app/(auth)/signup/page.tsx` — "Signup"
>    - `app/(auth)/mfa-setup/page.tsx` — "MFA Setup"
>    - `app/(portal)/home/page.tsx` — "Home"
>    - `app/(portal)/attendance/page.tsx` — "Attendance"
>    - `app/(portal)/tasks/page.tsx` — "Tasks"
>    - `app/(portal)/shoot-planner/page.tsx` — "Shoot Planner"
>    - `app/(portal)/content-dropper/page.tsx` — "Content Dropper"
>    - `app/(portal)/content-calendar/page.tsx` — "Content Calendar"
>    - `app/(portal)/bot/page.tsx` — "Bot"
>    - `app/(portal)/chat/page.tsx` — "Chat"
>    - `app/(portal)/dashboard/page.tsx` — "Dashboard"
>    - `app/(portal)/settings/page.tsx` — "Settings"
>    - `app/(portal)/profile/page.tsx` — "Profile"
>
> 9. Create `apps/web/app/(portal)/layout.tsx` for now containing the **mobile gate from `FIX-GUIDE-V2-COMPLETE.md` M-02** — a `md:block` div for the portal content and a `md:hidden` "use a desktop browser" message for mobile users.
>
> 10. Create `apps/web/vitest.config.ts`:
>     ```ts
>     import { defineConfig } from 'vitest/config';
>     import react from '@vitejs/plugin-react';
>     export default defineConfig({
>       plugins: [react()],
>       test: { environment: 'jsdom', globals: true, include: ['**/*.test.{ts,tsx}'] },
>     });
>     ```
>
> 11. Create `apps/web/.env.example`:
>     ```
>     NEXT_PUBLIC_API_URL=http://localhost:3001/v1
>     NEXT_PUBLIC_WS_URL=ws://localhost:3001
>     NEXT_PUBLIC_SUPABASE_URL=
>     NEXT_PUBLIC_SUPABASE_ANON_KEY=
>     ```
>
> 12. Create `apps/web/lib/utils.ts` (required by shadcn — a small `cn()` helper):
>     ```ts
>     import { clsx, type ClassValue } from 'clsx';
>     import { twMerge } from 'tailwind-merge';
>     export function cn(...inputs: ClassValue[]) {
>       return twMerge(clsx(inputs));
>     }
>     ```
>
> When done, run `pnpm install` from the project root, then `pnpm --filter @skaly/web dev` and confirm `http://localhost:3000` shows the gold "Scaly Business Portal" headline.

**Verify:**

After Claude finishes, from the project root:
```bash
pnpm install
pnpm --filter @skaly/web dev
```

Open `http://localhost:3000` in your browser. You should see "Scaly Business Portal" in **gold (#FDC257)** in the **Big Shoulders Display** font, with a secondary line in DM Sans below. The background should be **deep black (#0D0D0F)**.

If the fonts look wrong (Times New Roman) or colours are wrong (white background), tell Claude: "The fonts aren't loading and the background is white. Open `apps/web/app/layout.tsx` and confirm the className is correctly applying the font variables to html. Check globals.css contains all CSS variables from `docs/03-UIUX.md` §2.1."

Stop the dev server (`Ctrl+C`) before moving on.

---

### SPRINT 0 — STEP 4: Initialise shadcn/ui

**Goal:** shadcn is set up so future Sprints can install components with `npx shadcn@latest add button input`.

**Why this is a separate step:** shadcn/ui is not an npm package — it's a CLI that copies component source code into your project. Per audit B-2 and H-4.

**Prompt:**

> In the `apps/web/` directory, initialise shadcn/ui. Run the following commands (the shadcn CLI creates `components.json`, base configuration, and a `lib/utils.ts` cn() helper):
>
> ```bash
> cd apps/web
> npx shadcn@latest init --yes --base-color slate --style new-york
> ```
>
> If the CLI complains that `lib/utils.ts` already exists, that's fine — we created it in the previous step. Let it skip that file.
>
> After init completes, verify that `apps/web/components.json` exists and the cn() helper is intact.
>
> Then update `apps/web/components.json` to point at the right paths:
> ```json
> {
>   "$schema": "https://ui.shadcn.com/schema.json",
>   "style": "new-york",
>   "rsc": true,
>   "tsx": true,
>   "tailwind": {
>     "config": "",
>     "css": "app/globals.css",
>     "baseColor": "slate",
>     "cssVariables": true
>   },
>   "aliases": {
>     "components": "@/components",
>     "utils": "@/lib/utils",
>     "ui": "@/components/ui",
>     "lib": "@/lib",
>     "hooks": "@/hooks"
>   },
>   "iconLibrary": "lucide"
> }
> ```
>
> **Don't add any components yet.** Sprint 1 will add `button`, `input`, `label`. Sprint 4 will add `dialog`, `dropdown-menu`, `tabs`. Etc.

**Verify:**

```bash
ls apps/web/components.json apps/web/lib/utils.ts
```

Both files should exist. Open `components.json` and confirm the aliases match. shadcn is now ready.

---

### SPRINT 0 — STEP 5: Initialise the Fastify backend

**Goal:** Working Fastify 5 server at `apps/api/` with health check, Socket.io, Redis adapter, Pino logging. Database and Redis connections set up but no routes yet.

**Prompt:**

> Read `docs/02-TRD.md` §2.2 (backend stack), §3 (folder structure under `apps/api/src/`), §5.1 (Fastify plugin architecture), §8 (real-time architecture and Redis adapter), §9 (the Pino + Sentry error handler pattern — Sentry is Sprint 13, but the Pino setup is now).
>
> Read `docs/10-INFRA-DEPLOYMENT.md` §6 (backend env vars list).
>
> Create the Fastify 5 backend at `apps/api/`. **Use raw Fastify, not `fastify-cli`** — we're not using fastify-cli's directory autoloading.
>
> Tasks:
>
> 1. Create `apps/api/package.json`:
>    - name: `@skaly/api`
>    - private: true
>    - type: `module`
>    - main: `dist/server.js`
>    - scripts:
>      ```
>      "dev": "tsx watch src/server.ts",
>      "build": "tsc -p tsconfig.json",
>      "start": "node dist/server.js",
>      "test": "vitest run",
>      "typecheck": "tsc --noEmit",
>      "db:migrate": "tsx scripts/migrate.ts",
>      "db:rollback": "tsx scripts/rollback.ts",
>      "db:status": "tsx scripts/migrate-status.ts",
>      "db:seed": "tsx scripts/seed.ts",
>      "db:refresh-views": "tsx scripts/refresh-views.ts"
>      ```
>    - dependencies (latest unless noted):
>      `fastify@5`, `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/multipart`, `@fastify/sensible`,
>      `kysely`, `pg`, `@types/pg`,
>      `socket.io@4`, `@socket.io/redis-adapter`, `ioredis`,
>      `@anthropic-ai/sdk`,
>      `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`,
>      `@supabase/supabase-js`,
>      `zod`, `fastify-type-provider-zod`,
>      `pino`, `pino-pretty`,
>      `node-cron`,
>      `dotenv`
>    - devDependencies:
>      `typescript`, `tsx`, `@types/node`, `vitest`, `kysely-codegen` (for generating types from the DB later)
>
> 2. Create `apps/api/tsconfig.json`:
>    ```json
>    {
>      "extends": "../../packages/config/tsconfig.base.json",
>      "compilerOptions": {
>        "lib": ["ES2022"],
>        "types": ["node"],
>        "moduleResolution": "NodeNext",
>        "module": "NodeNext",
>        "outDir": "dist",
>        "rootDir": "src",
>        "resolveJsonModule": true,
>        "declaration": false
>      },
>      "include": ["src/**/*.ts"],
>      "exclude": ["node_modules", "dist", "scripts"]
>    }
>    ```
>
> 3. Create `apps/api/vitest.config.ts`:
>    ```ts
>    import { defineConfig } from 'vitest/config';
>    export default defineConfig({
>      test: { environment: 'node', globals: true, include: ['src/**/*.test.ts'] },
>    });
>    ```
>
> 4. Create the source folders with `.gitkeep`s:
>    `src/routes`, `src/services`, `src/middleware`, `src/bot`, `src/jobs`, `src/events`, `src/lib`
>
> 5. Create `apps/api/src/lib/env.ts` — a Zod-validated env loader:
>    ```ts
>    import { z } from 'zod';
>    import 'dotenv/config';
>    
>    const EnvSchema = z.object({
>      NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
>      PORT: z.coerce.number().default(3001),
>      TZ: z.string().default('Asia/Kolkata'),
>      DATABASE_URL: z.string().url(),
>      DATABASE_POOL_MIN: z.coerce.number().default(2),
>      DATABASE_POOL_MAX: z.coerce.number().default(20),
>      REDIS_URL: z.string(),
>      SUPABASE_URL: z.string().url(),
>      SUPABASE_JWT_SECRET: z.string().min(1),
>      SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
>      ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-'),
>      ANTHROPIC_MODEL_PROD: z.string().default('claude-sonnet-4-6'),
>      ANTHROPIC_MODEL_DEV: z.string().default('claude-haiku-4-5-20251001'),
>      R2_ENDPOINT: z.string().url(),
>      R2_ACCESS_KEY_ID: z.string().min(1),
>      R2_SECRET_ACCESS_KEY: z.string().min(1),
>      R2_BUCKET_NAME: z.string().min(1),
>      CRON_SECRET: z.string().min(32, 'CRON_SECRET must be at least 32 chars'),
>      LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
>    });
>    
>    export const env = EnvSchema.parse(process.env);
>    export type Env = z.infer<typeof EnvSchema>;
>    ```
>
> 6. Create `apps/api/src/lib/db.ts` — the Kysely instance with **exported pool** for monitoring (per Fix Guide V2 H-09):
>    ```ts
>    import { Kysely, PostgresDialect } from 'kysely';
>    import pg from 'pg';
>    import { env } from './env.js';
>    import type { DB } from './db.types.js'; // will be generated by kysely-codegen later
>    
>    export const pool = new pg.Pool({
>      connectionString: env.DATABASE_URL,
>      min: env.DATABASE_POOL_MIN,
>      max: env.DATABASE_POOL_MAX,
>    });
>    
>    export const db = new Kysely<DB>({
>      dialect: new PostgresDialect({ pool }),
>    });
>    ```
>
>    Also create a placeholder `apps/api/src/lib/db.types.ts`:
>    ```ts
>    // Generated by kysely-codegen after migrations run.
>    // Run: pnpm --filter @skaly/api db:generate-types
>    // Placeholder until generated:
>    export interface DB {}
>    ```
>
> 7. Create `apps/api/src/lib/redis.ts`:
>    ```ts
>    import { Redis } from 'ioredis';
>    import { env } from './env.js';
>    export const redis = new Redis(env.REDIS_URL, env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {});
>    ```
>
> 8. Create `apps/api/src/lib/logger.ts`:
>    ```ts
>    import pino from 'pino';
>    import { env } from './env.js';
>    export const logger = pino({
>      level: env.LOG_LEVEL,
>      ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
>    });
>    ```
>
> 9. Create `apps/api/src/server.ts` — the entry point. It must:
>    - Validate env first (`import { env } from './lib/env.js'`)
>    - Create a Fastify instance with `logger: logger` (the Pino logger from above)
>    - Register `@fastify/helmet`, `@fastify/cors` (origins: `http://localhost:3000`, `https://portal.skaly.in`), `@fastify/rate-limit` with `addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true, 'retry-after': true }` (per Fix Guide V2 M-06), `@fastify/sensible`, `@fastify/multipart`
>    - Set up `fastify-type-provider-zod` for route schema validation
>    - Create the Socket.io server with `cors: { origin: ['http://localhost:3000', 'https://portal.skaly.in'] }`
>    - Configure the Redis adapter **exactly as in `docs/02-TRD.md` §8** (with `pubClient.duplicate()` for subClient)
>    - Register a route `GET /v1/health` that returns:
>      ```ts
>      {
>        status: 'ok',
>        services: { database: 'ok', redis: 'ok' }, // check connectivity
>        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
>        timestamp: new Date().toISOString()
>      }
>      ```
>      Catch errors gracefully — if database is unreachable, return `services.database: 'error'` and HTTP 503.
>    - Listen on `env.PORT`, host `0.0.0.0`, log the URL
>    - Catch SIGINT/SIGTERM and gracefully shut down (close Fastify, then pool, then redis)
>
> 10. Create `apps/api/.env.example` — every variable from `docs/10-INFRA-DEPLOYMENT.md` §6 Backend Railway block, with the values pointing at **local dev** (Docker compose creds for DB; Upstash for Redis; staging R2 + Supabase; CRON_SECRET as a placeholder):
>     ```
>     NODE_ENV=development
>     PORT=3001
>     TZ=Asia/Kolkata
>     
>     DATABASE_URL=postgresql://skaly:localdev@localhost:5432/skaly_dev
>     DATABASE_POOL_MIN=2
>     DATABASE_POOL_MAX=20
>     
>     REDIS_URL=
>     
>     SUPABASE_URL=
>     SUPABASE_JWT_SECRET=
>     SUPABASE_SERVICE_ROLE_KEY=
>     
>     ANTHROPIC_API_KEY=
>     ANTHROPIC_MODEL_PROD=claude-sonnet-4-6
>     ANTHROPIC_MODEL_DEV=claude-haiku-4-5-20251001
>     
>     R2_ENDPOINT=
>     R2_ACCESS_KEY_ID=
>     R2_SECRET_ACCESS_KEY=
>     R2_BUCKET_NAME=skaly-portal-staging
>     
>     CRON_SECRET=
>     
>     LOG_LEVEL=debug
>     ```
>
> 11. Create `apps/api/src/types/fastify.d.ts` for `request.user` typing (per audit M-2):
>     ```ts
>     declare module 'fastify' {
>       interface FastifyRequest {
>         user?: {
>           staffId: string;
>           supabaseUid: string;
>           role: 'admin' | 'manager' | 'team_member' | 'freelancer';
>           email: string;
>           mfaEnrolled: boolean;
>         };
>       }
>       interface FastifyInstance {
>         verifyJwt: any; // populated by auth.plugin.ts in Sprint 1
>         verifyInternalSecret: any; // populated by internalAuth.plugin.ts in STEP 7
>       }
>     }
>     export {};
>     ```

**Verify:**

You can't run `pnpm --filter @skaly/api dev` yet — env vars aren't filled in. The verification gate is the next step. Just confirm Claude created every file:

```bash
ls apps/api apps/api/src apps/api/src/lib
```

You should see all the folders and files listed above.

---

### SPRINT 0 — STEP 6: Database migrations (001 → 026)

**Goal:** All 26 Kysely migration files in `database/migrations/`. The migration runner scripts (`scripts/migrate.ts`, `rollback.ts`, `migrate-status.ts`) in `apps/api/scripts/`.

**Critical:** Migration 026 enforces the audit log as append-only at the database role level — this is **B-01 from the audit**, a blocker.

**Prompt:**

> Read `docs/05-BACKEND-SCHEMA.md` in full — this is the source of truth for every table.
>
> Read `docs/14-PRE-BUILD-AUDIT.md` §B-01 and `docs/CRITICAL-PATCHES.md` (the B-01 section) for the migration 026 (`database_roles.ts`).
>
> Read `docs/14-PRE-BUILD-AUDIT.md` §H-03 for the materialised view initial REFRESH.
>
> Create **all 26 migration files** in `database/migrations/` and the **three runner scripts** in `apps/api/scripts/`.
>
> Each migration must have:
> - An `up(db: Kysely<any>)` async function that creates the table/objects
> - A `down(db: Kysely<any>)` async function that drops them in the reverse order
> - Either use Kysely's schema builder (`db.schema.createTable(...)`) when ergonomic, or `sql\`...\`.execute(db)` for raw SQL when the spec uses Postgres-specific features (extensions, CHECK constraints, partial indexes, GIN indexes, materialised views, GRANT/REVOKE)
>
> The 26 migrations, **in this exact order**, copied verbatim from `docs/05-BACKEND-SCHEMA.md`:
>
> 1. `001_extensions.ts` — enable `uuid-ossp`, `pg_trgm`, `pg_stat_statements`
> 2. `002_months.ts` — months table, PK on period, format CHECK
> 3. `003_staff.ts` — staff table with all constraints, all indexes (incl. partial)
> 4. `004_user_permissions.ts` — user_permissions table
> 5. `005_clients.ts` — clients table
> 6. `006_invite_links.ts` — invite_links table
> 7. `007_signup_requests.ts` — signup_requests table
> 8. `008_holidays.ts` — holidays table
> 9. `009_attendance_logs.ts` — attendance_logs table with all indexes
> 10. `010_tasks.ts` — tasks table with `search_vector tsvector GENERATED ALWAYS AS (...) STORED` and all indexes
> 11. `011_task_assignees.ts` — task_assignees junction table
> 12. `012_task_attachments.ts` — task_attachments table
> 13. `013_task_time_logs.ts` — task_time_logs table
> 14. `014_shoot_schedules.ts` — shoot_schedules table
> 15. `015_content_pipelines.ts` — content_pipelines table
> 16. `016_content_calendar.ts` — content_calendar table with `version` column
> 17. `017_reports.ts` — reports table
> 18. `018_messages.ts` — messages table with `search_vector tsvector`
> 19. `019_message_mentions.ts` — message_mentions table
> 20. `020_bot_sessions.ts` — bot_sessions table
> 21. `021_notifications.ts` — notifications table with the CHECK constraint containing **every notification type listed in `docs/05-BACKEND-SCHEMA.md` §3 notifications block** (copy them all verbatim — do NOT count; copy verbatim)
> 22. `022_comments.ts` — comments table
> 23. `023_audit_log.ts` — audit_log table with `changed_by_source VARCHAR(10) NOT NULL DEFAULT 'user'` and the CHECK constraint listing `'user', 'system', 'bot'` exactly as in `docs/05-BACKEND-SCHEMA.md` §11. **Not a Postgres ENUM type** — a VARCHAR with CHECK.
> 24. `024_materialised_views.ts` — `dashboard_org_stats` and `dashboard_staff_task_stats` materialised views with **UNIQUE indexes on each** (required for `REFRESH ... CONCURRENTLY` later). At the END of this migration's `up()`, run `REFRESH MATERIALIZED VIEW dashboard_org_stats; REFRESH MATERIALIZED VIEW dashboard_staff_task_stats;` (non-CONCURRENTLY for the initial population — per audit H-03).
> 25. `025_search_indexes.ts` — all GIN and trigram indexes from `docs/05-BACKEND-SCHEMA.md` §8
> 26. `026_database_roles.ts` — **the security migration from `docs/CRITICAL-PATCHES.md` §B-01**. Creates the `skaly_app` PostgreSQL role, grants SELECT/INSERT/UPDATE on the appropriate tables, grants DELETE only on the safe-to-delete tables (tasks, task_assignees, task_attachments, task_time_logs, shoot_schedules, content_pipelines, content_calendar, messages, message_mentions, comments, notifications, invite_links), then **REVOKEs UPDATE and DELETE on audit_log**. Include an idempotency check (`IF NOT EXISTS` patterns) so re-running the migration is safe.
>
> Then create the runner scripts:
>
> **`apps/api/scripts/migrate.ts`:**
> ```ts
> import { Migrator, FileMigrationProvider } from 'kysely';
> import { promises as fs } from 'fs';
> import path from 'path';
> import { db } from '../src/lib/db.js';
> import { logger } from '../src/lib/logger.js';
> 
> async function migrateToLatest() {
>   const migrator = new Migrator({
>     db,
>     provider: new FileMigrationProvider({
>       fs,
>       path,
>       migrationFolder: path.resolve(process.cwd(), '../../database/migrations'),
>     }),
>   });
>   const { error, results } = await migrator.migrateToLatest();
>   results?.forEach((r) => {
>     if (r.status === 'Success') logger.info(`✅ Migration ${r.migrationName} applied`);
>     else if (r.status === 'Error') logger.error(`❌ Migration ${r.migrationName} failed`);
>   });
>   if (error) { logger.error(error); process.exit(1); }
>   await db.destroy();
> }
> migrateToLatest();
> ```
>
> **`apps/api/scripts/rollback.ts`** — same pattern but calls `migrator.migrateDown()`.
>
> **`apps/api/scripts/migrate-status.ts`** — calls `migrator.getMigrations()` and prints each migration's name + status (Applied / Pending).

**Verify (you'll run this after STEP 9 fills in env vars and STEP 10 starts Docker):**

You can't run migrations yet — env isn't configured and Docker isn't started. Just confirm files exist:
```bash
ls database/migrations | wc -l
# Should print 26
ls apps/api/scripts
# migrate.ts, rollback.ts, migrate-status.ts
```

---

### SPRINT 0 — STEP 7: Security plugins (B-03 + C-05 + the audit log lockdown)

**Goal:** `internalAuth.plugin.ts` (cron secret with timing-safe compare) and `socketTokenWatcher.plugin.ts` (JWT-expiry-aware sockets). Both per `docs/CRITICAL-PATCHES.md`.

**Prompt:**

> Read `docs/14-PRE-BUILD-AUDIT.md` §B-03 (cron secret timing-safe) and §C-05 (WebSocket JWT refresh protocol).
>
> Read `docs/CRITICAL-PATCHES.md` for the full code of both plugins.
>
> Create two Fastify plugins, **both in `apps/api/src/middleware/`** (per `docs/02-TRD.md` §3, NOT in `plugins/`):
>
> **File 1: `apps/api/src/middleware/internalAuth.plugin.ts`**
>
> Implement exactly as in `docs/CRITICAL-PATCHES.md` §B-03:
> - Reads `x-internal-secret` header
> - Uses `crypto.timingSafeEqual` from Node's `crypto` module — NOT `===`
> - Length pre-check: if `header.length !== env.CRON_SECRET.length`, wait 50ms via `await new Promise(r => setTimeout(r, 50))` and return 401
> - On valid: continue
> - On invalid/missing: return 401 with `{ error: { code: 'UNAUTHORIZED', message: 'Invalid internal secret' } }`
> - Register as a Fastify decorator: `fastify.decorate('verifyInternalSecret', preHandler)`
> - Include the TypeScript declaration in `apps/api/src/types/fastify.d.ts` (already created in STEP 5)
> - Include a vitest test file `apps/api/src/middleware/internalAuth.plugin.test.ts` covering: valid secret passes, wrong secret returns 401, missing header returns 401, length mismatch returns 401 after delay
>
> **File 2: `apps/api/src/middleware/socketTokenWatcher.plugin.ts`**
>
> Implement exactly as in `docs/CRITICAL-PATCHES.md` §C-05:
> - Exports `setupSocketTokenWatcher(io: Server)` taking the Socket.io server
> - On every `connection`: read `socket.handshake.auth.exp` (Unix timestamp in seconds)
> - If exp missing/in-past: `socket.disconnect(true)` immediately
> - Set timer for `exp - 60s`: emit `auth:refresh_required` with `{ message, expiresAt: new Date(exp*1000).toISOString() }`
> - Set timer for `exp + 30s`: `socket.disconnect(true)`
> - Listen for `auth:refresh` from client with `{ token }`: validate new token has future exp (decode without verifying for the exp check — Sprint 1's auth plugin will add full verification), cancel both timers, replace `socket.handshake.auth.exp` with the new exp, emit `auth:refreshed`
> - On socket `disconnect`: `clearTimeout` both timers
> - Include vitest test stubs for: token expires → disconnect timer fires, refresh succeeds before timer, missing exp → immediate disconnect
>
> Wire both into `apps/api/src/server.ts`:
> - Register `internalAuth.plugin.ts` after `@fastify/cors` and before any routes
> - Call `setupSocketTokenWatcher(io)` immediately after Socket.io is constructed

**Verify:**

```bash
ls apps/api/src/middleware
# internalAuth.plugin.ts, internalAuth.plugin.test.ts, socketTokenWatcher.plugin.ts, socketTokenWatcher.plugin.test.ts
```

You can't run tests yet (env not filled in). Will verify in STEP 11.

---

### SPRINT 0 — STEP 8: Dev data seed + refresh-views script

**Goal:** `seeds/001_system_actor.ts` (production-safe), `seeds/002_dev_data.ts` (dev-only), `seed.ts` orchestrator, `refresh-views.ts` script. Per Fix Guide V2 H-03, M-10.

**Prompt:**

> Read `docs/05-BACKEND-SCHEMA.md` §9 (system actor seed). Read `FIX-GUIDE-V2-COMPLETE.md` H-03 (refresh-views) and M-10 (dev seed) for the exact content.
>
> Create:
>
> **File 1: `database/seeds/001_system_actor.ts`**
>
> Inserts the System Actor staff row exactly as `docs/05-BACKEND-SCHEMA.md` §9 specifies:
> - id: `00000000-0000-0000-0000-000000000000`
> - name: `System`
> - email: `system@skaly.internal`
> - role: `admin`
> - active: `true`
> - mfa_enrolled: `true`
> - supabase_uid: `null`
>
> Use `onConflict('id').doNothing()` for idempotency. Production-safe — never skips.
>
> **File 2: `database/seeds/002_dev_data.ts`**
>
> **First line:** `if (process.env.NODE_ENV === 'production') { console.log('Skipping dev seed — production'); process.exit(0); }`
>
> Then per `FIX-GUIDE-V2-COMPLETE.md` M-10:
> - 4 staff (one of each role) with fixed UUIDs (`11111111-1111-1111-1111-111111111111` etc.) and `@test.skaly.in` emails
> - 3 clients (`Naaz Furniture` with shoot_slots 4 / pieces 2; `Hyatt Hotels` with 6/3; `Skaly Internal` with is_internal true, 2/1)
> - 1 months row for the current period — compute with `new Date()`:
>   ```ts
>   const now = new Date();
>   const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
>   const label = now.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
>   ```
>
> All inserts use `onConflict('id').doNothing()` so re-running is safe.
>
> **File 3: `apps/api/scripts/seed.ts`** — orchestrator that runs both seed files in order:
> ```ts
> import { db } from '../src/lib/db.js';
> import { logger } from '../src/lib/logger.js';
> import { seedSystemActor } from '../../database/seeds/001_system_actor.js';
> import { seedDevData } from '../../database/seeds/002_dev_data.js';
> 
> async function run() {
>   try {
>     await seedSystemActor(db);
>     logger.info('✅ System actor seeded');
>     await seedDevData(db);
>     logger.info('✅ Dev data seeded (if non-production)');
>   } catch (err) {
>     logger.error(err);
>     process.exit(1);
>   } finally {
>     await db.destroy();
>   }
> }
> run();
> ```
>
> (Each seed file exports a function `seedSystemActor(db: Kysely<DB>)` and `seedDevData(db: Kysely<DB>)`.)
>
> **File 4: `apps/api/scripts/refresh-views.ts`** — per `FIX-GUIDE-V2-COMPLETE.md` H-03:
> - Imports `db` from `../src/lib/db.js`
> - Runs `await sql\`REFRESH MATERIALIZED VIEW dashboard_org_stats\`.execute(db);` then the same for `dashboard_staff_task_stats`
> - Both **non-CONCURRENTLY** for safety on first run (per audit H-03)
> - Logs success per view
> - Closes `db.destroy()`
> - On error, logs and `process.exit(1)`

**Verify:**

```bash
ls database/seeds apps/api/scripts
# database/seeds: 001_system_actor.ts, 002_dev_data.ts
# apps/api/scripts: migrate.ts, rollback.ts, migrate-status.ts, seed.ts, refresh-views.ts
```

---

### SPRINT 0 — STEP 9: Bot streaming reference (H-04, drafted in Sprint 0 per audit)

**Goal:** `apps/api/src/bot/streamHandler.ts` is committed as a **reference pattern**. Sprint 8 will wire it to the actual `/v1/bot/message` endpoint.

**Why now and not Sprint 8:** Per `docs/14-PRE-BUILD-AUDIT.md` §9.2 audit-added Sprint 0 tasks, this is drafted in Sprint 0 so Sprint 8 + 9 developers follow the canonical pattern, not invent their own.

**Prompt:**

> Read `FIX-GUIDE-V2-COMPLETE.md` H-04 (the full streaming handler spec) and `docs/CRITICAL-PATCHES.md` §H-04 if it contains additional code.
>
> Read `docs/11-THIRD-PARTY-INTEGRATIONS.md` §3 (the Anthropic API patterns, including the streaming variant from TRD §9).
>
> Create `apps/api/src/bot/streamHandler.ts` as the canonical pattern for Sprint 8 and Sprint 9 to follow.
>
> Top of file: a JSDoc block saying:
> ```ts
> /**
>  * Canonical streaming bridge from Anthropic to Socket.io.
>  * This file is REFERENCE — Sprint 8 wires it to /v1/bot/message.
>  * Do not modify the architecture without updating docs/14-PRE-BUILD-AUDIT.md H-04.
>  */
> ```
>
> Export one main async function `handleBotStream({ staffId, sessionMessages, filteredTools, io, redisClient, redisSessionKey, db, anthropic, model })`.
>
> Implement all 5 phases per `FIX-GUIDE-V2-COMPLETE.md` H-04:
> - Phase 1 — First Anthropic streaming call, token-by-token emit
> - Phase 2 — Tool block detection
> - Phase 3 — Second Anthropic call only if tools used
> - Phase 4 — Save updated history to Redis (12h TTL = 43200s, last 100 items)
> - Phase 5 — Archive `messages` row
>
> Plus the try/catch that emits `bot:message` with `{ chunk: '', done: true, error: 'Something went wrong...' }` and re-throws.
>
> Use the Anthropic streaming API: `await anthropic.messages.stream({ model, max_tokens: 1024, tools: filteredTools, messages: sessionMessages })`. Listen on `.on('text', cb)` for tokens. Use `await stream.finalMessage()` for the full response.
>
> Add a sibling test file `apps/api/src/bot/streamHandler.test.ts` with **mocked** Anthropic stream (using a vitest mock) that verifies:
> - With no tools: emits `bot:message done: true` once, archives one messages row
> - With tools: emits `running_tools` status, runs second call, archives one messages row
> - On error: emits error event, re-throws

**Verify:**

```bash
ls apps/api/src/bot
# streamHandler.ts, streamHandler.test.ts
```

---

### SPRINT 0 — STEP 10: CI/CD pipeline and Vercel config

**Goal:** `.github/workflows/ci.yml` per `docs/10-INFRA-DEPLOYMENT.md` §3. `vercel.json` at the frontend root for headers.

**Prompt:**

> Read `docs/10-INFRA-DEPLOYMENT.md` §3 (CI/CD Pipeline) — copy the workflow verbatim.
>
> Read `FIX-GUIDE-V2-COMPLETE.md` H-08 for the CSP header (we won't add CSP yet — that's Sprint 13 — but we'll create vercel.json with the simpler security headers now).
>
> Create:
>
> **File 1: `.github/workflows/ci.yml`** — verbatim from `docs/10-INFRA-DEPLOYMENT.md` §3 "On Every Pull Request" block. Triggers on PRs to `main`. Sets up Postgres + Redis service containers, runs `pnpm install --frozen-lockfile`, `pnpm -r exec tsc --noEmit`, `pnpm -r exec eslint .`, `pnpm --filter @skaly/api db:migrate` (against the test DB), `pnpm test`.
>
> **File 2: `.github/workflows/deploy-api.yml`** — triggers on push to `main`, deploys API to Railway via Railway's GitHub integration (Railway auto-deploys on push, so this workflow only needs to run migrations against production):
> ```yaml
> name: Deploy API
> on: { push: { branches: [main] } }
> jobs:
>   migrate-prod-db:
>     runs-on: ubuntu-latest
>     steps:
>       - uses: actions/checkout@v4
>       - uses: pnpm/action-setup@v3
>         with: { version: 9 }
>       - uses: actions/setup-node@v4
>         with: { node-version: 20, cache: pnpm }
>       - run: pnpm install --frozen-lockfile
>       - run: pnpm --filter @skaly/api db:migrate
>         env:
>           DATABASE_URL: ${{ secrets.DATABASE_URL_PROD }}
> ```
> (You'll add `DATABASE_URL_PROD` to GitHub Secrets in STEP 14.)
>
> **File 3: `apps/web/vercel.json`** — with security headers (CSP will be expanded in Sprint 13):
> ```json
> {
>   "headers": [
>     {
>       "source": "/(.*)",
>       "headers": [
>         { "key": "X-Frame-Options", "value": "DENY" },
>         { "key": "X-Content-Type-Options", "value": "nosniff" },
>         { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
>         { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" }
>       ]
>     }
>   ]
> }
> ```

**Verify:**

```bash
ls .github/workflows apps/web/vercel.json
```

---

### SPRINT 0 — STEP 11: Fill in your `.env` files (manual — not a Claude prompt)

**Goal:** Both `.env` files contain real values from your accounts so the next step can actually run.

#### Backend env (`apps/api/.env`)

Copy the template:
```bash
cp apps/api/.env.example apps/api/.env
```

Open `apps/api/.env` in Antigravity. Fill in each value (you saved these in Part 3):

```bash
NODE_ENV=development
PORT=3001
TZ=Asia/Kolkata

# Local Docker Postgres (from docker-compose.yml — already correct)
DATABASE_URL=postgresql://skaly:localdev@localhost:5432/skaly_dev
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=20

# Upstash staging Redis — paste the rediss:// URL you saved
REDIS_URL=rediss://default:YOUR_PASSWORD@your-host.upstash.io:6379

# Supabase — from Project Settings → API
SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_JWT_SECRET=YOUR_JWT_SECRET  # under Project Settings → API → JWT Settings
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY

# Anthropic — from console.anthropic.com → API Keys
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY
ANTHROPIC_MODEL_PROD=claude-sonnet-4-6
ANTHROPIC_MODEL_DEV=claude-haiku-4-5-20251001

# Cloudflare R2
R2_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=YOUR_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=YOUR_SECRET_ACCESS_KEY
R2_BUCKET_NAME=skaly-portal-staging

# Generate with: openssl rand -hex 32
CRON_SECRET=GENERATE_A_32_BYTE_HEX_STRING_HERE

LOG_LEVEL=debug
```

**Generate CRON_SECRET:**
```bash
openssl rand -hex 32
```
Paste the output. It'll be 64 hex characters (32 bytes).

#### Frontend env (`apps/web/.env.local`)

```bash
cp apps/web/.env.example apps/web/.env.local
```

Fill in:
```bash
NEXT_PUBLIC_API_URL=http://localhost:3001/v1
NEXT_PUBLIC_WS_URL=ws://localhost:3001
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

**Sanity check:** Run from project root:
```bash
pnpm --filter @skaly/api typecheck
```
This will validate the Zod env schema. If any required env var is missing, it'll fail with a clear error.

---

### SPRINT 0 — STEP 12: Boot the database, apply migrations, seed, refresh views

**Goal:** All 26 migrations applied. System actor + dev data seeded. Materialised views populated.

#### Start Docker (Postgres + Redis)

From project root:
```bash
docker compose up -d
```

Wait ~15 seconds for Postgres to be ready. Verify:
```bash
docker compose ps
# Both containers should show "healthy" or "Up"
```

If port 5432 is taken by another local Postgres install, stop the other one first or change the port in `docker-compose.yml` (and update `DATABASE_URL` to match). Per audit M-8.

#### Apply migrations

```bash
pnpm --filter @skaly/api db:migrate
```

You should see:
```
✅ Migration 001_extensions applied
✅ Migration 002_months applied
...
✅ Migration 026_database_roles applied
```

If any migration fails, **stop**. Paste the error to Claude: "Migration `NNN_xxxx.ts` failed with this error: <paste>. Fix it." Don't run subsequent steps until migrations are green.

#### Generate Kysely types from the live database

```bash
pnpm --filter @skaly/api exec kysely-codegen --out-file src/lib/db.types.ts
```

This introspects the DB and writes proper TypeScript types into `db.types.ts`. Open it — you should see interfaces for every table.

#### Seed

```bash
pnpm --filter @skaly/api db:seed
```

You should see:
```
✅ System actor seeded
✅ Dev data seeded (if non-production)
```

Verify in Postgres:
```bash
docker compose exec postgres psql -U skaly -d skaly_dev -c "SELECT id, name, email, role FROM staff ORDER BY name"
```

You should see 5 rows: System + Admin Test + Manager Test + Team Test + Freelancer Test.

#### Refresh materialised views

```bash
pnpm --filter @skaly/api db:refresh-views
```

You should see:
```
✅ Refreshed dashboard_org_stats
✅ Refreshed dashboard_staff_task_stats
```

#### Verify audit log lockdown (B-01)

```bash
docker compose exec postgres psql -U skaly -d skaly_dev -c "
SET ROLE skaly_app;
UPDATE audit_log SET action = 'TAMPERED' WHERE 1=1;
"
```

You should see an error like: `ERROR: permission denied for table audit_log`. **This is correct** — it means migration 026 is doing its job. If the UPDATE succeeds, migration 026 is broken — go back and check it.

---

### SPRINT 0 — STEP 13: Boot both apps and run the test suite

**Goal:** Frontend renders at localhost:3000. Backend health check returns ok at localhost:3001. Tests run.

#### Backend up

From a new terminal:
```bash
pnpm --filter @skaly/api dev
```

Should print: `Server listening on http://0.0.0.0:3001`.

In another terminal:
```bash
curl http://localhost:3001/v1/health
```

You should see:
```json
{
  "status": "ok",
  "services": { "database": "ok", "redis": "ok" },
  "pool": { "total": 2, "idle": 2, "waiting": 0 },
  "timestamp": "2026-06-..."
}
```

#### Frontend up

From another terminal:
```bash
pnpm --filter @skaly/web dev
```

Open `http://localhost:3000` in your browser. Gold "Scaly Business Portal" headline on deep-black background, Big Shoulders Display font. Same verification as STEP 3.

Try `http://localhost:3000/login`, `/home`, `/attendance`, etc. — each should show a simple `<h1>` with the route name (placeholder pages from STEP 3).

Try opening on a phone width (DevTools → device emulation): the portal routes should show the "use a desktop browser" mobile gate.

#### Tests

From project root:
```bash
pnpm test
```

You should see vitest running and **2–4 tests passing** (the `internalAuth.plugin.test.ts` and `streamHandler.test.ts` files). All green.

---

### SPRINT 0 — STEP 14: Apply audit doc patches and Git push

**Goal:** The doc patches for findings C-01 to C-06, the README at root, then push to GitHub and connect Vercel + Railway deploy targets.

#### Doc patches (C-01 to C-06 — text changes, no code)

Open each of these files in Antigravity and apply the patches **from `docs/CRITICAL-PATCHES.md`**:

| Finding | File | Section | Change |
|---|---|---|---|
| C-01 | `docs/01-PRD.md` | §5 | Replace "Bot response" row with "TTFT < 2s; full streaming completion < 8s (see NFR §1.2)" |
| C-02 | `docs/07-API-CONTRACT.md` | §1.1 | Add the PATCH response envelope clause (return full updated resource) |
| C-03 | `docs/01-PRD.md` | §6 | Add the "Transactional email out of scope" row |
| C-03 | `docs/04-APPFLOW.md` | §2.6 | Confirm signup approval polling-only design noted |
| C-04 | `docs/07-API-CONTRACT.md` | §4 | Add `GET /v1/staff/me` endpoint definition |
| C-06 | `docs/04-APPFLOW.md` | §16 | Add bootstrap rollover note (skip step 2 if no prior period) |
| H-05 | `docs/04-APPFLOW.md` | §13 | Replace owner-of-record line with the recipient table from Fix Guide V2 H-05 PROMPT 1 |
| H-06 | `docs/06-IMPLEMENTATION-PLAN.md` | Sprint 5 row + §18 | Add slot count deadline + fallback per Fix Guide V2 H-06 PROMPT 1 |

You can either paste each diff into Antigravity and let Claude apply it (preferred), or open each file and edit by hand. The diff blocks are short — see `docs/CRITICAL-PATCHES.md` for the exact text.

#### Create the root README.md

**Prompt:**

> Read `FIX-GUIDE-V2-COMPLETE.md` M-11 (the README structure).
>
> Create `README.md` at the project root with these sections:
>
> 1. **`# Scaly Business Portal`** — one-line description
> 2. **`## Quick Start`** — Prerequisites (Node 20, pnpm 9, Docker) and the numbered setup steps:
>    1. `git clone` and `cd`
>    2. `pnpm install`
>    3. `docker compose up -d`
>    4. Copy `.env.example` → `.env` in both apps, fill in values
>    5. `pnpm --filter @skaly/api db:migrate`
>    6. `pnpm --filter @skaly/api db:seed`
>    7. `pnpm --filter @skaly/api db:refresh-views`
>    8. `pnpm dev`
>
>    After step 8: Frontend at `http://localhost:3000`, Backend at `http://localhost:3001`.
>
> 3. **`## Test Accounts (Dev Only)`** — table with 4 test accounts. **Note:** these emails exist in the `staff` table but no Supabase auth user exists for them yet. Sprint 1 (auth) creates the Supabase users. For now, you can't log in — these are just placeholders.
>
> 4. **`## Project Structure`** — brief description of each top-level folder
>
> 5. **`## Running Tests`** — `pnpm test`, `pnpm test:e2e` (Sprint 13)
>
> 6. **`## Specification Documents`** — link table to each of the 18 docs in `docs/`, with a one-line description
>
> 7. **`## Development Rules`** — the soft-delete rule from Fix Guide V2 H-02 + the audit log immutability rule
>
> 8. **`## Sprint Progress`** — checkbox list of all 14 sprints (Sprint 0 → Sprint 13), with Sprint 0 checked off

#### Commit and push

```bash
git add .
git status
# Review what's being committed. .env files should be ignored.
git commit -m "Sprint 0: foundation, migrations, security plugins, CI"
git push origin main
```

If `git push` fails because the repo has the initial main branch but no upstream, run:
```bash
git push -u origin main
```

#### Enable GitHub Dependabot (Fix Guide V2 L-09)

In your browser, go to your GitHub repo → **Settings** → **Code security and analysis** → enable:
- Dependabot alerts
- Dependabot security updates
- Dependabot version updates (optional, but useful)

#### Connect Vercel

1. Go to your Vercel dashboard.
2. Click **Add New Project** → select `skaly-portal` from the GitHub list → **Import**.
3. **Configure Project:**
   - Framework Preset: `Next.js`
   - Root Directory: `apps/web` (click "Edit" next to Root Directory and select)
   - Build Command: leave default (`pnpm build`)
   - Output Directory: leave default (`.next`)
   - Install Command: `pnpm install`
4. **Environment Variables:** Add the same 4 vars as `.env.local`:
   - `NEXT_PUBLIC_API_URL=https://api.skaly.in/v1` (Production), `http://localhost:3001/v1` (Preview/Dev)
   - `NEXT_PUBLIC_WS_URL=wss://api.skaly.in` (Production), `ws://localhost:3001` (Preview/Dev)
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
5. Click **Deploy**.

The first deploy will succeed (we have a real Next.js app now). You'll get a URL like `skaly-portal.vercel.app`.

#### Connect Railway API service

1. Go to your Railway project → click **+ New** → **GitHub Repo** → select `skaly-portal`.
2. Railway will scan and detect the monorepo. Configure:
   - **Service name:** `api`
   - **Root Directory:** `apps/api`
   - **Build Command:** `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @skaly/api build`
   - **Start Command:** `pnpm --filter @skaly/api start`
3. Click **Variables** → add every variable from your `apps/api/.env` (production values where they differ — production DATABASE_URL is the Railway Postgres internal URL, REDIS_URL is your Upstash production instance once you create it, R2_BUCKET_NAME is `skaly-portal-prod`, etc.).
4. **TZ=Asia/Kolkata** — critical for the rollover cron timing.
5. Click **Deploy**.

#### Connect Railway PostgreSQL to GitHub Secrets

1. In Railway → PostgreSQL service → **Connect** tab → copy the production `DATABASE_URL`.
2. Go to GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
3. Name: `DATABASE_URL_PROD`, value: the Railway prod URL.
4. This lets the `deploy-api.yml` workflow run migrations against production on every push to main.

#### Final Sprint 0 verification

Open `https://YOUR-PROJECT.vercel.app` — you should see the gold "Scaly Business Portal" headline on production.

Open `https://YOUR-API.up.railway.app/v1/health` — health check returns ok.

Both deploys green. Sprint 0 complete.

---

### SPRINT 0 — CLOSE-OUT CHECKLIST

Open `docs/SPRINT-0-READINESS-CHECKLIST.md` and tick every box. Every blocker (B-01, B-02, B-03), every critical (C-01 through C-06), every audit-added Sprint 0 task (M-02 mobile gate, M-10 dev seed, M-11 README, L-09 Dependabot, H-04 bot streaming reference, H-03 db:refresh-views) should be ✅.

If any item is unchecked, **stop and resolve it before Sprint 1.** Sprint 1 is auth — it expects the foundation to be solid.

**Decisions that must be made before Sprint 1:**

- **B-02 — T1–T4 templates:** Confirmed delivery date from design lead OR commit to fallback (build auth UI from shadcn primitives directly). Decision before Day 5 of Sprint 0.
- **H-06 — Shoot slot counts:** Communicated deadline to operations team (end of Sprint 4). If not delivered, use placeholder 4 per Fix Guide V2 H-06.
- **OD-07 — Transactional email policy:** Out of scope confirmed in writing (Stakeholder sign-off).

When all green, commit your final Sprint 0 PR:
```bash
git add .
git commit -m "Sprint 0: close-out (B-01, B-03, C-05, H-04, audit doc patches, README)"
git push
```

Move to PART 8.

---

(Continued in PART 9 — Sprints 1 through 13 + Launch)

## PART 8 — AUDIT FINDINGS MAPPED TO SPRINTS

Sprint 0 handles every blocker plus several critical and high audit findings up-front because they belong in the foundation. The remaining audit items live inside specific feature sprints. This table is your cross-reference — when you're in a sprint, you check here for what audit-driven work belongs in it before you start.

The findings reference numbers (B-01, C-04, H-05, etc.) come from `docs/14-PRE-BUILD-AUDIT.md` and `docs/FIX-GUIDE-V2-COMPLETE.md`. Both are in your `docs/` folder.

| Sprint | Audit Items In This Sprint | Source |
|---|---|---|
| **Sprint 0** | B-01 (database roles migration 026), B-02 (T1–T4 templates fallback), B-03 (internalAuth timingSafeEqual), C-04 (system actor in audit_log), C-05 (websocket JWT refresh), C-06 (rollover bootstrap guard — code only, runs in Sprint 12), H-03 (materialised view first refresh non-concurrent), H-04 (bot streaming handler reference), H-07 (Sentry skeleton — wired in Sprint 13), H-08 (CSP header in vercel.json), H-09 (db pool monitoring code), M-02 (mobile gate), M-06 (rate-limit response headers), M-10 (dev seed clients), M-11 (README), L-09 (Dependabot) | Pre-build audit, Fix Guide V2 |
| **Sprint 1** | H-04 (signup duplicate prevention partial unique index), M-02 (attendance backfill on signup approval), C-04 (rejection_note never in response) | Fix Guide V2 H-04, M-02; APPFLOW §2.6 |
| **Sprint 2** | C-02 (optimistic lock version check, schema comment update), C-04 (audit log System Actor UUID, never NULL), H-02 (softDelete helper), M-06 (rate-limit headers already done in Sprint 0 — verify in route tests), M-12 (Swagger UI for dev only) | Pre-build audit, Fix Guide V2 |
| **Sprint 3** | H-01 (holiday remove cascade with proper transaction), Column ownership backstop test | Fix Guide V2 H-01 |
| **Sprint 4** | Task assignment notification fires per-assignee | IMPL-PLAN §7 |
| **Sprint 5** | H-03 (multi-assignee notification test), H-06 (adjustSlotCount endpoint or placeholder) | Fix Guide V2 H-03, H-06 |
| **Sprint 6** | H-02 (Trigger 2 uses server CURRENT_DATE in IST — accepted MVP limitation) | Fix Guide V2 H-02 |
| **Sprint 7** | Optimistic locking 409 conflict UI | IMPL-PLAN §10 |
| **Sprint 8** | C-01 (bot HTTP returns 202, tokens via WebSocket only), H-01 (GET /v1/bot/session/current shape), Verify Anthropic model strings via API before wiring | Fix Guide V2 C-01, H-01 |
| **Sprint 9** | M-05 (search query strategy), M-08 (bot tool error messages plain-language) | Fix Guide V2 M-05, M-08 |
| **Sprint 10** | H-05 (socket joins all three rooms on connect), Wire C-05 client-side socket token refresh, Full coverage of all notification types | Fix Guide V2 H-05; pre-build audit |
| **Sprint 11** | M-01 (avatar upload — Fix Guide V2 has all 4 prompts), Staff reactivate endpoint | Fix Guide V2 M-01 |
| **Sprint 12** | C-03 (migration 024 ends non-concurrent refresh — already shipped in Sprint 0 STEP 6, verify in test), C-06 (rollover bootstrap guard active), H-05 (rollover_failed notification recipients), M-05 (rollover sets locked_by = SYSTEM_ACTOR_UUID), M-07 (comment notification dedup), M-09 (PDF font embedding) | Pre-build audit, Fix Guide V2 |
| **Sprint 13** | H-07 (Sentry wired, errors sent), H-08 (CSP report-only → enforce), H-09 (pool monitoring → alert thresholds), Full Playwright E2E, k6 perf, DNS, launch | Pre-build audit |

If a finding has a `B-` or `C-` prefix and isn't in Sprint 0 or here — stop and check. Blockers and criticals are by definition done before they're depended on.

---

## PART 9 — SPRINTS 1 THROUGH 13: THE EXACT FLOW

Every sprint below follows the same shape:

- **Goal** — what you're producing this sprint
- **Read first** — which spec sections to open in Antigravity's split view before you prompt
- **The driving prompt** — the first prompt you give Claude. Subsequent prompts in the sprint follow the same WHERE/WHAT/RULES pattern but get shorter as context builds.
- **Audit items to slot in** — the items from PART 8 that belong inside this sprint
- **Definition of done** — what you check before you commit
- **Git commit message** — the exact message format

If you need to break a prompt apart because Claude is producing too much at once and quality drops, do it. The driving prompt below is the *first* of usually 3–6 prompts per sprint. Use the same Verify-Before-Moving-On loop from PART 6 between every prompt.

---

### SPRINT 1 — AUTH + SIGNUP

**Duration:** Week 2 (5 working days) | **Owner:** TL + D1

**Goal:** Users can log in with email/password or Google OAuth, sign up via invite link or self-signup-with-CV, admins can review and approve/reject signup requests, MFA enrollment works for admin/manager, password reset works, session refresh works.

**Read first** (open in Antigravity split view):
- `docs/04-APPFLOW.md` §1 (login), §2 (signup — all paths), §3 (MFA)
- `docs/07-API-CONTRACT.md` §1 (auth endpoints)
- `docs/08-AUTH-MATRIX.md` (entire doc — RBAC model)
- `docs/06-IMPLEMENTATION-PLAN.md` §4
- `docs/FIX-GUIDE-V2-COMPLETE.md` §H-04, §M-02

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprint 0 is complete. The monorepo is scaffolded, all 26 migrations have run, security plugins are in place, deploys are green. Now I'm starting Sprint 1 (auth + signup).
>
> **WHAT TO BUILD**
>
> Read `docs/04-APPFLOW.md` §1 and §2 and `docs/07-API-CONTRACT.md` §1. Then build the complete Fastify auth plugin and all auth endpoints in `apps/api/src/`.
>
> 1. **`apps/api/src/middleware/auth.plugin.ts`** — a Fastify plugin that:
>    - Verifies Supabase JWT (RS256) on every request to a protected route.
>    - On verify, looks up the staff row by `supabase_uid`. Cache result in Redis as `staff_lookup:{uid}` with 5-minute TTL.
>    - Sets `request.user = { id, supabase_uid, role, name, email, active }`. (Type from `apps/api/src/types/fastify.d.ts` — Sprint 0 STEP 5.)
>    - Rejects with 401 if JWT invalid, user inactive, or user soft-deleted.
>    - Exposes a `requireRole(...roles)` route preHandler factory for RBAC.
>
> 2. **`apps/api/src/services/AuthService.ts`** — service layer for invite, signup-request, approve, reject, MFA enroll, MFA verify, password reset. Follow the service-pattern: validation → ownership/permission check → write → audit → notification.
>
> 3. **Routes in `apps/api/src/routes/auth/`:**
>    - `POST /v1/auth/invite` (admin only) — creates `invite_links` row + calls Supabase `auth.admin.inviteUserByEmail`. Token TTL 7 days.
>    - `POST /v1/auth/signup/invite` — public — validates token, creates Supabase user + staff row with all 6 fields from APPFLOW §2.6.
>    - `POST /v1/auth/signup/request` — public — multipart form upload: CV + 6 fields. **Audit H-04**: reject if email already exists in `staff` (active OR soft-deleted) with `{ code: 'ALREADY_PROCESSED' }`. The partial unique index from migration 002 prevents duplicate pending requests at DB level.
>    - `POST /v1/auth/signup-requests/:id/approve` (admin) — creates Supabase user + staff row + notification. **Audit M-02**: immediately call `AttendanceService.backfillCurrentPeriod(newStaffId)` after staff row insert, inside the same transaction.
>    - `POST /v1/auth/signup-requests/:id/reject` (admin) — sets status, writes `rejection_note` to DB only, sends notification to user with `public_message` only (never `rejection_note`).
>    - `GET /v1/settings/signup-requests` (admin only) — returns pending signup requests.
>    - `POST /v1/auth/password-reset`, `POST /v1/auth/password-reset/confirm`, `POST /v1/auth/refresh`, `DELETE /v1/auth/session`, `POST /v1/auth/mfa/enroll`, `POST /v1/auth/mfa/verify` — all per API Contract §1 shapes.
>
> 4. **Tests in `apps/api/test/auth/`:**
>    - Unit: Zod schema validates each signup field per APPFLOW §2.6.
>    - Integration: full invite flow (admin invites → user signs up → staff row exists with correct role).
>    - Integration: self-signup → admin approves → backfill ran (attendance rows exist for new staff for current period).
>    - Integration: rejection response payload contains `public_message`, never `rejection_note`. Use a snapshot or explicit field assertion.
>    - Integration: admin-only endpoints return 403 for team_member / manager / freelancer (test all three).
>    - Integration: duplicate signup email returns `ALREADY_PROCESSED` (audit H-04).
>
> **RULES**
>
> - Every write uses `AuditService.log()` with the System Actor UUID for non-user-initiated entries (Sprint 0 STEP 6 migration 026 already revoked write perms on audit_log — the only path is via the service).
> - Every endpoint uses Zod for body validation via `fastify-type-provider-zod` (Sprint 0 STEP 5).
> - The `rejection_note` field is never in any API response body. Ever.
> - The `mfa_enrolled` flag and `mfa_secret` are read/written by AuthService only — no other service touches them.
> - Service methods take a transaction parameter where applicable so approval + backfill happen atomically.
> - **Verify before moving on.** After you write the plugin, write a tiny test that boots Fastify with the plugin and makes one request with a stubbed JWT. Get that green. Then write services. Then routes. Then full tests.
>
> Start with the auth plugin (file 1). Show me the file. I'll review and then say "go" before you continue.

**Audit items to slot in:** H-04 (duplicate email rejection), M-02 (attendance backfill on approval), C-04-related (rejection_note privacy).

**Definition of done:**
- All endpoints in API Contract §1 respond with documented shapes.
- All 5 test categories above pass.
- `pnpm test --filter @skaly/api auth/` green.
- Manual smoke test: invite a user from `/settings/invites` (next sprint will build the UI, for now hit the endpoint from `curl`), receive the email, click the link, complete signup. Then log in. Both should work.
- Frontend pages from IMPL-PLAN §4.2 are built (`/login`, `/signup`, `/signup/pending` with polling, `/mfa-setup`, `/forgot-password`, `/reset-password`). Next.js middleware protects the `(portal)` route group.

**Git commit message:**
```
Sprint 1: auth, signup, MFA, password reset (H-04, M-02)
```

---

### SPRINT 2 — DATABASE SCHEMA + API SCAFFOLD

**Duration:** Week 3 | **Owner:** TL + D2 + D3

**Goal:** Every table from migration 001–025 has a Kysely-generated TypeScript type. The base service pattern is established. AuditService, NotificationService, EventBus, Socket.io scaffold, Redis presence model, and the month-lock check utility are all in place. The read endpoints for clients, months, and staff exist. R2 presigned-URL utilities work.

**Read first:**
- `docs/05-BACKEND-SCHEMA.md` (entire — it's the contract)
- `docs/07-API-CONTRACT.md` §2 (clients), §3 (months), §4 (staff)
- `docs/02-TRD.md` §7 (Socket.io topology), §8 (Redis schema)
- `docs/FIX-GUIDE-V2-COMPLETE.md` §C-02, §C-04, §H-02, §M-06, §M-12

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprint 1 is done. Auth works. Now I'm building the API scaffold — the base patterns every subsequent sprint depends on.
>
> **WHAT TO BUILD**
>
> 1. **Kysely types refresh.** Already done in Sprint 0 STEP 12, but verify `packages/shared/src/db.types.ts` reflects all 25 schema migrations + migration 026 grants. If anything drifted, regenerate: `cd apps/api && pnpm kysely-codegen --url $DATABASE_URL --out-file ../../packages/shared/src/db.types.ts`.
>
> 2. **Base service pattern.** Read `docs/06-IMPLEMENTATION-PLAN.md` §5 carefully. Create `apps/api/src/services/BaseService.ts` that exports a small set of utilities every service will use:
>    - `assertPeriodNotLocked(periodId: string, trx: Transaction<DB>)` — throws `PERIOD_LOCKED` error if locked.
>    - `softDelete(table, id, deletedBy, trx)` — **Audit H-02** — writes `deleted_at = now()` and the changing service writes the audit row. Returns the soft-deleted row.
>    - `getCurrentPeriod(trx)` — returns the currently-active month row (status='active', is_current=true).
>    - `optimisticUpdate(table, id, expectedVersion, patch, trx)` — **Audit C-02** — runs UPDATE with `WHERE id = ? AND version = ?`, throws `STALE_DATA` (409) if rowCount is 0.
>
> 3. **AuditService.** `apps/api/src/services/AuditService.ts`:
>    - `log({ actorId, actorSource, entity, entityId, action, before, after, trx })` — writes one row to `audit_log`. `actorSource` defaults to `'web'` per migration 025. **Audit C-04**: when called from RolloverJob or other automated context, use `SYSTEM_ACTOR_UUID = '00000000-0000-0000-0000-000000000000'` as `actorId`. Never NULL.
>    - The migration 026 lockdown (Sprint 0) ensures this is the only write path.
>
> 4. **NotificationService.** `apps/api/src/services/NotificationService.ts`:
>    - `create({ recipientId, type, title, body, data, trx })` — writes to `notifications` table + emits `notification:new` to `user:{recipientId}` Socket.io room.
>    - All 18 notification types from `docs/05-BACKEND-SCHEMA.md` migration 014 are valid (do not state a count in code — read from the type enum).
>
> 5. **EventBus.** `apps/api/src/lib/EventBus.ts` — a typed in-process event emitter for `shoot:confirmed` (Trigger 1) and `pipeline:posted` (Trigger 2). Specific listeners get wired in Sprints 6 and 7.
>
> 6. **Socket.io scaffold.** `apps/api/src/sockets/index.ts` — boots Socket.io v4 with `@socket.io/redis-adapter` per `docs/02-TRD.md` §7. Three namespaces: `/portal`, `/bot`, `/presence`. JWT auth on handshake. **Audit H-05** preview: on authenticated connect, join `user:{staffId}`, `role:{role}`, `org:all` rooms. We'll test this fully in Sprint 10.
>
> 7. **Redis presence model.** `apps/api/src/sockets/presence.ts` — on `/presence` namespace connect, `SET presence:{staffId} 1 EX 60`. Heartbeat every 30s refreshes TTL. On disconnect, `DEL` is not required (TTL handles it).
>
> 8. **Read endpoints.** `apps/api/src/routes/clients/`, `months/`, `staff/` — implement:
>    - `GET /v1/clients` (active only by default, `?includeInactive=true` for admin)
>    - `GET /v1/months`, `GET /v1/months/current`
>    - `GET /v1/staff` (limited fields per role per AUTH-MATRIX)
>    - `GET /v1/staff/:id` (full profile for admin/manager/own staff row)
>
> 9. **R2 presigned URL utilities.** `apps/api/src/lib/r2.ts` — `getPresignedUploadUrl(key, contentType, ttlSeconds)` and `getPresignedDownloadUrl(key, ttlSeconds)` using `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` against `R2_BUCKET_NAME`. 15-minute TTL default for upload, 1-hour for download.
>
> 10. **Swagger UI** — **Audit M-12** — register `@fastify/swagger` + `@fastify/swagger-ui` ONLY when `NODE_ENV !== 'production'`. Mount at `/docs`. Schemas come automatically from the Zod validators.
>
> 11. **Tests:**
>    - Unit: each base utility (assertPeriodNotLocked throws correct error, softDelete writes deleted_at, optimisticUpdate throws on version mismatch).
>    - Integration: GET /v1/clients returns 200 with empty list initially.
>    - Integration: AuditService.log writes to audit_log table.
>    - Integration: NotificationService.create both writes DB and emits socket event (use socket.io-client in test).
>
> **RULES**
>
> - Every service method that writes takes a `trx: Transaction<DB>` parameter so it composes inside larger transactions.
> - Every Service method first calls `assertPeriodNotLocked` before write-on-period-bound entities.
> - The `version` column from migration 025 is the **active** optimistic lock column. If `docs/05-BACKEND-SCHEMA.md` still says "future use," ignore that and treat `version` as live (Fix Guide V2 C-02).
> - **Verify before moving on.** After base utilities are written, smoke them with a single integration test. Then build services. Then routes.
>
> Start with `packages/shared/src/db.types.ts` regeneration verification. Show me the diff (or "no changes"). Then proceed to BaseService.

**Audit items to slot in:** C-02, C-04, H-02, M-06 (verify in route tests — header presence), M-12.

**Definition of done:**
- All read endpoints return shapes matching API Contract §2–§4.
- `pnpm typecheck` green across all packages.
- AuditService, NotificationService, EventBus, R2 utilities all have at least one integration test.
- Manual: hit `http://localhost:3001/docs` and see Swagger UI listing auth + clients + months + staff routes.

**Git commit message:**
```
Sprint 2: schema types, base service, audit/notif/events, socket scaffold, read endpoints (C-02, C-04, H-02, M-12)
```

---

### SPRINT 3 — STAFF ATTENDANCE

**Duration:** Week 4 | **Owner:** D1 + D2

**Goal:** The Staff Attendance module works end-to-end: admin/manager sees the full grid; team_member sees the grid but can only edit their own column. Mid-month new staff get attendance backfilled. Holidays are admin-only and broadcast via Socket.io. Locked periods are read-only.

**Read first:**
- `docs/04-APPFLOW.md` §4 (Staff Attendance)
- `docs/07-API-CONTRACT.md` §5 (attendance), §6 (holidays)
- `docs/03-UIUX.md` §4 (Staff Attendance UI — grid, gold highlight, popover)
- `docs/06-IMPLEMENTATION-PLAN.md` §6
- `docs/FIX-GUIDE-V2-COMPLETE.md` §H-01

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprint 2 is done. Base patterns are in place. Now I'm building the Staff Attendance module (first full module).
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/services/AttendanceService.ts`:**
>    - `getGrid(periodId, currentUser, trx)` — returns full grid for admin/manager; team_member receives full grid for **display** but their `editableStaffIds = [currentUser.id]` is computed and returned so the UI can disable other columns. (Backend enforcement on PATCH separately.)
>    - `update(attendanceId, patch, currentUser, expectedVersion, trx)` — **ownership enforced at API layer**: if `currentUser.role === 'team_member'` and the row's `staff_id !== currentUser.id`, throw 403. Otherwise call `optimisticUpdate` from BaseService.
>    - `backfillCurrentPeriod(newStaffId, trx)` — used by Sprint 1's signup approval. Generates one attendance row per remaining working day from the current date to end-of-period.
>    - `recalculatePresentDays(attendanceId, trx)` — runs after every PATCH that changes status/work-log presence.
>
> 2. **`apps/api/src/services/HolidayService.ts`:**
>    - `create({ periodId, date, name, currentUser, trx })` — admin only. Marks all attendance rows for that date as `status='holiday'`, emits Socket.io broadcast `attendance:holiday_added` to `org:all`.
>    - **Audit H-01:** `remove(holidayId, currentUser, trx)` — admin only. Reverts all affected attendance rows for the date back to their pre-holiday state. Wraps both deletion and reversion in a single transaction. Emits `attendance:holiday_removed`. Spec is in `docs/FIX-GUIDE-V2-COMPLETE.md` §H-01.
>
> 3. **Routes:**
>    - `GET /v1/attendance?period=<id>` — calls `AttendanceService.getGrid`.
>    - `PATCH /v1/attendance/:id` — body validates with Zod, includes `version`.
>    - `GET /v1/holidays?period=`, `POST /v1/holidays`, `DELETE /v1/holidays/:id`.
>
> 4. **Frontend (`apps/web/src/app/(portal)/attendance/page.tsx`):**
>    - TanStack Table v8 grid. Columns = staff. Rows = dates.
>    - Row variants: working (interactive), `sunday` (greyed `bg-muted/30`), `holiday` (`bg-gold-tint-06` — that's `hsl(var(--gold) / 0.06)`).
>    - Team member: render disabled columns with `pointer-events: none` and `opacity: 0.4` on cells. **CSS only, no JS gating.** (`docs/03-UIUX.md` §4.2.)
>    - Gold column highlight (Amendment 2 of UIUX): `useColumnHighlight` hook applied to all editable cells — the highlighted column's accent is `hsl(var(--gold) / 0.12)` on the column header and `hsl(var(--gold) / 0.04)` on each cell.
>    - Work-log textarea: 800ms debounce autosave via TanStack Query `useMutation` + a debounce ref.
>    - Locked period: every cell renders as `<span>` not `<input>`. Banner at top: "This period is locked. Read-only."
>    - Footer row: per-column total days present.
>    - Optimistic-lock 409 handler: inline message "Updated by {staffName} — [Refresh row →]" — clicking refresh re-fetches that row.
>
> 5. **Tests:**
>    - Unit: AttendanceService.update returns 403 when team_member tries to edit another's row.
>    - Unit: optimistic-lock STALE_DATA on mismatched version.
>    - Integration: Holiday creation marks all attendance rows for that date as holiday.
>    - Integration: H-01 — Holiday removal reverts attendance rows in the same transaction.
>    - Integration: Mid-month new staff backfill creates correct number of rows.
>    - Integration: Socket.io `attendance:holiday_added` broadcast received by a test client.
>    - Playwright (smoke): admin can edit any cell; team_member can only edit own column.
>
> **RULES**
>
> - All writes use `assertPeriodNotLocked` first.
> - Locked period: the FE renders read-only; the BE rejects writes with PERIOD_LOCKED. Defense in depth.
> - Holiday removal is a full reversal, not just `DELETE FROM holidays`. The Fix Guide V2 H-01 code is the spec.
> - **Verify before moving on.** After service, write the unit tests. Then routes. Then frontend.
>
> Start with `AttendanceService.ts`. Show me when done.

**Audit items to slot in:** H-01 (holiday cascade), column ownership backstop test.

**Definition of done:**
- Grid renders for all four roles correctly.
- Edit + autosave works (network tab shows ~800ms after typing stops).
- Holiday addition + removal both broadcast and revert correctly.
- Mid-month backfill works (test via Sprint 1's signup approval flow with the period mid-way).

**Git commit message:**
```
Sprint 3: Staff Attendance (H-01 holiday cascade, column ownership)
```

---

### SPRINT 4 — WORK ALLOCATION (TASKS)

**Duration:** Week 5 | **Owner:** D1 + D3

**Goal:** Tasks can be created by admin/manager, assigned to one or many staff, have attachments, dependencies, and notify each assignee individually. Team members can update status + result on their own assigned tasks. Soft delete works.

**Read first:**
- `docs/04-APPFLOW.md` §5 (Tasks)
- `docs/07-API-CONTRACT.md` §7 (tasks)
- `docs/03-UIUX.md` §5
- `docs/06-IMPLEMENTATION-PLAN.md` §7

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprint 3 is done. Attendance works. Now Sprint 4 — Tasks.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/services/TaskService.ts`** with create, update, delete (soft), assign, unassign, attachment upload (presign + confirm + download), dependency check.
>
> 2. **Routes per API Contract §7.** `GET /v1/tasks?period=&date=&status=&clientId=&assigneeId=` with role-filtered results. `POST /v1/tasks` (admin/manager only). `PATCH /v1/tasks/:id` (team_member restricted to `status` + `result` on own assigned tasks — enforce in service). `DELETE /v1/tasks/:id` — soft delete via `BaseService.softDelete`. `POST /v1/tasks/:id/assignees`. `POST /v1/tasks/:id/attachments/presign|confirm|download`, `DELETE /v1/tasks/:id/attachments/:attachmentId`.
>
> 3. **Dependency blocking.** When transitioning a task to `status='Done'`, service first checks all `task_dependencies` for that task. If any dependency `status !== 'Done'`, throw `DEPENDENCY_NOT_DONE` (422).
>
> 4. **Notifications.** Task creation (or reassignment) fires `task_assigned` notification **once per assignee** — the assignment loop calls `NotificationService.create` per assignee in the same transaction. Per `docs/06-IMPLEMENTATION-PLAN.md` §7 and Fix Guide V2 H-03 (we'll write the test for this in Sprint 5).
>
> 5. **Frontend (`apps/web/src/app/(portal)/tasks/page.tsx`):**
>    - TanStack Table grouped by `date` (collapsible date headers).
>    - Date group collapse state in Zustand + persisted to `sessionStorage`.
>    - Right-panel slide-in form (Framer Motion `x: '100%'` → `x: 0`) for new-task creation.
>    - Attachment panel: drag-and-drop upload, progress bar, file list.
>    - Dependency badge on row: "Blocked by: [description]" when unresolved.
>    - Gold column highlight on all editable cells (status, result, assignees).
>
> **RULES** as before. Verify before moving on. Start with TaskService.

**Definition of done:**
- All CRUD + assignment + attachment endpoints respond correctly.
- Tests: ownership enforcement (team_member cannot edit unassigned task), dependency block (200 → Done blocked when dep not done), notification per assignee.
- Frontend: grid + form + attachments all work.

**Git commit message:**
```
Sprint 4: Tasks (CRUD, assignment, attachments, dependencies)
```

---

### SPRINT 5 — SHOOT PLANNER

**Duration:** Week 6 | **Owner:** TL + D2

**Goal:** Shoot Planner grid works: slots can be filled, freelancers assigned, slot reset (with `{confirm:true}`). Mid-month new clients get shoot slots backfilled. Trigger 1 (shoot:confirmed → ContentDropperService.setComingShootDate) fires.

**Read first:**
- `docs/04-APPFLOW.md` §6 (Shoot Planner)
- `docs/07-API-CONTRACT.md` §8
- `docs/03-UIUX.md` §6
- `docs/06-IMPLEMENTATION-PLAN.md` §8
- `docs/FIX-GUIDE-V2-COMPLETE.md` §H-03, §H-06

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprint 4 done. Tasks work. Now Sprint 5 — Shoot Planner.
>
> **WHAT TO BUILD**
>
> 1. **`ShootPlannerService.ts`** — get-grid, update-slot, reset-slot, assign-freelancer, mid-month backfill.
>
> 2. **`POST /v1/shoot-planner/:id/reset`** — body **must contain `{ confirm: true }`**. If absent or false, return 400 with `{ code: 'CONFIRMATION_REQUIRED' }`. This is a destructive action and the explicit confirmation gate is the spec.
>
> 3. **Slot status transitions trigger event.** When `slot_status` transitions to `confirmed` (with a `slot_date` set), emit `shoot:confirmed` via EventBus. The listener (we'll wire in Sprint 6) updates `content_dropper.coming_shoot_date`.
>
> 4. **Freelancer assignment** — `PATCH /v1/shoot-planner/:id { freelancerId }` + `freelancer_assigned` notification to that freelancer.
>
> 5. **Mid-month new client backfill** — when a client becomes active mid-month, generate shoot slot rows for the remaining weeks of the current period.
>
> 6. **H-06 placeholder strategy.** If the operations team hasn't delivered per-client slot counts yet, default `slot_count = 4` per Fix Guide V2 H-06. Expose `PATCH /v1/clients/:id/shoot-slot-count { slotCount }` (admin) so it can be adjusted later without code changes.
>
> 7. **Frontend (`apps/web/src/app/(portal)/shoot-planner/page.tsx`):**
>    - TanStack Table with dynamic column count (the max `slot_count` across active clients).
>    - Week groupings computed at render time via `date-fns getISOWeek()` on `slot_date`.
>    - N/A cells (clients with fewer slots than the grid max): `opacity: 0.15`, `pointer-events: none`, display "—".
>    - Slot popover: date picker + pieces stepper + freelancer dropdown + "Confirm shoot" CTA. Gold column highlight applied.
>
> 8. **Tests:**
>    - **H-03**: Integration test — assigning a task to N team members (in Sprint 4's TaskService) results in exactly N `task_assigned` notifications. We back-port this test into the Tasks module now. (This is the only audit item with cross-sprint scope.)
>    - Integration: reset without `confirm:true` returns 400.
>    - Integration: shoot:confirmed event fires when slot status moves to confirmed (use a spy on EventBus).
>    - Integration: mid-month client activation generates expected number of slot rows.
>
> **RULES** as before. Start with ShootPlannerService.

**Audit items to slot in:** H-03 (multi-assignee notification test back-port), H-06 (slot count placeholder + adjustSlotCount endpoint).

**Git commit message:**
```
Sprint 5: Shoot Planner (Trigger 1, freelancer assign, H-03 test, H-06 placeholder)
```

---

### SPRINT 6 — CONTENT DROPPER + TRIGGER 1

**Duration:** Week 7 | **Owner:** TL + D1

**Goal:** Content Dropper grid works. Trigger 1 from Sprint 5 actually mutates content_dropper rows. Trigger 2 (pipeline:posted → content_calendar) fires from the Posted stage.

**Read first:**
- `docs/04-APPFLOW.md` §7 (Content Dropper)
- `docs/07-API-CONTRACT.md` §9
- `docs/03-UIUX.md` §7
- `docs/06-IMPLEMENTATION-PLAN.md` §9
- `docs/FIX-GUIDE-V2-COMPLETE.md` §H-02

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprint 5 done. Shoot Planner works. Now Sprint 6 — Content Dropper, plus the consumer of Trigger 1 and the producer of Trigger 2.
>
> **WHAT TO BUILD**
>
> 1. **`ContentDropperService.ts`** with `updateStage(rowId, stage, currentUser, trx)`. Validate stage sequence at service layer (Shoot → Edit → Review → Posted, no skipping).
>
> 2. **Trigger 1 consumer.** Register an EventBus listener on `shoot:confirmed`: `ContentDropperService.setComingShootDate(clientId, periodId, shootDate)`. The Content Dropper row's `coming_shoot_date` is updated.
>
> 3. **Trigger 2 producer.** When `ContentDropperService.updateStage` transitions a row to `stage='Posted'`, emit `pipeline:posted` via EventBus with payload `{ clientId, periodId, postedAtServerDate }`. **Audit H-02**: `postedAtServerDate` is computed server-side as `CURRENT_DATE` in IST — accepted MVP limitation per PRD §6, APPFLOW §15. Do **not** add a `posted_date` field to the schema. (The Sprint 7 calendar listener uses this to find the calendar cell.)
>
> 4. **Client name inline edit.** `PATCH /v1/clients/:id { name }` — admin/manager only. After mutation, frontend invalidates `['clients']` query.
>
> 5. **Frontend (`apps/web/src/app/(portal)/content-dropper/page.tsx`):**
>    - Grid with stage cells (each showing timestamp once filled), progress bar across stages.
>    - `coming_shoot_date` indicator (small ↑ icon + date) near client row.
>    - Sequence violation: toast + shake animation on illegal transition attempt — **before** the API call.
>    - Trigger 1 response: toast "Shoot confirmed. Content Dropper updated."
>    - Gold column highlight on all editable cells.
>
> 6. **Tests:**
>    - Unit: stage sequence validation rejects skips.
>    - Integration: Trigger 1 — slot confirmed in shoot_planner → content_dropper.coming_shoot_date is set (use real EventBus).
>    - Integration: Trigger 2 — content_dropper row moved to Posted → pipeline:posted event fires with correct payload.

**Audit items:** H-02 (Trigger 2 server-side date — MVP limitation accepted).

**Git commit message:**
```
Sprint 6: Content Dropper + Trigger 1 consumer + Trigger 2 producer (H-02)
```

---

### SPRINT 7 — CONTENT CALENDAR + TRIGGER 2

**Duration:** Week 8 | **Owner:** D1 + D2

**Goal:** The 31-day × N-client calendar grid works at scale with TanStack Virtual. Trigger 2 consumer mutates the right calendar cell. Optimistic-lock conflicts surface inline.

**Read first:**
- `docs/04-APPFLOW.md` §8 (Content Calendar)
- `docs/07-API-CONTRACT.md` §10
- `docs/03-UIUX.md` §8
- `docs/06-IMPLEMENTATION-PLAN.md` §10

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprint 6 done. Triggers 1 and 2 are firing. Now Sprint 7 — the Content Calendar that consumes Trigger 2 and is the largest grid in the app.
>
> **WHAT TO BUILD**
>
> 1. **`ContentCalendarService.ts`** — `getGrid(periodId, currentUser, trx)` returns all 31 days × all active clients (around 620+ cells for 20 clients × 31 days). `updateCell(cellId, patch, expectedVersion, currentUser, trx)` — uses `BaseService.optimisticUpdate`.
>
> 2. **Trigger 2 consumer.** EventBus listener on `pipeline:posted`: `ContentCalendarService.updateCellFromPipeline({ clientId, periodId, postedAtServerDate })` — finds the cell for that client × date and sets `status='posted'`. If no cell exists for that date (shouldn't happen post-rollover), log a warning and create one.
>
> 3. **Frontend (`apps/web/src/app/(portal)/calendar/page.tsx`):**
>    - TanStack Table + TanStack Virtual v3 — **column virtualisation** because client count can be large. (Row count fixed at 31.)
>    - Today's row: `bg-gold-tint-06`, auto-scroll into view on page load.
>    - Status chips with 6-value vocabulary: `planned`, `in_progress`, `ready`, `posted`, `reposted`, `skipped` — each with its colour per UIUX §8.3.
>    - Pipeline-trigger indicator: 6px gold dot on cells that came from Trigger 2 (data field: `posted_via_trigger`).
>    - Inline popover editor: 200px, status dropdown + note textarea, close on outside-click.
>    - Gold column highlight via overlay approach (positioned div) because virtualised cells unmount on scroll.
>    - Team member: `pointer-events: none` on the entire virtualised grid; the comment box (Sprint 12) remains interactive via z-index.
>
> 4. **Optimistic-lock conflict UI.** Inline message in the affected cell: "Updated by {staffName} — [Refresh row →]". The refresh button re-fetches just that cell.
>
> **RULES**
>
> - Virtualisation + column highlight conflict is the Sprint 0 prototype check from the risk register. If it's not resolved, do not start this sprint.
> - Outside-click closes the popover — use `useEffect` listener on document `mousedown`, not Radix Popover's default (which has timing issues with virtual scroll).
>
> Start with ContentCalendarService, then Trigger 2 wiring, then frontend.

**Definition of done:** k6 smoke test for 50 concurrent users hitting the calendar grid endpoint stays under p95 500ms.

**Git commit message:**
```
Sprint 7: Content Calendar + Trigger 2 consumer + virtualised grid
```

---

### SPRINT 8 — AI BOT (QUERY TOOLS)

**Duration:** Week 9 | **Owner:** TL + D3

**Goal:** The bot can answer questions. All 11 query tools work. The HTTP endpoint returns 202 immediately; tokens stream via WebSocket. The bot session is in Redis. Bot model strings come from env.

**Read first:**
- `docs/04-APPFLOW.md` §9 (AI Bot)
- `docs/07-API-CONTRACT.md` §11 (bot)
- `docs/02-TRD.md` §10 (AI integration)
- `docs/11-THIRD-PARTY-INTEGRATIONS.md` §1 (Anthropic)
- `docs/06-IMPLEMENTATION-PLAN.md` §11
- `docs/FIX-GUIDE-V2-COMPLETE.md` §C-01, §H-01
- The `apps/api/src/lib/bot/stream-handler.ts` reference from Sprint 0 STEP 9
- `docs/decisions/ADR-002-mfa-full-wiring-deferred-to-sprint-8.md` — full MFA challenge-on-login wiring was deferred here; complete it as task 1 (role-gated bot mutations require an MFA-confirmed session)

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprints 0–7 are done. The bot streaming reference handler from Sprint 0 STEP 9 is in `apps/api/src/lib/bot/stream-handler.ts` with mocked tests. Now I'm wiring real query tools to it.
>
> **VERIFY FIRST**
>
> Before writing any model-calling code, verify the model strings against Anthropic's API. Run from the terminal:
>
> ```bash
> curl -s https://api.anthropic.com/v1/models \
>   -H "x-api-key: $ANTHROPIC_API_KEY" \
>   -H "anthropic-version: 2023-06-01" \
>   | jq '.data[].id'
> ```
>
> The output **must** include exactly:
> - `claude-sonnet-4-6` (production model)
> - `claude-haiku-4-5-20251001` (dev/test model)
>
> If either string is missing, **stop**. The model string in our spec is wrong; trying to call a wrong model returns HTTP 400 from Anthropic. Update the env and update the spec doc with the correct string — do not silently change one to match the other.
>
> **WHAT TO BUILD**
>
> 1. **`BotService.ts`** — orchestration. `handleMessage({ sessionId, staffId, userText })` → loads/initialises Redis session → builds system prompt → builds tool list (filtered by permissions) → calls Anthropic `messages.stream` → routes tool calls to handlers → archives to `messages` table on completion.
>
> 2. **`POST /v1/bot/message`** — **Audit C-01**: returns HTTP **202** with `{ messageId, sessionId }` **immediately**. The body **never** contains `content` or `card`. The bot's actual reply arrives over Socket.io `/bot` namespace as `bot:message` events containing token chunks, tool-call events, and tool-result events.
>
> 3. **`GET /v1/bot/session/current`** — **Audit H-01**: returns `{ sessionId, messages, turnCount, lastActivityAt }` (the shape from API Contract §11).
>
> 4. **`DELETE /v1/bot/session/current`** — clears `bot:session:{staffId}` from Redis. Frontend resets UI.
>
> 5. **System prompt** built at request time: includes IST date, current period code (e.g. `2026-06`), user role, and the anti-hallucination directive from THIRD-PARTY-INTEGRATIONS §1.4.
>
> 6. **Tool permission filtering.** Before sending tool list to Anthropic, load `perms:{staffId}` from Redis (5-min TTL, populated from `getEffectivePermissions(staffId)`). Filter the 11 query tools down to those the user is permitted to invoke. A team_member with no `bot:can_query_attendance` permission cannot get an attendance answer — the bot says "Ask your admin" if asked.
>
> 7. **All 11 query tools** with Zod input schemas. Each tool handler is its own file in `apps/api/src/lib/bot/tools/queries/`. Tool list per APPFLOW §9.3.
>
> 8. **Bot session in Redis.** Key `bot:session:{staffId}`. JSON: `{ sessionId, messages: [{ role, content, toolCalls? }], turnCount, lastActivityAt }`. 50-turn cap (drop oldest). 12-hour TTL refreshed on every message.
>
> 9. **Archive to messages table.** On stream completion, write the user message + final bot message to `messages` with `channel='bot'`.
>
> 10. **Frontend (`apps/web/src/app/(portal)/bot/page.tsx`):**
>    - Chat-style interface.
>    - Send button → `POST /v1/bot/message` → expect 202 → wait for `bot:message` socket events.
>    - Token-by-token streaming render.
>    - Card renderer registry — one component per tool type per APPFLOW §9.4. (All 11 cards.)
>    - `[New conversation]` control → `DELETE /v1/bot/session/current` → reset UI.
>
> 11. **Tests:**
>    - C-01 contract test: POST returns 202 with no content body.
>    - H-01 shape test: GET /v1/bot/session/current matches API Contract §11.
>    - Integration: send "How many tasks does Sohail have today?" — assert tool call fires, response card payload correct.
>    - Permission filter test: a team_member with `bot:can_query_attendance=false` asks an attendance question and gets refusal text.

**Audit items:** C-01, H-01, plus the verify-model step.

**Git commit message:**
```
Sprint 8: AI Bot — query tools, streaming over WebSocket (C-01, H-01)
```

---

### SPRINT 9 — AI BOT (MUTATION) + SEARCH

**Duration:** Week 10 | **Owner:** TL + D3

**Goal:** All 11 mutation tools work with the confirmation protocol. Search across tasks/clients/staff/comments with scope toggle. Activity feed endpoint exists.

**Read first:**
- `docs/04-APPFLOW.md` §9.5 (Bot mutations), §10 (Search), §11 (Activity feed)
- `docs/07-API-CONTRACT.md` §11.5 (mutations), §12 (search), §13 (activity)
- `docs/06-IMPLEMENTATION-PLAN.md` §12
- `docs/FIX-GUIDE-V2-COMPLETE.md` §M-05, §M-08

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprint 8 done. Query bot works. Now mutation tools + search.
>
> **WHAT TO BUILD**
>
> 1. **All 11 mutation tools** with Zod input schemas. Tool files under `apps/api/src/lib/bot/tools/mutations/`. Per APPFLOW §9.5.
>
> 2. **Confirmation protocol.** When the model wants to call a mutation tool, the **first** call must return a summary card (`tool_result` block in the stream with a `confirmation_required: true` shape) — **not** execute. The frontend renders inline `[Confirm]` `[Cancel]` buttons in the bot message. User clicks Confirm → frontend re-sends with `confirmation_token` matching the summary. Only on the confirmed re-call does the tool actually mutate.
>
> 3. **Month lock check in mutations.** Every mutation tool calls `assertPeriodNotLocked` first. On `PERIOD_LOCKED`, return plain-language refusal ("This period is locked. Ask an admin to unlock it before making changes.") — **Audit M-08**.
>
> 4. **Permission denial language.** Bot never says "you need role X". Always says "Ask your admin to enable this for you." per APPFLOW §9.6. **Audit M-08.**
>
> 5. **Search.**
>    - `GET /v1/search?q=&scope=current|all_time` — 4 categories: tasks, clients, staff, comments.
>    - **Audit M-05** strategy: for each category, the service composes a Postgres `ILIKE '%q%'` query against the indexed columns from migration 022 (FTS prep). The scope `current` filters by `period_id = currentPeriod.id`; `all_time` removes the period filter. Results capped at 20 per category. Returns `{ tasks: [...], clients: [...], staff: [...], comments: [...] }`.
>    - Frontend uses `cmdk` for the palette. 200ms debounce on input.
>    - Scope toggle: `[This month] / [All time]` in the palette header.
>    - Staff result navigation: admin/manager → `/staff/:id`; team_member/freelancer → public profile modal (limited fields per AUTH-MATRIX).
>
> 6. **Activity feed.** `GET /v1/activity-feed?period=&limit=10` — separate from audit-log, role-filtered (admin/manager see all, team_member sees own actions + assignments to them).
>
> 7. **Tests:**
>    - Mutation confirmation contract: first call returns summary, second with token executes.
>    - Period-lock refusal language.
>    - Permission denial language (no role names leaked).
>    - Search returns 4 categories.

**Audit items:** M-05, M-08.

**Git commit message:**
```
Sprint 9: Bot mutations + Search + Activity feed (M-05, M-08)
```

---

### SPRINT 10 — CHAT + NOTIFICATIONS

**Duration:** Week 11 | **Owner:** D2 + D3

**Goal:** Internal chat works (channels, threads, @mentions, typing indicators, presence). All notification types deliver. Frontend wires the C-05 client-side token refresh.

**Read first:**
- `docs/04-APPFLOW.md` §12 (Chat), §13 (Notifications)
- `docs/07-API-CONTRACT.md` §14, §15
- `docs/02-TRD.md` §7 (Socket.io rooms)
- `docs/06-IMPLEMENTATION-PLAN.md` §13
- `docs/FIX-GUIDE-V2-COMPLETE.md` §H-05
- `docs/CRITICAL-PATCHES.md` §C-05

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprint 9 done. Now Chat + Notifications.
>
> **WHAT TO BUILD**
>
> 1. **`ChatService.ts`** — `getMessages`, `sendMessage`, `getThread`, `search`. Cursor pagination.
>
> 2. **Routes per API Contract §14:** `GET /v1/chat/messages?channel=&limit=&cursor=`, `POST /v1/chat/messages`, `GET /v1/chat/threads/:parentId`, `GET /v1/chat/search?q=&channel=`.
>
> 3. **Socket.io chat namespace.** Events: `chat:message`, `chat:typing`, `chat:stop_typing`, `chat:presence`. On authenticated connect, **Audit H-05** — the existing Sprint 2 socket connect handler already joins `user:{staffId}`, `role:{role}`, `org:all`. Write an integration test now that verifies a broadcast to `role:admin` is received by an authenticated admin client. (Test was deferred from Sprint 2; this sprint pays the bill.)
>
> 4. **Notification routes:** `GET /v1/notifications`, `PUT /v1/notifications/:id/read`, `PUT /v1/notifications/read-all`.
>
> 5. **All 18 notification types** covered with integration tests asserting both DB row + socket emit per type. Read types from migration 014.
>
> 6. **`rollover_failed` notification rendering** — UIUX §13.4: full-height card, no truncation, inline action button "View details →".
>
> 7. **Frontend:**
>    - Chat: infinite scroll with TanStack Virtual. Thread panel slide-in. `@mention` autocomplete (Tribute or a custom popover over a textarea — pick what fits).
>    - Typing indicator: emit `chat:typing` on keypress, auto-stop after 5s of inactivity.
>    - "New message ↓" pill appears when scroll position is not at bottom and a new message arrives.
>    - Notification panel: bell icon (Skaly SVG from your assets folder), unread badge, 380px right panel, mark-all-read.
>    - **C-05 client wiring.** Implement the client-side socket token refresh per `docs/CRITICAL-PATCHES.md` §C-05 (frontend portion). On `bot:token_expired` event, frontend re-fetches Supabase session, sends `bot:refresh_token { token }`. The server-side watcher was already built in Sprint 0 STEP 7.
>
> 8. **Tests:**
>    - H-05 broadcast test (room membership).
>    - All 18 notification types.
>    - C-05 token-refresh round trip.

**Audit items:** H-05 test, C-05 client wiring, full notification type coverage.

**Git commit message:**
```
Sprint 10: Chat + Notifications + socket refresh wiring (H-05, C-05)
```

---

### SPRINT 11 — DASHBOARD + SETTINGS

**Duration:** Week 12 | **Owner:** D1 + D2

**Goal:** All 4 role-specific dashboards render from materialised views. Settings panel is feature-complete: staff CRUD + reactivate, clients, permissions overrides, signup requests, holidays, months, audit log viewer, profile with avatar.

**Read first:**
- `docs/04-APPFLOW.md` §14 (Dashboard), §15 (Settings)
- `docs/03-UIUX.md` §14, §15
- `docs/07-API-CONTRACT.md` §16 (dashboard), §17 (staff admin)
- `docs/06-IMPLEMENTATION-PLAN.md` §14
- `docs/FIX-GUIDE-V2-COMPLETE.md` §M-01 (avatar — all 4 prompts)

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprint 10 done. Now dashboards + settings.
>
> **WHAT TO BUILD**
>
> 1. **Dashboard endpoints.**
>    - `GET /v1/dashboard/home` — role-filtered payload. Reads from materialised views (`mv_dashboard_admin`, `mv_dashboard_manager`, `mv_dashboard_team_member`, `mv_dashboard_freelancer`) created in migration 024.
>    - `GET /v1/dashboard/stats?period=` — period-bound stats.
>
> 2. **4 dashboard layouts** per UIUX §14. Each role gets its own page composition.
>
> 3. **Staff admin endpoints.**
>    - `PUT /v1/staff/:id/deactivate` (admin) — sets `active=false`, soft-deletes (`deleted_at`), invalidates Supabase sessions for that user.
>    - **Audit M-01** — `PUT /v1/staff/:id/reactivate` (admin) — sets `active=true, deleted_at=NULL`. Allows re-onboarding without duplicate staff rows. Frontend: a `[Reactivate]` button on deactivated staff rows in Settings → Staff.
>    - `PUT /v1/staff/:id/permissions/:key` (admin) — per-user permission override.
>    - `PUT /v1/staff/:id/mfa/reset` (admin).
>    - `PATCH /v1/staff/me/push-token` — Phase 2 mobile registration (no-op now, endpoint reserved).
>
> 4. **Month lock/unlock endpoints** per API Contract §17.x. Lock/unlock both require `reason` field; reason is stored on the month row and shown in the audit log.
>
> 5. **Settings panel.** All sections per APPFLOW §15: Staff, Clients, Permissions, Signup Requests, Holidays, Months, Audit Log, Reports, Profile.
>    - **Audit log viewer**: filters (entity, actor, date range), row expansion shows JSON diff of before/after, CSV export button. (Use Papaparse for client-side CSV from the visible rows.)
>    - Per-staff permission override toggles in Settings → Permissions.
>
> 6. **Avatar upload** — Audit M-01 — implement all four prompts from `docs/FIX-GUIDE-V2-COMPLETE.md` §M-01. Backend: `POST /v1/staff/me/avatar/presign` + `POST /v1/staff/me/avatar/confirm`. Frontend: drag-and-drop or click in Profile panel, image crop to square, preview, confirm. R2 key pattern `avatars/{staffId}/{uuid}.jpg`. Old avatar deleted on replacement.
>
> 7. **Tests:**
>    - Reactivate flow: deactivate → reactivate → user can log in again with no duplicate row.
>    - Avatar upload: presign returns URL, confirm writes `avatar_url` to staff row.
>    - Permission override applied to a user changes the effective permission set on next request.

**Audit items:** M-01 (avatar — 4 prompts).

**Git commit message:**
```
Sprint 11: Dashboard + Settings + Avatar (M-01)
```

---

### SPRINT 12 — ROLLOVER + REPORTS + COMMENTS

**Duration:** Week 13 | **Owner:** TL + D3

**Goal:** The monthly rollover runs (manually and via cron), retries on failure, sends plain-language failure summaries, refreshes materialised views. PDF reports generate with Skaly branding. Comments work in 3 modules.

**Read first:**
- `docs/04-APPFLOW.md` §16 (Rollover), §17 (Reports), §18 (Comments)
- `docs/06-IMPLEMENTATION-PLAN.md` §15
- `docs/07-API-CONTRACT.md` §18 (rollover), §19 (reports), §20 (comments)
- `docs/CRITICAL-PATCHES.md` §C-06 (rollover bootstrap)
- `docs/FIX-GUIDE-V2-COMPLETE.md` §M-05, §M-07, §M-09

**The driving prompt:**

> **WHERE WE ARE**
>
> Sprint 11 done. This is the most behaviourally complex sprint. Read all the linked sections before prompting any sub-task.
>
> **WHAT TO BUILD**
>
> 1. **`RolloverJob.run()`** — idempotency check (look at `months` table — does the next period already exist with `status='active'`?) + full transaction:
>    - Lock prior month (`status='locked', locked_at=now(), locked_by=SYSTEM_ACTOR_UUID`) — **Audit M-05** locked_by is NOT NULL, uses `SYSTEM_ACTOR_UUID`.
>    - Create new month row (`status='active', is_current=true`).
>    - Demote prior month (`is_current=false`).
>    - Generate attendance rows for all active staff × all working days of new period.
>    - Generate shoot_planner rows for all active clients × per-client slot_count.
>    - Generate content_dropper rows (one per client).
>    - Generate content_calendar rows (31 × clients).
>    - Audit log every action with `actor_id = SYSTEM_ACTOR_UUID, actor_source = 'system'`.
>
> 2. **Bootstrap guard.** Per `docs/CRITICAL-PATCHES.md` §C-06 — Sprint 0 already coded this. Verify it's wired in `app.ts` and that it runs `RolloverJob.bootstrapInitialMonth()` once at startup if no rows exist in `months`.
>
> 3. **Retry logic.** 3 attempts at 5-minute intervals on failure. After 3 failures, RolloverJob calls Claude Sonnet with the stack/context to generate a plain-language failure summary, then sends a `rollover_failed` notification to all admins. **Audit H-05** — `role:admin` broadcast (room joining is already in place from Sprint 2/10).
>
> 4. **`POST /v1/internal/rollover`** — runs RolloverJob.run. Auth: `X-Internal-Secret` header via the `internalAuthPlugin` from Sprint 0 STEP 7 (B-03 timingSafeEqual lives there). This is the endpoint the cron service calls.
>
> 5. **`POST /v1/internal/rollover/manual`** — admin JWT, same job. For emergency manual trigger via Settings → Months.
>
> 6. **`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_dashboard_*`** after successful rollover. Concurrent because data is large by this point. **Audit C-03**: the migration that creates them ended with non-concurrent refresh so views are populated before any concurrent refresh runs — that part was shipped in Sprint 0 STEP 6.
>
> 7. **Reports.**
>    - `POST /v1/reports/generate` (admin) — kicks off PDF generation for a period.
>    - `GET /v1/reports/:id/download` — presigned R2 URL for the PDF.
>    - `GET /v1/reports` — list.
>    - PDF template: `@react-pdf/renderer` with Skaly branding (logo, gold `#FDC257` accents on a white background). **Audit M-09**: register all three fonts (Big Shoulders Display, DM Sans, DM Mono) with PDF font embedding. Font files live in `apps/api/src/assets/fonts/`.
>
> 8. **Comments.**
>    - `GET /v1/comments?recordContext=`, `POST /v1/comments`, `PATCH /v1/comments/:id/acknowledge`.
>    - Visibility: team_member sees own + manager/admin replies; admin/manager sees all.
>    - `record_context` (JSONB) auto-populated by service at write time (route name + record IDs).
>    - **Audit M-07** dedup: integration test asserts that a comment with 2 @mentions sends 2 distinct notifications (not 1 combined, not 3 — exactly 2).
>    - Frontend: comment expansion in shoot_planner, content_dropper, content_calendar. Virtual grid (content_calendar) uses a portal-anchored overlay so the comment popover doesn't get clipped by virtualised cell boundaries.
>
> 9. **Tests:**
>    - Rollover idempotent: running twice for the same target period does not create duplicates.
>    - Rollover atomic: simulated mid-transaction error rolls back everything.
>    - Failure summary: assert claude-sonnet-4-6 was called with the expected payload (mock the SDK).
>    - C-06 bootstrap: empty `months` table on app boot creates initial period.
>    - M-05: `months.locked_by` after rollover equals `SYSTEM_ACTOR_UUID`, not NULL.
>    - M-09 PDF: fonts embedded (open the generated PDF binary and grep for font name strings).
>    - M-07 comment dedup test.

**Audit items:** C-03 verify, C-06 verify, H-05 broadcast (verify), M-05, M-07, M-09.

**Git commit message:**
```
Sprint 12: Rollover, Reports, Comments (C-03 verify, C-06, H-05 broadcast, M-05, M-07, M-09)
```

---

### SPRINT 13 — QA + PERFORMANCE + LAUNCH

**Duration:** Week 14 | **Owner:** All 4

**Goal:** Full E2E coverage with Playwright. Performance verified with k6 against NFR targets. Sentry live in production. CSP enforced. DNS cut over. Portal is live at `portal.skaly.in`.

**Read first:**
- `docs/12-TESTING-STRATEGY.md` (entire)
- `docs/13-NFRS.md` (the performance targets)
- `docs/06-IMPLEMENTATION-PLAN.md` §16
- `docs/CRITICAL-PATCHES.md` §H-07, §H-08, §H-09 (wiring up the Sprint 0 skeletons)

**The driving prompt:**

> **WHERE WE ARE**
>
> All features built. This is hardening + launch. There is no single driving prompt — instead, work through this checklist with one focused prompt per item. Do not batch.
>
> **WHAT TO DO**
>
> 1. **Sentry wire-up — Audit H-07.** Sprint 0 added the dependency and a placeholder init. Now: create the production Sentry project, set `SENTRY_DSN` in Railway + Vercel env, enable beforeSend filter to drop noisy errors (404s, validation errors). Test by manually throwing in a route handler and confirming the error appears in the Sentry dashboard within 30 seconds.
>
> 2. **CSP enforce — Audit H-08.** Sprint 0 shipped `vercel.json` with CSP in **report-only** mode. After 48 hours of report-only on staging with zero blocking findings, flip to enforce. Update `vercel.json` to remove `-Report-Only`. Re-test the entire app for blocked resources.
>
> 3. **DB pool monitoring — Audit H-09.** Sprint 0 shipped the pool monitor code in `apps/api/src/lib/db.ts`. Now: add Pino structured logs at warn level when active connections exceed 70% of pool size, and at error when 90%. Set up a Railway log alert or a Sentry breadcrumb.
>
> 4. **Playwright E2E.** Full suite covering: login, signup-via-invite, signup-via-cv-approval, attendance edit, task create + assign, shoot slot fill + confirm (Trigger 1 fires), content_dropper Posted (Trigger 2 fires + calendar updates), bot query, bot mutation with confirmation, chat send + receive, notification mark-read, rollover dry-run on staging.
>
> 5. **k6 performance tests.**
>    - All module grids at 50 concurrent users — p95 < 500ms.
>    - Rollover execution — < 60 seconds.
>    - Bot query — p95 < 4 seconds.
>    - Reports the failures with the offending endpoint + p95.
>
> 6. **Accessibility audit — WCAG 2.1 AA.** Run axe-core via Playwright on every page. All grids + all forms. Resolve any contrast/focus/label findings.
>
> 7. **Security review.** Rate-limit headers verified on every protected endpoint (audit M-06 from Sprint 0 — confirm in CI). CORS allow-list correct. Auth headers present. Presigned URL TTLs match spec (15m upload, 1h download). Internal-secret endpoint can't be hit without the header (B-03 test from Sprint 0 — confirm in CI).
>
> 8. **Backup drill.** From a Railway PostgreSQL snapshot, restore into a fresh Railway DB. Re-run migrations. Verify data integrity. Document the procedure in `docs/RUNBOOK-RESTORE.md`.
>
> 9. **Production env validation.** Run the env Zod validator (Sprint 0 STEP 5) against the actual Railway env. Run the same for Vercel preview + production. Both must produce a successful `EnvSchema.parse()` result. Capture the output, redact secrets, and paste into the launch ticket.
>
> 10. **Stage rollover.** Run RolloverJob manually against staging with production-equivalent data. Verify all generated rows are correct.
>
> 11. **First-month data migration.** Manually enter the active client roster + active team roster into production via Settings → Staff and Settings → Clients. Run rollover for the first production period.
>
> 12. **DNS cutover.** Cloudflare → add CNAME `portal.skaly.in → cname.vercel-dns.com`, CNAME `api.skaly.in → <railway-domain>.up.railway.app`. Wait for propagation (5–60 minutes). In Vercel, add `portal.skaly.in` as a production domain; in Railway, add `api.skaly.in` as a custom domain.
>
> 13. **SSL verify.** Both domains serve over HTTPS with valid certs. No mixed-content warnings in browser console.
>
> 14. **Launch.** Announce to the team. Monitor Sentry + Railway logs for the first 4 hours. Have the rollback plan ready: `vercel rollback` and `railway redeploy --revision <prev>`.

**Audit items:** H-07, H-08, H-09. Plus verification of every prior audit item via the test suite.

**Git commit message (final):**
```
Sprint 13: launch — Sentry, CSP enforce, pool monitoring, E2E + k6 + a11y, DNS (H-07, H-08, H-09)
```

---

## PART 10 — LAUNCH SEQUENCE

This is the day-of-launch playbook. Print it. Tape it to the wall. Use it.

### T-minus 7 days (Sprint 13 mid-week)

- Backup drill complete.
- Sentry receiving errors from staging.
- Playwright suite green in CI.
- k6 p95 results meet NFRs.
- DNS records ready to flip (TTL lowered to 300 seconds on `portal.skaly.in` and `api.skaly.in` so the cutover propagates fast).
- Rollback plan documented in `docs/RUNBOOK-LAUNCH.md`.

### T-minus 1 day

- Final env validation against production Railway + Vercel. Zod parse must succeed.
- Run `pnpm db:status` against production — every migration applied, no pending.
- Manually trigger `REFRESH MATERIALIZED VIEW CONCURRENTLY` on each `mv_dashboard_*` against production to populate them.
- Enter client roster + staff roster via Settings in the pre-launch Vercel preview URL (which hits production API behind feature-flag-style staff gating).
- Trigger initial rollover via `POST /v1/internal/rollover` against production (auth header). Verify all rows generated.
- Send the launch comms: subject "Portal goes live tomorrow at 10am IST. Here's what to expect."

### Launch day

1. **08:00 IST** — Final smoke test in production: login, hit dashboard, hit each module's grid, send a chat message, ask the bot a question. All green.
2. **09:00 IST** — Last chance to call off launch. If anything looks off, pull the plug now.
3. **09:30 IST** — DNS cutover. Cloudflare → set CNAMEs to live targets. Watch propagation via `dig portal.skaly.in` from multiple regions.
4. **09:45 IST** — Vercel production deploy confirmed serving on `portal.skaly.in`. Railway production confirmed serving on `api.skaly.in`. SSL valid.
5. **10:00 IST** — Send the team an internal Slack: "Portal is live at `https://portal.skaly.in`. Log in with the credentials you received yesterday."
6. **10:00–14:00 IST** — Active monitoring window. TL + 1 dev on rotation watching Sentry + Railway logs. Respond to any user-reported issue immediately.
7. **14:00 IST** — First check-in with stakeholders. Active user count, any reported issues, system health metrics.
8. **18:00 IST** — End-of-day debrief. Document anything that surprised you in `docs/RUNBOOK-LAUNCH-LESSONS.md`.

### T+1 day

- First full business day in production. Watch closely.
- Confirm overnight cron rollover schedule is registered (last day of each month, 23:55 IST). Test by setting a fake "month rollover" cron to fire in 5 minutes on staging and confirm it runs.
- Collect feedback. Triage. Schedule first patch sprint.

### Rollback procedure

If you have to roll back within the first 24 hours:

1. **Vercel:** `vercel rollback <prev-deployment-id>` — site returns to previous version in ~30 seconds.
2. **Railway:** open the service → Deployments tab → click the prior successful deploy → "Redeploy" — API returns in ~90 seconds.
3. **Database:** **do not** revert migrations unless you must. Most migrations are additive. If you must, run `pnpm db:rollback` from a local terminal pointing at `DATABASE_URL_PROD` — this drops the latest migration. Coordinate with the team before doing this.
4. **DNS:** keep DNS pointing at the rolled-back deployments. Don't change DNS during rollback — that adds propagation latency on top of the issue.

---

## PART 11 — COMMANDS REFERENCE + TROUBLESHOOTING

### Frequently used commands

```bash
# Run both apps in dev mode
pnpm dev

# Run one app
pnpm --filter @skaly/web dev
pnpm --filter @skaly/api dev

# Typecheck everything
pnpm typecheck

# Lint everything
pnpm lint

# Test everything (or one filter)
pnpm test
pnpm --filter @skaly/api test
pnpm --filter @skaly/api test attendance

# Database
pnpm db:migrate          # apply pending migrations
pnpm db:rollback         # roll back last migration
pnpm db:status           # show applied + pending
pnpm db:seed             # run all seeds (NODE_ENV-aware)
pnpm db:refresh-views    # refresh all mv_dashboard_* materialised views

# Generate Kysely types from current DB
cd apps/api && pnpm kysely-codegen \
  --url "$DATABASE_URL" \
  --out-file ../../packages/shared/src/db.types.ts

# Docker (local Postgres + Redis)
docker compose up -d
docker compose ps
docker compose logs -f postgres
docker compose down            # stop
docker compose down -v         # stop + wipe volumes (full reset)

# Connect to local Postgres
docker exec -it skaly-portal-postgres-1 psql -U skaly -d skaly_dev

# Connect to local Redis
docker exec -it skaly-portal-redis-1 redis-cli

# Production migration (via GitHub Actions workflow)
git push origin main           # triggers deploy-api.yml which runs migrations against prod
```

### Troubleshooting

#### "EADDRINUSE: address already in use 0.0.0.0:5432"

Local Postgres port is taken. Possible causes:

1. **You have a local Postgres installation running on port 5432** (Homebrew on macOS, or apt-installed on Ubuntu). Stop it:
   - macOS: `brew services stop postgresql@16`
   - Ubuntu: `sudo systemctl stop postgresql`
2. **A previous `docker compose up` left containers running.** Run `docker compose ps` and `docker compose down`.
3. **You actually need to use a different port.** Edit `docker-compose.yml` to map `"5433:5432"` instead. Then update your local `DATABASE_URL` to use 5433.

Same logic for Redis on 6379.

#### "Migration failed: relation already exists"

A previous migration partially ran and left the DB in a half-applied state. Two options:

1. **Nuke and start over** (local dev only): `docker compose down -v && docker compose up -d && pnpm db:migrate && pnpm db:seed && pnpm db:refresh-views`.
2. **Manually fix:** connect to Postgres, `DROP TABLE` the offending objects, set the migration row in `kysely_migration` to not applied, re-run `pnpm db:migrate`. Coordinate with TL first.

#### "Cannot find module '@skaly/shared'"

The packages/shared workspace isn't linked or didn't build. Run from root:

```bash
pnpm install
pnpm --filter @skaly/shared build
```

If that doesn't work, check `apps/api/package.json` and `apps/web/package.json` both have `"@skaly/shared": "workspace:*"` in their dependencies.

#### "supabase JWT verify failed: invalid signature"

Either:

1. The `SUPABASE_JWT_SECRET` in your env doesn't match the project. Re-copy it from Supabase → Project Settings → API → "JWT Secret".
2. The token came from a **different** Supabase project (e.g., you switched env vars but the browser still has a token from the old project). Clear cookies + local storage, log in again.

#### "ENOENT: no such file or directory, open './fonts/BigShouldersDisplay-Bold.ttf'"

The PDF generator (Sprint 12) can't find the font file. Put fonts in `apps/api/src/assets/fonts/` and reference them with an absolute path constructed from `__dirname` or `import.meta.url`. Don't use relative paths in the PDF template — Node's CWD at runtime is usually the repo root, not `apps/api`.

#### Materialised views are empty after rollover

You forgot the `REFRESH MATERIALIZED VIEW CONCURRENTLY` step. Run:

```bash
pnpm db:refresh-views
```

Or, in the rollover code, the `REFRESH` should be the last step after the transaction commits. If you put it inside the transaction, Postgres rejects it with "REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside a transaction block."

#### Socket.io client connects then immediately disconnects

The JWT is invalid or expired by handshake time. Open browser devtools → Network → WS → Headers → verify the `auth.token` payload is fresh. The C-05 watcher should refresh tokens before they expire; if it's not, check that the client is listening for `bot:token_expired` and re-sending.

#### "Rate limit exceeded" but you only made 3 requests

Either:

1. **You're hitting an unauthenticated rate limit harder than the spec allows** (60 req/min by default). The X-RateLimit headers tell you exactly your remaining count — check them.
2. **Redis is shared with another app.** If your Upstash instance is shared with someone else's project, their requests count against your bucket. Use a dedicated instance.
3. **A recent change removed `addHeaders: true` from the rate-limit plugin config.** Per audit M-06, this must always be on. Confirm in `apps/api/src/middleware/rateLimit.plugin.ts`.

#### Bot returns "I don't have permission to do that" for a permission you have

Stale Redis cache. Permissions are cached as `perms:{staffId}` with 5-min TTL. Invalidate:

```bash
docker exec -it skaly-portal-redis-1 redis-cli DEL "perms:<staffId>"
```

In production, hit `PUT /v1/staff/me/permissions/refresh` (admin) which clears the cache for the calling user.

#### Antigravity Claude is hallucinating field names

The most common cause is that you didn't put the relevant spec section into context. Open the spec in a side tab via `@docs/05-BACKEND-SCHEMA.md` syntax in the chat, or paste the exact section into the prompt. Don't trust Claude's memory of schema details across sessions — re-anchor every sprint.

#### "Type 'Database' is missing the following properties..."

Kysely types are out of date with the schema. Regenerate:

```bash
cd apps/api
pnpm kysely-codegen --url "$DATABASE_URL" --out-file ../../packages/shared/src/db.types.ts
```

Run after every migration.

---

## APPENDIX A — READING ORDER PER SPRINT

For each sprint, the documents you must have open in Antigravity split view before you start prompting.

| Sprint | Primary | Secondary | Audit/Fix |
|---|---|---|---|
| 0 | 02-TRD §3, 10-INFRA §2 | 06-IMPL §3, 03-UIUX §1–§2 | 14-AUDIT, FIX-V2 |
| 1 | 04-APPFLOW §1–§3 | 07-API §1, 08-AUTH-MATRIX | FIX-V2 §H-04, §M-02 |
| 2 | 05-SCHEMA (entire) | 07-API §2–§4, 02-TRD §7–§8 | FIX-V2 §C-02, §C-04, §H-02 |
| 3 | 04-APPFLOW §4 | 07-API §5–§6, 03-UIUX §4 | FIX-V2 §H-01 |
| 4 | 04-APPFLOW §5 | 07-API §7, 03-UIUX §5 | — |
| 5 | 04-APPFLOW §6 | 07-API §8, 03-UIUX §6 | FIX-V2 §H-03, §H-06 |
| 6 | 04-APPFLOW §7 | 07-API §9, 03-UIUX §7 | FIX-V2 §H-02 |
| 7 | 04-APPFLOW §8 | 07-API §10, 03-UIUX §8 | — |
| 8 | 04-APPFLOW §9 | 07-API §11, 02-TRD §10, 11-INTEGRATIONS §1 | FIX-V2 §C-01, §H-01 |
| 9 | 04-APPFLOW §9.5, §10, §11 | 07-API §11.5–§13 | FIX-V2 §M-05, §M-08 |
| 10 | 04-APPFLOW §12–§13 | 07-API §14–§15, 02-TRD §7 | FIX-V2 §H-05, CRITICAL-PATCHES §C-05 |
| 11 | 04-APPFLOW §14–§15 | 07-API §16–§17, 03-UIUX §14–§15 | FIX-V2 §M-01 |
| 12 | 04-APPFLOW §16–§18 | 07-API §18–§20 | CRITICAL-PATCHES §C-06, FIX-V2 §M-05, §M-07, §M-09 |
| 13 | 12-TESTING (entire), 13-NFRS | 06-IMPL §16 | CRITICAL-PATCHES §H-07, §H-08, §H-09 |

---

## APPENDIX B — UNIVERSAL PROMPT TEMPLATE

This is the template for every prompt you give Claude inside Antigravity. Copy, fill in, paste.

```
WHERE WE ARE
[One paragraph: which sprint, what's done, what's the current task.]

WHAT TO BUILD
[Numbered list of concrete deliverables. Reference exact files. Reference exact spec sections.]

1. [File path] — [what it does, what it depends on]
2. [File path] — [...]
...

RULES
[Bullets of constraints. Examples:
- Every write goes through AuditService.log.
- Use the BaseService.optimisticUpdate utility for any versioned UPDATE.
- No new dependencies without asking me first.
- Verify before moving on: after the first file, show it to me. I'll review and say "go" before you continue.]

[Optional: REFERENCES — paste exact spec text if it's short and central]
```

Notes on use:

- The `WHERE WE ARE` block is short — 2–4 sentences — and lets Claude orient without re-reading every prior message.
- The `WHAT TO BUILD` block is numbered. Numbered lists keep Claude from drifting.
- The `RULES` block includes the "Verify before moving on" sentence on every prompt. It's the most important sentence in your toolkit.
- If Claude's output is wrong or off, the next prompt starts with: "Stop. Re-read [section]. The issue is: [exact thing wrong]. Fix it without changing [the part that's right]."

---

## APPENDIX C — ANTIGRAVITY VS CLAUDE CODE: TOOL CHOICE BY TASK

Both tools sit in front of the same Claude Sonnet 4.6 model. They differ in *how* they let you and the model touch your code.

| Task | Tool | Why |
|---|---|---|
| Scaffolding files, writing new modules | **Antigravity** (chat with file actions) | Native multi-file edits, inline diff preview, accept-per-file or accept-all flow |
| Cross-cutting refactor across 20+ files | **Claude Code CLI** (`claude` from terminal) | Faster on large batches; you can pipe its output and review with `git diff` |
| Quick one-off question about a snippet | **Antigravity** (chat) | Lowest friction; paste snippet, ask, paste fix back |
| Long debugging session | **Antigravity** (chat with terminal pinned) | Run + edit + iterate in one window |
| Auto-fixing CI failures | **Claude Code GitHub Action** | Runs the model against your PR; opens a fix-up commit |
| Reviewing a PR | **Claude Code CLI** with `--prompt 'review for race conditions, ownership leaks, ...'` | Headless review; output goes into PR comment |
| Updating spec docs | **Antigravity** (markdown editor + chat) | Markdown preview + chat in one window |
| Generating tests for an existing service | Either works. Antigravity slightly faster for first-pass test scaffolds; Claude Code better for batch (`claude "write vitest for every file in src/services"`) |

When you're inside Antigravity and want to run Claude Code on a specific command, open the integrated terminal (Ctrl+`) and run `claude` from there. Authenticates against the same Anthropic account; uses the same model selection.

---

## END OF GUIDE

When you've shipped Sprint 13, the Scaly Business Portal is live. Every spec doc has earned its place. Every audit finding has been addressed in code, in test, or in documented acceptance.

The path from here:

- Phase 2 — Mobile (React Native + Expo) — separate plan, separate sprints, same monorepo.
- Phase 3 — Operations refinements (per-client slot count UI polish, advanced bot tools, full-text search via Postgres FTS replacing M-05's ILIKE approach).
- Phase 4 — Multi-tenant if Skaly Group expands beyond one workspace.

Until then — boil the ocean. Do it right. Do it with tests. Do it with documentation. The standard is "holy shit, that's done."

Mohammed — when Sprint 13's last commit pushes and `https://portal.skaly.in` loads on a teammate's screen for the first time, you'll know the spec docs, the audit, this guide, and 14 weeks of focused work all earned their keep.

Go build.
