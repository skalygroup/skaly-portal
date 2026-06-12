# SCALY BUSINESS PORTAL — COMPLETE MASTER BUILD GUIDE
## Starting From Zero: No Code, No Accounts, No Git, Nothing
**Written for Mohammed Arslaan — Plain English, Every Step**

---

## BEFORE YOU READ ANYTHING ELSE — UNDERSTAND THIS

You currently have:
- ✅ 14 specification documents (your blueprint)
- ✅ A plan for what to build
- ❌ No code
- ❌ No accounts set up
- ❌ No tools installed
- ❌ No project folder

This guide takes you from that zero state to a working project that you can hand to Claude Code (in Antigravity) and have it build the application sprint by sprint.

**The honest picture of what you're doing:**

You are the architect. Claude Code is the construction crew. Your 13 spec documents are the architectural drawings. This guide is the foreman's job sheet — the step-by-step order in which everything gets done, who does what, and exactly how to talk to Claude Code at each stage.

**What "vibe coding" actually means in practice:**

You open Claude Code, you paste a prompt describing exactly what to build, Claude Code writes the code. You review it, test it in the browser, and if it looks right you move on. If it doesn't look right, you paste another prompt to fix it. You never need to read or understand the TypeScript code itself — you just need to know what you're asking for and how to verify it worked.

---

## PART 1 — UNDERSTANDING YOUR TOOL: CLAUDE CODE IN ANTIGRAVITY

### What is Antigravity?

Antigravity is a desktop application that lets you run Claude Code — Anthropic's AI coding assistant — on your own computer. It's different from Claude's normal chat (what you're using right now) in one critical way:

**Normal Claude chat:** You have a conversation. Claude answers questions and writes text.

**Claude Code in Antigravity:** Claude can directly read and write files on your computer. It can create folders, write code files, run commands in your terminal, and build entire applications. It works inside your actual project.

Think of it this way:
- Claude chat = asking an architect to describe a building
- Claude Code = having a construction crew in your office who can actually lay the bricks

### Installing Antigravity and Claude Code

**Step 1:** Go to antigravity.ai and download the application for your operating system (Mac or Windows).

**Step 2:** Install it like any normal application.

**Step 3:** When you open it, you'll be asked to connect your Anthropic account (the same account you use for Claude chat). Do that.

**Step 4:** Claude Code will now be available inside Antigravity. When you open a project folder, Claude Code can see all the files in it and write new ones.

### How Claude Code Works — The Mental Model

Imagine you have a very skilled developer sitting next to you. You describe what you want: "Create a login page with email and password fields, a gold button, and dark background using our design system." The developer opens the right files, writes the code, and shows you the result.

That's Claude Code. You describe. It creates.

**The key rule:** The better you describe, the better the result. Your 13 spec documents contain everything Claude Code needs to build each feature correctly — you just need to know how to point it at the right part of those documents in each prompt.

---

## PART 2 — THE TOOLS YOU NEED INSTALLED BEFORE ANYTHING ELSE

These are programs that need to be on your computer. Some of them run in the background and you'll never directly use them — they're infrastructure that your project needs.

### Tool 1: Node.js (Required — Your Backend Runs on This)

**What it is:** Node.js is the engine that runs your backend code. Think of it like the electricity supply for the building — you need it but you don't interact with it directly.

**Install:**
1. Go to nodejs.org
2. Download the version that says "LTS" (Long Term Support) — currently version 20
3. Run the installer, click through all the defaults

**Verify it worked:** Open your terminal (on Mac: press Command+Space, type "Terminal", press Enter. On Windows: press Windows key, type "cmd", press Enter) and type:
```
node --version
```
You should see something like `v20.11.0`. Any number starting with 20 is correct.

### Tool 2: pnpm (Required — Manages Your Project's Dependencies)

**What it is:** pnpm is a package manager. Your project will use hundreds of existing code libraries that other developers wrote. pnpm downloads, installs, and manages those libraries for you.

**Why pnpm and not npm?** Your spec documents specifically use pnpm. It's faster and handles the "monorepo" structure your project uses (one project folder with multiple sub-projects inside it).

**Install:** In your terminal, type exactly:
```
npm install -g pnpm@9
```
Press Enter. Wait for it to finish.

**Verify it worked:**
```
pnpm --version
```
You should see `9.x.x`.

### Tool 3: Docker Desktop (Required — Runs Your Local Database)

**What it is:** Docker runs a small "virtual computer" on your machine that hosts your local database (PostgreSQL) and cache (Redis). When you're developing, you need a database to store data. Docker gives you one that exactly matches production.

**Install:**
1. Go to docker.com/products/docker-desktop
2. Download Docker Desktop for your OS
3. Install it (you'll need to restart your computer)

**Verify it worked:** After restart, look for the Docker whale icon in your taskbar/menu bar. It should say "Docker Desktop is running."

### Tool 4: Git (Required — Version Control)

**What it is:** Git tracks every change ever made to your code. If something breaks, you can go back to when it worked. It's also how you connect your local project to GitHub.

**Install:**
1. Go to git-scm.com/downloads
2. Download for your OS
3. Install with all defaults

**Verify it worked:**
```
git --version
```
Should show a version number.

### Tool 5: Visual Studio Code (Helpful — Code Viewer)

**What it is:** Even though Claude Code writes your code, you'll sometimes want to look at it. VS Code is the most popular code viewer/editor in the world.

**Install:**
1. Go to code.visualstudio.com
2. Download and install

You won't be writing code in here — just reviewing what Claude Code wrote.

---

## PART 3 — CREATING YOUR ACCOUNTS (ALL FREE TO START)

You need accounts on 6 services. None require a credit card to start (you only pay when you go to production and have real usage). Go through these one by one.

### Account 1: GitHub (Where Your Code Lives)

**What it is:** GitHub stores your code online. Think of it as Google Drive but specifically for code. Every time you make a change to your project, GitHub saves a copy.

**Why you need it:**
- Vercel (your frontend host) watches GitHub and automatically deploys every time you push new code
- If your computer dies, your code is safe on GitHub
- Claude Code needs a GitHub repository to push code into

**Create account:**
1. Go to github.com
2. Click "Sign up"
3. Use a professional email (your Skaly Group email)
4. Verify your email

**Create your repository:**
1. After logging in, click the "+" button top right
2. Click "New repository"
3. Name it: `skaly-portal`
4. Set it to **Private** (this is an internal business tool — keep it private)
5. Check "Add a README file" (tick this box)
6. Click "Create repository"

You now have a home for your code.

### Account 2: Vercel (Where Your Frontend Runs)

**What it is:** Vercel hosts your frontend — the actual website users open in their browser at portal.skaly.in.

**Why Vercel and not something else:** Your spec specifically uses Next.js 15, and Vercel is built by the same team that makes Next.js. It's the best possible hosting for it. Your site goes live in seconds when you push code to GitHub.

**Create account:**
1. Go to vercel.com
2. Click "Sign Up"
3. Choose "Continue with GitHub" — this connects Vercel directly to your GitHub account
4. Follow the authorization steps

**Connect your repository:**
1. On the Vercel dashboard, click "Add New Project"
2. You'll see your `skaly-portal` repository listed — click "Import"
3. For now, just click "Deploy" without changing anything (it will fail with an error, that's fine — we haven't built anything yet, we just need the project connected)

### Account 3: Railway (Where Your Backend and Database Run)

**What it is:** Railway hosts your backend server (the API) and your PostgreSQL database. Both run here.

**Why Railway:** It handles PostgreSQL databases natively, has a simple pricing model, and supports the automated cron jobs your rollover system needs.

**Create account:**
1. Go to railway.app
2. Click "Login" then "Login with GitHub"
3. Authorize the connection

**Create your project:**
1. Click "New Project"
2. Click "Empty Project"
3. Name it: `skaly-portal`
4. You'll add the actual services (database, backend) during Sprint 0 — just create the project container for now

### Account 4: Supabase (Authentication Only)

**What it is:** Supabase manages user authentication — logging in, signing up, MFA. Your spec uses it ONLY for auth (not for storing any operational data, which goes in Railway's PostgreSQL).

**Create account:**
1. Go to supabase.com
2. Click "Start your project"
3. Sign in with GitHub

**Create your project:**
1. Click "New project"
2. Organization: create one called "Skaly Group"
3. Name: `skaly-portal`
4. Database password: generate a strong one (click the "Generate a password" button) — SAVE THIS PASSWORD somewhere safe, you'll never see it again
5. Region: pick the one closest to Hyderabad (Singapore or Mumbai if available)
6. Pricing plan: Free tier is fine to start
7. Click "Create new project" — it takes about 2 minutes to provision

**Enable the auth features you need:**
1. In the left sidebar, click "Authentication"
2. Click "Providers"
3. Make sure "Email" is enabled (it is by default)
4. Enable "Google" — you'll need a Google OAuth Client ID (covered in the Supabase + Google setup section below)
5. In Authentication → Settings, scroll to "Multi-Factor Authentication" — enable "TOTP"

### Account 5: Upstash (Redis Cache)

**What it is:** Upstash provides Redis — a fast in-memory cache. Your portal uses it to store bot conversation history, track who's online, and speed up permission checks.

**Create account:**
1. Go to upstash.com
2. Click "Start for free" — sign in with GitHub

**Create your database:**
1. Click "Create Database"
2. Name: `skaly-portal-prod`
3. Type: Regional
4. Region: pick closest to your Railway database (same region as your Railway project)
5. Enable "TLS" (for security)
6. Click "Create"

Copy the "REDIS_URL" value from the connection details — you'll need this later.

**Create a second database for staging:**
1. Same steps, name it `skaly-portal-staging`

### Account 6: Cloudflare (File Storage)

**What it is:** Cloudflare R2 stores files — task attachments, staff CVs, generated PDF reports, and database backups.

**Create account:**
1. Go to cloudflare.com
2. Click "Sign up" — use your Skaly Group email

**Enable R2:**
1. In the Cloudflare dashboard, look for "R2 Object Storage" in the left menu
2. Click it and then "Create bucket"
3. Name: `skaly-portal-prod`
4. Keep default settings
5. Click "Create bucket"

Create a second bucket:
1. Name: `skaly-portal-staging`

**Get your API credentials:**
1. Go to "R2 Object Storage" → "Manage R2 API Tokens"
2. Click "Create API Token"
3. Name it: `skaly-portal-api`
4. Permissions: "Object Read & Write"
5. Copy the Access Key ID and Secret Access Key — save them somewhere safe

---

## PART 4 — SETTING UP YOUR LOCAL COMPUTER (YOUR WORKSPACE)

### Creating Your Project Folder

**Step 1:** Decide where on your computer you keep projects. A good place is inside your Documents folder.

**Step 2:** Open your terminal and run:
```
cd ~/Documents
mkdir skaly-portal
cd skaly-portal
```

You've created a folder called `skaly-portal` inside your Documents folder and moved into it.

**Step 3:** Clone (download) your GitHub repository into this folder:
```
git clone https://github.com/YOUR-GITHUB-USERNAME/skaly-portal.git .
```
Replace `YOUR-GITHUB-USERNAME` with your actual GitHub username. The dot at the end means "put it in the current folder."

**Step 4:** Open this folder in VS Code:
```
code .
```

You should now see the VS Code window open with your (empty) project folder.

### Saving Your 14 Spec Documents

**Step 1:** Inside your project folder, create a `docs` folder:
```
mkdir docs
```

**Step 2:** Copy all 14 of your `.md` spec documents into this `docs` folder. These are your reference — Claude Code will need to read them.

### Starting Docker Desktop

Open Docker Desktop from your Applications/Start menu. Wait until it says "Docker Desktop is Running" (the whale icon in your taskbar turns steady, not animated).

---

## PART 5 — UNDERSTANDING THE PROJECT STRUCTURE YOU'RE BUILDING

Before you ask Claude Code to build anything, you need to understand what it's building. Here's the whole picture in plain English:

```
skaly-portal/              ← Your whole project lives here
│
├── apps/
│   ├── web/               ← The website (what users see in their browser)
│   │   └── ...            ← Next.js frontend code
│   │
│   └── api/               ← The backend server (handles data, auth, AI bot)
│       └── ...            ← Fastify backend code
│
├── packages/
│   └── shared/            ← Code shared between frontend and backend
│                          ← (like data type definitions)
│
├── database/
│   ├── migrations/        ← Files that create your database tables
│   └── seeds/             ← Files that add test data
│
├── docs/                  ← Your 14 spec documents (put them here)
│
├── docker-compose.yml     ← Runs your local database and Redis
│
└── README.md              ← Setup instructions
```

**Why is it split this way?**

The `apps/web` and `apps/api` are two separate programs that talk to each other. The frontend (web) is what you see in your browser. The backend (api) handles all the data, checks who's logged in, talks to the database, runs the AI bot. They communicate over the internet using API calls (requests and responses).

This structure is called a "monorepo" — one repository containing multiple sub-projects. The `packages/shared` folder contains code that both sub-projects can use without duplicating it.

---

## PART 6 — HOW TO USE CLAUDE CODE FOR THIS PROJECT

### Opening Claude Code in Antigravity

**Step 1:** Open the Antigravity application

**Step 2:** Click "Open Project" or "Open Folder" and navigate to your `skaly-portal` folder

**Step 3:** Claude Code now has access to all files in your project — including your spec documents in the `docs` folder

### The Golden Rule of Prompting Claude Code

**Every prompt you give Claude Code should do three things:**

1. **Tell it where to work** — which file or folder
2. **Tell it what to build** — the exact feature or fix
3. **Tell it the rules it must follow** — point to your spec documents

**Example of a bad prompt:**
> "Build the login page"

**Example of a good prompt:**
> "Read `docs/03-UIUX.md` Section 2.1 for the exact color variables and `docs/04-APPFLOW.md` Section 2.1 for the login flow. Then build the `/login` page at `apps/web/app/(auth)/login/page.tsx`. It needs: email and password inputs, a 'Sign in' button in gold (#FDC257), 'Continue with Google' button, a link to '/signup', and dark background (#0D0D0F). Use the CSS variables from globals.css. Use shadcn/ui Input and Button components."

The second prompt will produce a correct result. The first will produce something generic that doesn't match your design system.

### The Verify-Before-Moving-On Rule

After Claude Code creates or changes anything, you must verify it worked before moving to the next task. How to verify:

**For code that creates files:** Ask Claude Code "Show me the file you just created at [path]"

**For code that creates a page:** Run the development server (Claude Code can do this for you) and open the URL in your browser

**For database changes:** Ask Claude Code "Run this migration and show me the output"

**For backend endpoints:** Ask Claude Code "Test this endpoint and show me the response"

Never stack 5 unverified tasks on top of each other. Build one thing, verify it, then build the next thing.

---

## PART 7 — SPRINT 0: THE EXACT PROMPTS, IN ORDER

Sprint 0 is not about building features. It's about setting up the project skeleton so that every developer (or Claude Code prompt) that comes after it has a solid foundation. Every prompt below should be given to Claude Code in Antigravity, in this exact order.

---

### SPRINT 0, STEP 1 — Create the Monorepo Structure

**What this does:** Creates all the empty folders and configuration files that tell pnpm "this is a monorepo with multiple sub-projects inside."

**Give this prompt to Claude Code:**

> "I'm building the Scaly Business Portal — an internal operations platform. Read `docs/02-TRD.md` Section 3 for the exact folder structure required.
>
> Create the complete monorepo structure at the root of this project:
>
> 1. Create `pnpm-workspace.yaml` file that declares these workspaces: `apps/*`, `packages/*`
>
> 2. Create `package.json` at the root with: name `skaly-portal`, private `true`, engines requiring node 20+, and scripts: `dev` (runs both apps), `build` (builds both apps), `test` (runs all tests)
>
> 3. Create these empty folders with a `.gitkeep` file in each: `apps/web`, `apps/api`, `apps/mobile`, `packages/shared`, `packages/config`, `database/migrations`, `database/seeds`
>
> 4. Create `docker-compose.yml` at the root — exactly as specified in `docs/10-INFRA-DEPLOYMENT.md` Section 2 Local Dev Docker Compose. It must run PostgreSQL 16 on port 5432 and Redis 7 on port 6379.
>
> 5. Create `.gitignore` at the root that ignores: `node_modules`, `.env`, `.env.local`, `dist`, `.next`, `*.log`
>
> Do not create any application code yet — just the skeleton structure."

**Verify it worked:** In VS Code, you should now see all these folders in the file tree on the left side.

---

### SPRINT 0, STEP 2 — Create the TypeScript Configuration

**What this does:** TypeScript is a version of JavaScript with rules that catch mistakes before they happen. This step sets up those rules consistently across all sub-projects.

**Give this prompt to Claude Code:**

> "Create TypeScript configuration for the monorepo. Read `docs/02-TRD.md` Section 2.1 and 2.2 for the tech stack.
>
> 1. Create `packages/config/tsconfig.base.json` — a base TypeScript config that all sub-projects extend. Use strict mode, target ES2022, module ESNext.
>
> 2. Create `packages/config/package.json` with name `@skaly/config`
>
> 3. Create `apps/web/tsconfig.json` that extends `@skaly/config/tsconfig.base.json` and adds Next.js specific settings
>
> 4. Create `apps/api/tsconfig.json` that extends `@skaly/config/tsconfig.base.json` and adds Node.js specific settings (lib: `['ES2022']`, types: `['node']`)
>
> 5. Create `packages/shared/tsconfig.json` that extends the base config
>
> 6. Create `packages/shared/package.json` with name `@skaly/shared`"

---

### SPRINT 0, STEP 3 — Create the Next.js Frontend Application

**What this does:** Creates the actual Next.js 15 application — the code that runs in users' browsers.

**Give this prompt to Claude Code:**

> "Read `docs/02-TRD.md` Section 2.1 for the exact package versions and `docs/03-UIUX.md` Section 2.1 for the CSS variables.
>
> Create the Next.js 15 frontend application at `apps/web/`:
>
> 1. Initialize a Next.js 15 app with TypeScript, App Router, Tailwind CSS 4, and src directory disabled (files directly in `app/`)
>
> 2. Create `apps/web/package.json` with all frontend dependencies from `docs/02-TRD.md` Section 2.1 table — Next.js 15, Tailwind 4, shadcn/ui, Framer Motion 11, TanStack Query v5, TanStack Table v8, TanStack Virtual v3, Zustand 5, Zod, date-fns, cmdk, socket.io-client v4, DOMPurify
>
> 3. Create `apps/web/app/layout.tsx` — the root layout. It must:
>    - Load all three fonts from `next/font/google`: Big_Shoulders_Display (weights 400, 600, 700), DM_Sans (weights 400, 500, 600), DM_Mono (weights 400, 500) — exactly as shown in docs/02-TRD.md Section 2.5
>    - Apply font CSS variables to the html element: `--font-display`, `--font-body`, `--font-mono`
>
> 4. Create `apps/web/app/globals.css` — paste in ALL CSS variables from `docs/03-UIUX.md` Section 2.1 exactly as written. Every variable from `--bg-base` through the end of the section. Also configure Tailwind 4's `@theme` directive with these variables.
>
> 5. Create this exact folder structure under `apps/web/app/`:
>    - `(auth)/login/page.tsx` — placeholder that says 'Login page'
>    - `(auth)/signup/page.tsx` — placeholder that says 'Signup page'
>    - `(auth)/mfa-setup/page.tsx` — placeholder
>    - `(portal)/home/page.tsx` — placeholder that says 'Home'
>    - `(portal)/attendance/page.tsx` — placeholder
>    - `(portal)/tasks/page.tsx` — placeholder
>    - `(portal)/shoot-planner/page.tsx` — placeholder
>    - `(portal)/content-dropper/page.tsx` — placeholder
>    - `(portal)/content-calendar/page.tsx` — placeholder
>    - `(portal)/bot/page.tsx` — placeholder
>    - `(portal)/chat/page.tsx` — placeholder
>    - `(portal)/dashboard/page.tsx` — placeholder
>    - `(portal)/settings/page.tsx` — placeholder
>
> 6. Create `apps/web/.env.example` with these variable names (no values): NEXT_PUBLIC_API_URL, NEXT_PUBLIC_WS_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY"

**Verify it worked:**
```
cd apps/web
pnpm install
pnpm dev
```
Open `http://localhost:3000` in your browser. You should see a page (probably blank or showing 'Login page'). The three fonts should be loaded — you can verify in the browser's developer tools under the Network tab.

---

### SPRINT 0, STEP 4 — Create the Fastify Backend Application

**What this does:** Creates the backend server skeleton — the API that your frontend will talk to.

**Give this prompt to Claude Code:**

> "Read `docs/02-TRD.md` Section 2.2 for the exact backend packages and Section 5.1 for the Fastify plugin architecture.
>
> Create the Fastify 5 backend application at `apps/api/`:
>
> 1. Create `apps/api/package.json` with all backend dependencies from `docs/02-TRD.md` Section 2.2 table — Fastify 5, Kysely, socket.io v4, @socket.io/redis-adapter, @anthropic-ai/sdk, @aws-sdk/client-s3, ioredis, zod, pino, @fastify/rate-limit, @fastify/helmet, @fastify/cors, @fastify/multipart. Also add devDependencies: typescript, tsx, vitest, @types/node.
>
> 2. Create `apps/api/src/server.ts` — the main Fastify server file. It must:
>    - Create a Fastify instance with Pino logging
>    - Register @fastify/helmet, @fastify/cors (allowed origins: portal.skaly.in and localhost:3000 only), @fastify/rate-limit
>    - Register a Socket.io server attached to the Fastify HTTP server
>    - Configure @socket.io/redis-adapter exactly as shown in `docs/02-TRD.md` Section 8
>    - Register a placeholder route GET /v1/health that returns `{ status: 'ok', timestamp: new Date().toISOString() }`
>    - Start the server on PORT from env vars (default 3001)
>    - Export the Fastify instance
>
> 3. Create `apps/api/src/db.ts` — Kysely database setup. Connect to DATABASE_URL env var. Pool settings: min 2, max 20. Export the `db` instance.
>
> 4. Create `apps/api/src/redis.ts` — ioredis setup. Connect to REDIS_URL env var. Enable TLS. Export the `redis` instance.
>
> 5. Create this folder structure under `apps/api/src/`:
>    - `routes/` — empty folder
>    - `services/` — empty folder
>    - `middleware/` — empty folder
>    - `bot/` — empty folder
>    - `jobs/` — empty folder
>    - `events/` — empty folder
>    - `lib/` — empty folder
>
> 6. Create `apps/api/.env.example` with all variable names from `docs/10-INFRA-DEPLOYMENT.md` Section 6 Backend Railway (no values, just names)
>
> 7. Add scripts to `apps/api/package.json`: `dev` (tsx watch src/server.ts), `build` (tsc), `start` (node dist/server.js), `test` (vitest)"

**Verify it worked:**
```
cd apps/api
pnpm install
pnpm dev
```
Open `http://localhost:3001/v1/health`. You should see `{"status":"ok","timestamp":"..."}`.

---

### SPRINT 0, STEP 5 — Create the Database Migration Files

**What this does:** Creates all 26 database migration files. These are the instructions that tell PostgreSQL how to create every table in your database.

**Give this prompt to Claude Code:**

> "Read `docs/05-BACKEND-SCHEMA.md` in full — this contains every table definition you need.
>
> Create Kysely migration files in `database/migrations/`. Each file must have an `up(db)` async function (creates the table) and a `down(db)` async function (drops the table). Use raw SQL via `db.schema.createTable` or `db.executeQuery(sql...)`.
>
> Create these migration files in exact order:
>
> `001_extensions.ts` — enables uuid-ossp, pg_trgm, pg_stat_statements extensions
>
> `002_months.ts` — creates the months table exactly as defined in `docs/05-BACKEND-SCHEMA.md` §3
>
> `003_staff.ts` — creates the staff table with ALL constraints and ALL indexes as defined in §3
>
> `004_user_permissions.ts` — creates user_permissions table as defined in §3
>
> `005_clients.ts` — creates clients table as defined in §3
>
> `006_invite_links.ts` — creates invite_links table as defined in §3
>
> `007_signup_requests.ts` — creates signup_requests table as defined in §3
>
> `008_holidays.ts` — creates holidays table as defined in §4
>
> `009_attendance_logs.ts` — creates attendance_logs table with ALL indexes as defined in §4
>
> `010_tasks.ts` — creates tasks table with search_vector and ALL indexes as defined in §4
>
> `011_task_assignees.ts` — creates task_assignees junction table
>
> `012_task_attachments.ts` — creates task_attachments table
>
> `013_task_time_logs.ts` — creates task_time_logs table
>
> `014_shoot_schedules.ts` — creates shoot_schedules table
>
> `015_content_pipelines.ts` — creates content_pipelines table
>
> `016_content_calendar.ts` — creates content_calendar table with version column for optimistic locking
>
> `017_reports.ts` — creates reports table
>
> `018_messages.ts` — creates messages table with search_vector
>
> `019_message_mentions.ts` — creates message_mentions table
>
> `020_bot_sessions.ts` — creates bot_sessions table
>
> `021_notifications.ts` — creates notifications table with ALL 14 notification types in the type check constraint
>
> `022_comments.ts` — creates comments table
>
> `023_audit_log.ts` — creates audit_log table with the changed_by_source enum
>
> `024_materialised_views.ts` — creates dashboard_org_stats and dashboard_staff_task_stats materialised views with UNIQUE indexes (required for CONCURRENTLY refresh). Run initial REFRESH MATERIALIZED VIEW (non-CONCURRENTLY) at the END of this migration.
>
> `025_search_indexes.ts` — creates all GIN and trigram indexes from `docs/05-BACKEND-SCHEMA.md` §8
>
> `026_database_roles.ts` — CRITICAL SECURITY MIGRATION. This is the last migration and must run after all tables exist. It creates a PostgreSQL role called `skaly_app`, grants SELECT/INSERT/UPDATE on all tables, grants DELETE only on: tasks, task_assignees, task_attachments, task_time_logs, shoot_schedules, content_pipelines, content_calendar, messages, message_mentions, comments, notifications, invite_links. Then REVOKE UPDATE AND DELETE on audit_log. This enforces the append-only audit log at the database level.
>
> Also create a migration runner script at `apps/api/package.json` script: `db:migrate` — runs all pending migrations using Kysely's migration runner.
>
> Also create `database/seeds/001_system_actor.ts` — inserts the system actor row into staff table with id `00000000-0000-0000-0000-000000000000`, name 'System', role 'admin', active true, as defined in `docs/05-BACKEND-SCHEMA.md` §9."

---

### SPRINT 0, STEP 6 — Set Up Your Environment Variables

**What this does:** Creates the `.env` files with your actual account credentials from the services you set up in Part 3.

**This is NOT a Claude Code prompt — you do this manually.**

**Step 1:** In `apps/api/`, copy the example file:
```
cp apps/api/.env.example apps/api/.env
```

**Step 2:** Open `apps/api/.env` in VS Code and fill in these values (you collected these in Part 3):

```
NODE_ENV=development
PORT=3001
TZ=Asia/Kolkata

# Get this from Railway PostgreSQL → Connect tab
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/skaly_dev

# Get this from Upstash Redis dashboard → Connect → ioredis
REDIS_URL=rediss://default:yourpassword@your-upstash-url.upstash.io:6379

# Get these from your Supabase project → Settings → API
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_JWT_SECRET=your-jwt-secret-from-supabase
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Get from Anthropic console → API Keys
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL_PROD=claude-sonnet-4-6
ANTHROPIC_MODEL_DEV=claude-haiku-4-5-20251001

# Get from Cloudflare R2 → your bucket → API credentials
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET_NAME=skaly-portal-staging

# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CRON_SECRET=generate-a-32-character-random-string-here
```

**Step 3:** In `apps/web/`, copy and fill:
```
cp apps/web/.env.example apps/web/.env.local
```

Fill in:
```
NEXT_PUBLIC_API_URL=http://localhost:3001/v1
NEXT_PUBLIC_WS_URL=ws://localhost:3001
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-from-supabase
```

**Important:** Never commit `.env` files to GitHub. Your `.gitignore` already prevents this.

---

### SPRINT 0, STEP 7 — Run Docker and Apply Migrations

**Step 1:** Start your local database:
```
docker compose up -d
```
Wait 10-15 seconds for it to start.

**Step 2:** Update your DATABASE_URL in `apps/api/.env` for local dev:
```
DATABASE_URL=postgresql://skaly:localdev@localhost:5432/skaly_dev
```
(These match the docker-compose.yml that was created in Step 1)

**Step 3:** Run the migrations:
```
pnpm --filter api db:migrate
```
You should see output like:
```
Migration 001_extensions applied
Migration 002_months applied
...
Migration 026_database_roles applied
All 26 migrations complete
```

**Step 4:** Run the system actor seed:
```
pnpm --filter api db:seed
```

---

### SPRINT 0, STEP 8 — Create the Security Plugins

These are the two security files from the audit that must exist before Sprint 1.

**Give this prompt to Claude Code:**

> "Read `docs/14-PRE-BUILD-AUDIT.md` Section B-03 and C-05 for exact requirements.
>
> Create two security plugin files:
>
> **File 1:** `apps/api/src/middleware/internalAuth.plugin.ts`
>
> This Fastify plugin authenticates requests to `/v1/internal/*` routes (used by the cron job for rollover). It must:
> - Read the `x-internal-secret` header from the request (lowercase)
> - Compare it to `process.env.CRON_SECRET` using `crypto.timingSafeEqual` from Node's built-in `crypto` module — NOT a regular `===` comparison (this is required for security — prevents timing attacks)
> - Before calling timingSafeEqual, check that both strings have the same length — if they don't, wait 50ms and return 401 (prevents length-based attacks too)
> - If the secret is valid: allow the request to continue
> - If invalid or missing: return 401 with `{ error: { code: 'UNAUTHORIZED', message: 'Invalid internal secret' } }`
> - Register as a Fastify decorator: `fastify.decorate('verifyInternalSecret', ...)` so routes can use `preHandler: [fastify.verifyInternalSecret]`
> - Include TypeScript declaration so TypeScript knows about `fastify.verifyInternalSecret`
>
> **File 2:** `apps/api/src/plugins/socketTokenWatcher.ts`
>
> This plugin monitors JWT expiry on active WebSocket connections. It must:
> - Export a function `setupSocketTokenWatcher(io: Server)` that takes the Socket.io Server instance
> - On every new socket connection: read `socket.handshake.auth.exp` (JWT expiry as Unix timestamp)
> - If exp is missing or already in the past: disconnect immediately
> - Set a timer to fire 60 seconds BEFORE expiry: emit `auth:refresh_required` to that socket with `{ expiresAt: ISO string of expiry }`
> - Set a second timer to fire 30 seconds AFTER expiry: force-disconnect the socket
> - Listen for `auth:refresh` event from the client with `{ token: string }`: if received before the disconnect timer fires, validate the new token has a future exp, cancel the disconnect timer, update the socket's auth exp, emit `auth:refreshed` back
> - On socket disconnect for any reason: clear both timers (prevents memory leaks)
>
> Register the internalAuth plugin in `apps/api/src/server.ts` and call `setupSocketTokenWatcher(io)` after the Socket.io instance is created."

---

### SPRINT 0, STEP 9 — Create the Development Seed and README

**Give this prompt to Claude Code:**

> "Create two files:
>
> **File 1:** `database/seeds/002_dev_data.ts`
>
> A development-only seed file. First line: `if (process.env.NODE_ENV === 'production') { console.log('Skipping — production'); process.exit(0); }`
>
> Then insert (using Kysely and `onConflict().doNothing()` for idempotency):
>
> 4 staff members: id `11111111-...1` name 'Admin Test' role 'admin' email 'admin@test.skaly.in' active true mfa_enrolled true; id `22222222-...2` name 'Manager Test' role 'manager' email 'manager@test.skaly.in' mfa_enrolled true; id `33333333-...3` name 'Team Test' role 'team_member' email 'team@test.skaly.in' mfa_enrolled false; id `44444444-...4` name 'Freelancer Test' role 'freelancer' email 'freelancer@test.skaly.in' mfa_enrolled false.
>
> 3 clients: id `aaaaaaaa-...a` name 'Naaz Furniture' is_internal false active true shoot_slots_per_month 4 pieces_per_visit 2; id `bbbbbbbb-...b` name 'Hyatt Hotels' shoot_slots_per_month 6 pieces_per_visit 3; id `cccccccc-...c` name 'Lavish Jewellery' shoot_slots_per_month 2 pieces_per_visit 1.
>
> 1 month row: period = current YYYY-MM (calculate with new Date()), label = 'June 2026' (or current month name), locked false.
>
> **File 2:** `README.md` at the project root.
>
> Include: (1) Project name and one-sentence description, (2) numbered local dev setup steps: install tools → docker compose up → copy env files → fill env values → pnpm install → pnpm --filter api db:migrate → pnpm --filter api db:seed → pnpm --filter api db:refresh-views → pnpm dev, (3) test account table showing all 4 test email addresses and password 'Password123!', (4) links to each spec document in the docs/ folder, (5) Architecture section pointing to `docs/02-TRD.md`."

---

### SPRINT 0, STEP 10 — Connect to GitHub

**Step 1:** Add all your files:
```
git add .
git commit -m "Sprint 0: project foundation, migrations, security plugins"
git push origin main
```

**Step 2:** Go to your GitHub repository page and verify you can see all the files there.

**Step 3:** Enable Dependabot on GitHub:
1. Go to your repository → Settings → Security (left menu)
2. Under "Dependabot", enable "Dependabot alerts" and "Dependabot security updates"
3. Click "Save changes"

---

### SPRINT 0, STEP 11 — Connect to Vercel and Railway

**Vercel:**
1. Go to your Vercel project dashboard
2. Click "Settings" → "Environment Variables"
3. Add all the variables from `apps/web/.env.local` (with production values for the Supabase keys)
4. Under "Git" settings, make sure it's connected to your GitHub repository's `main` branch

**Railway:**
1. In your Railway project, click "+ New" → "Database" → "PostgreSQL"
2. After it provisions, go to the database → "Connect" tab → copy the connection URL
3. Click "+ New" again → "Empty Service" — this will be your API server
4. Go to that service → "Variables" → add all the variables from `apps/api/.env` with production values (using the Railway PostgreSQL URL, Upstash production URL, etc.)
5. Go to the Variables tab and add: `TZ=Asia/Kolkata` (critical for rollover timing)

---

### SPRINT 0 CHECKLIST — VERIFY EVERYTHING BEFORE SPRINT 1

Go through this list. Every item must be ✅ before Sprint 1 starts.

```
FOUNDATION
  [ ] docker compose up runs without errors
  [ ] pnpm dev starts both frontend (port 3000) and backend (port 3001)
  [ ] http://localhost:3000 loads without errors in browser
  [ ] http://localhost:3001/v1/health returns {"status":"ok"}
  [ ] All 26 migrations applied (check with: pnpm --filter api db:status)
  [ ] Dev seed data applied (admin@test.skaly.in exists in staff table)

SECURITY
  [ ] Migration 026_database_roles applied — audit log has REVOKE protection
  [ ] internalAuth.plugin.ts exists in apps/api/src/middleware/
  [ ] Plugin uses timingSafeEqual (verify: search the file for 'timingSafeEqual')
  [ ] socketTokenWatcher.ts exists in apps/api/src/plugins/
  [ ] CRON_SECRET is at least 32 characters (generate one if not)

DOCUMENTS
  [ ] All 14 spec docs are in docs/ folder
  [ ] README.md exists at project root
  [ ] .env files are NOT committed to GitHub (check: github.com/your-repo — no .env visible)

EXTERNAL ACCOUNTS
  [ ] GitHub repository exists and has latest code
  [ ] Vercel project connected to GitHub, env vars added
  [ ] Railway project has PostgreSQL + API service, env vars added
  [ ] Supabase project created, email auth + Google OAuth + TOTP enabled
  [ ] Upstash Redis instance created, REDIS_URL copied
  [ ] Cloudflare R2 buckets created (staging + production)
  [ ] GitHub Dependabot enabled

DECISIONS (must be decided before Sprint 1)
  [ ] T1-T4 design templates: received from design lead OR fallback confirmed
  [ ] If fallback: noted in docs/06-IMPLEMENTATION-PLAN.md
  [ ] Bot latency: docs/01-PRD.md §5 updated to say TTFT <2s, full <8s
  [ ] Transactional email policy: "out of scope" row added to docs/01-PRD.md §6
```

---

## PART 8 — THE AUDIT FIXES: WHAT THEY ARE AND WHEN THEY HAPPEN

Now that you understand the full context, here's where every single audit finding lands in the sprint plan. You don't do all of these now — they happen at the right moment during build.

### Already Handled in Sprint 0 (above)
- **B-01** ✅ Migration 026 creates the database role protections
- **B-03** ✅ internalAuth.plugin.ts uses timingSafeEqual
- **C-05** ✅ socketTokenWatcher.ts specifies the token refresh protocol

### Fix as Document Edits (30 minutes total, do now)

These are just text changes to your spec documents. Open each file in VS Code and make these changes:

**C-01 — Fix the bot speed target:**
Open `docs/01-PRD.md`. Find Section 5 (Non-Functional Requirements Summary). Find the row: `| Bot response | < 4s end-to-end including Anthropic API |`. Change it to: `| Bot response | TTFT (first words visible) < 2s; full streaming completion < 8s (see NFR §1.2) |`

**C-02 — Fix the PATCH response standard:**
Open `docs/07-API-CONTRACT.md`. Find Section 1.1 (Standard Response Envelopes). After the existing envelope examples, add: `**PATCH Response Standard:** All PATCH endpoints return the full updated resource including the new version number. Response: `{ "data": { ...full updated row }, "meta": { "updatedAt": "...", "updatedBy": "staffId" } }`. Clients must replace their cached entry entirely with the returned data.`

**C-03 — Document that emails are out of scope:**
Open `docs/01-PRD.md`. Find Section 6 (Out of Scope — MVP). Add this row to the table: `| Transactional email notifications | All operational notifications (task_assigned, signup_approved, report_ready, etc.) are in-app only via Socket.io and the notification bell. Supabase handles auth emails only (invite link, password reset). |`

**C-04 — Add the /staff/me endpoint:**
Open `docs/07-API-CONTRACT.md`. Find Section 4 (Staff Endpoints). After the `GET /v1/staff/:id` entry, add: `**GET /v1/staff/me** — Returns the authenticated user's own profile. Auth: All roles. Response: same shape as GET /v1/staff/:id. No staffId parameter needed — the JWT identifies the user. Add this as a Sprint 1 backend task.`

**C-06 — Add the bootstrap rollover note:**
Open `docs/04-APPFLOW.md`. Find Section 16 (Monthly Rollover Flow), Step 2. Add after the UPDATE statement: `Bootstrap note: if no prior period exists (this is the very first month ever), skip Step 2 entirely. Log: 'Bootstrap rollover — no prior period to lock.' The idempotency check in Step 0 already handles re-runs safely.`

### Fixes That Happen During Their Sprint

| Fix ID | What it is | During Sprint |
|---|---|---|
| H-01 | Holiday removal restores attendance grid | Sprint 3 (Attendance) |
| H-02 | Soft-delete helper function | Sprint 2 (DB Scaffold) |
| H-03 | Dashboard view refresh script | Sprint 0 ✅ (add to seed step) |
| H-04 | Bot streaming reference file | Sprint 8 (AI Bot) |
| H-05 | Comment notification recipients | Sprint 12 (Comments) |
| H-06 | Shoot slot count adjustment method | Sprint 5 (Shoot Planner) |
| H-07 | Sentry error tracking | Sprint 13 (QA/Launch) |
| H-08 | Content Security Policy header | Sprint 13 (QA/Launch) |
| H-09 | DB connection pool monitoring | Sprint 13 (QA/Launch) |
| M-01 | Avatar upload | Sprint 11 (Settings) |
| M-02 | Mobile fallback page | Sprint 0 ✅ (add to layout) |
| M-03 | Accept R2 orphan files as tech debt | No code needed — document only |
| M-05 | Search query strategy | Sprint 9 (Search) |
| M-06 | Rate limit headers | Sprint 2 |
| M-07 | Rollover double-notification test | Sprint 12 |
| M-08 | Bot tool error messages | Sprint 9 |
| M-10 | Dev seed data | Sprint 0 ✅ (Step 9 above) |
| M-11 | README | Sprint 0 ✅ (Step 9 above) |
| M-12 | Swagger API docs | Sprint 2 |
| L-09 | GitHub Dependabot | Sprint 0 ✅ (Step 10 above) |

---

## PART 9 — HOW TO RUN EACH SPRINT WITH CLAUDE CODE

This is the pattern you repeat for every sprint.

### Before Each Sprint Starts

**Step 1:** Read that sprint's section in `docs/06-IMPLEMENTATION-PLAN.md` to understand what needs to be built.

**Step 2:** Read the relevant spec documents for that sprint. For example, Sprint 3 (Attendance) means reading: `docs/04-APPFLOW.md` Section 3 (Attendance Flow), `docs/05-BACKEND-SCHEMA.md` Section 4 (attendance_logs table), `docs/07-API-CONTRACT.md` Attendance endpoints, `docs/08-AUTH-MATRIX.md` Attendance section.

**Step 3:** Tell Claude Code to read those same documents at the start of your session.

### The Prompt Pattern for Every Sprint

Use this structure for every feature prompt:

```
"Read these spec documents first:
- docs/[relevant doc] for [specific section]
- docs/[relevant doc] for [specific section]

Then build [exactly what you're building]:
[Specific file paths]
[Specific behavior]
[Specific rules from the spec]

Rules that always apply:
- Use the CSS variables from docs/03-UIUX.md — never hardcode colors
- All API errors follow the shape in docs/09-ERROR-HANDLING.md Section 1
- Auth checking follows docs/08-AUTH-MATRIX.md — [specific role rule for this feature]
- All database queries on tasks/staff/clients/messages must exclude deleted rows (deleted_at IS NULL)"
```

### After Each Feature is Built

1. Run the development server: `pnpm dev`
2. Test it manually in the browser
3. Ask Claude Code: "Write a test for what you just built and run it — show me the passing output"
4. If anything looks wrong, paste the error back to Claude Code: "This is the error I see: [paste error]. Fix it."
5. When it's working, commit: `git add . && git commit -m "Sprint X: feature description" && git push`

---

## PART 10 — USEFUL COMMANDS REFERENCE

Keep this section handy — these are the commands you'll use repeatedly.

### Starting Your Development Environment

```bash
# Start local database and Redis (run once per session)
docker compose up -d

# Start everything (run in two separate terminal tabs)
pnpm --filter web dev      # Frontend at http://localhost:3000
pnpm --filter api dev      # Backend at http://localhost:3001
```

### Database Commands

```bash
# Apply new migrations
pnpm --filter api db:migrate

# Check what migrations have run
pnpm --filter api db:status

# Run seed data (local dev only)
pnpm --filter api db:seed

# Populate dashboard views (run after first migration)
pnpm --filter api db:refresh-views
```

### Git Commands (After Each Feature)

```bash
# Save your work
git add .
git commit -m "Sprint X: description of what was built"
git push origin main
```

### Running Tests

```bash
# All tests
pnpm test

# Just backend tests
pnpm --filter api test

# Just frontend tests
pnpm --filter web test
```

### Checking Logs

```bash
# Backend logs (if something isn't working)
pnpm --filter api dev

# Docker database logs
docker compose logs postgres
docker compose logs redis
```

---

## PART 11 — WHAT TO DO WHEN THINGS GO WRONG

### Problem: "Cannot find module X" or "Package not found"

**What it means:** A dependency (library) is missing.

**Fix:**
```bash
pnpm install
```
If that doesn't work, ask Claude Code: "I'm getting this error: [paste error]. Which package is missing and how do I install it?"

### Problem: Port already in use

**What it means:** The port (3000 or 3001) is already being used by another process.

**Fix:**
```bash
# On Mac/Linux: kill the process using port 3001
lsof -ti:3001 | xargs kill -9

# On Windows:
netstat -ano | findstr :3001
# Note the PID number, then:
taskkill /PID [number] /F
```

### Problem: Database connection refused

**What it means:** Docker isn't running or your DATABASE_URL is wrong.

**Fix:**
1. Check Docker Desktop is running (whale icon in taskbar is steady)
2. Run `docker compose up -d`
3. Check that `DATABASE_URL` in `apps/api/.env` matches your docker-compose.yml

### Problem: Claude Code builds something that doesn't match your spec

**What to do:**

**Step 1:** Don't panic and don't accept wrong output.

**Step 2:** Paste this to Claude Code:
> "This doesn't match the spec. According to `docs/[specific document]` Section [X], it should [describe what it should do]. What I see instead is [describe the problem]. Fix it to match the spec exactly."

**Step 3:** If Claude Code keeps getting it wrong after 2 attempts, paste the relevant section of the spec document directly into your prompt: "The spec says exactly this: [paste the text]. Build it to match this exactly."

### Problem: A migration fails

**What it means:** There's a SQL error in one of your migration files.

**Fix:**
1. Read the error message — it usually says which line is wrong
2. Paste the full error to Claude Code: "Migration [filename] failed with this error: [paste error]. Fix the migration file."
3. If a partial migration ran, you may need to: `pnpm --filter api db:rollback` to undo the partial run

### Problem: "Something worked yesterday and broke today"

**The most likely cause:** You added a new environment variable to your `.env.example` but forgot to add the actual value to your `.env` file.

**Fix:** Compare `.env.example` to `.env` and find what's missing.

---

## PART 12 — THE FULL SPRINT ORDER AND WHAT TO TELL CLAUDE CODE

This is your complete build roadmap. Each sprint gets one session (or more) with Claude Code.

### Sprint 0 (Week 1) — Foundation
**You've done this in Part 7 above.**
The goal: project structure exists, database runs, security plugins in place, all accounts connected.

### Sprint 1 (Week 2) — Login, Signup, and Authentication
**Read before prompting:** `docs/04-APPFLOW.md` §2 (all auth flows), `docs/08-AUTH-MATRIX.md` §10 (MFA), `docs/07-API-CONTRACT.md` §3 (auth endpoints), `docs/03-UIUX.md` (login/signup screens)

**Key prompt to start Sprint 1:**
> "Read docs/04-APPFLOW.md Section 2 (all auth flows from 2.1 to 2.7) and docs/07-API-CONTRACT.md Section 3 (all auth endpoints). I'm starting Sprint 1 — building authentication.
>
> Build the backend auth first:
> 1. `apps/api/src/plugins/auth.plugin.ts` — verifies Supabase JWT tokens, extracts staffId from Redis cache (key: staff_lookup:{supabaseUid}), attaches request.user = { staffId, role, email, mfaEnrolled }
> 2. `POST /v1/auth/invite` endpoint
> 3. `POST /v1/auth/signup/request` endpoint (with CV upload to R2)
> 4. `GET /v1/settings/signup-requests` endpoint (admin only)
> 5. `POST /v1/auth/signup-requests/:id/approve` endpoint
> 6. `POST /v1/auth/signup-requests/:id/reject` endpoint — CRITICAL: rejection_note must NEVER appear in any response to the user (docs/04-APPFLOW.md §2.6)
> 7. `GET /v1/staff/me` endpoint (returns authenticated user's own profile)
>
> Follow the exact error codes from docs/09-ERROR-HANDLING.md Section 2."

### Sprint 2 (Week 3) — Database Schema + API Scaffold
**Read before prompting:** `docs/05-BACKEND-SCHEMA.md` (all Kysely types), `docs/07-API-CONTRACT.md` §1 (conventions)

**Key things to build:**
- Kysely TypeScript types for all 26 tables (auto-generated from schema)
- RBAC middleware plugin (role checking per route)
- Rate limit headers enabled (`addHeaders` option)
- Swagger UI at `/v1/docs`
- softDelete helper at `apps/api/src/lib/softDelete.ts`

### Sprint 3 (Week 4) — Staff Attendance
**Read before prompting:** `docs/04-APPFLOW.md` §3 (attendance flow), `docs/05-BACKEND-SCHEMA.md` §4 (attendance_logs), `docs/08-AUTH-MATRIX.md` §7 (column ownership)

**Critical rules for this sprint:**
- Team members can ONLY edit their own column — enforced in BOTH frontend (pointer-events:none) AND backend (service-layer check)
- Holiday removal must restore attendance rows (H-01 fix — include this in your prompt)

### Sprint 4 (Week 5) — Tasks
**Read before prompting:** `docs/04-APPFLOW.md` §4 (tasks flow), `docs/07-API-CONTRACT.md` §5 (task endpoints)

### Sprint 5 (Week 6) — Shoot Planner
**Read before prompting:** `docs/04-APPFLOW.md` §5 (shoot planner flow), `docs/08-AUTH-MATRIX.md` §8 (freelancer isolation)

**Get shoot slot counts from operations team before this sprint.**

### Sprint 6 (Week 7) — Content Dropper + Trigger 1
**Read before prompting:** `docs/04-APPFLOW.md` §15 (cross-module triggers)

### Sprint 7 (Week 8) — Content Calendar + Trigger 2
**Read before prompting:** `docs/04-APPFLOW.md` §15 Trigger 2, `docs/02-TRD.md` §4.3 (TanStack Virtual for the 31×N grid)

### Sprint 8 (Week 9) — AI Bot (Query Tools)
**Read before prompting:** `docs/04-APPFLOW.md` §9 (bot flow), `docs/11-THIRD-PARTY-INTEGRATIONS.md` §3 (Anthropic API patterns)

**Before starting this sprint:** Verify Anthropic model strings with `GET https://api.anthropic.com/v1/models` using your API key.

Include the H-04 fix in your first Sprint 8 prompt — ask Claude Code to create `apps/api/src/bot/streamHandler.ts` as the streaming reference implementation.

### Sprint 9 (Week 10) — AI Bot Mutations + Search
**Read before prompting:** `docs/08-AUTH-MATRIX.md` §5 (bot tool permissions), `docs/04-APPFLOW.md` §12 (search flow)

Include the M-05 fix (search query strategy) and M-08 fix (bot tool error messages) in your prompts.

### Sprint 10 (Week 11) — Chat + Notifications
**Read before prompting:** `docs/04-APPFLOW.md` §10 (chat flow) and §11 (notifications flow)

This is when the C-05 client-side socket token refresh gets wired — include it in your chat/socket prompt.

### Sprint 11 (Week 12) — Dashboard + Settings
**Read before prompting:** `docs/04-APPFLOW.md` §14 (settings flows), `docs/13-NFRS.md` §1.1 (dashboard performance targets)

Include M-01 (avatar upload) in this sprint.

### Sprint 12 (Week 13) — Rollover + Reports + Comments
**Read before prompting:** `docs/04-APPFLOW.md` §16 (rollover flow), §13 (comments flow)

Include: H-05 (comment notification recipients), M-07 (rollover double-notification test), M-09 (PDF fonts), the C-06 bootstrap guard for rollover.

### Sprint 13 (Week 14) — QA + Launch
Include: H-07 (Sentry), H-08 (CSP header), H-09 (connection pool monitoring), all Playwright E2E tests, production DNS setup.

---

## PART 13 — GOING LIVE: THE LAUNCH SEQUENCE

When Sprint 13 is done, here's exactly how to make the portal live.

### Step 1: Final Environment Variable Check
Compare every variable in `apps/api/.env` against what's set in Railway. Compare `apps/web/.env.local` against what's in Vercel. Nothing should be missing.

### Step 2: Database Migrations on Production
In Railway, your API service has a way to run commands. Run:
```
pnpm --filter api db:migrate
pnpm --filter api db:seed
pnpm --filter api db:refresh-views
```

### Step 3: DNS Configuration
1. In Cloudflare (your DNS provider): add a CNAME record pointing `portal` to your Vercel URL (e.g., `skaly-portal.vercel.app`)
2. Add another CNAME pointing `api` to your Railway URL
3. In Vercel: add `portal.skaly.in` as a custom domain
4. In Railway: add `api.skaly.in` as a custom domain

### Step 4: Verify SSL
Both `https://portal.skaly.in` and `https://api.skaly.in/v1/health` should work with HTTPS. Vercel and Railway handle SSL certificates automatically.

### Step 5: First Real Data
Following `docs/06-IMPLEMENTATION-PLAN.md` Sprint 13: manually enter your real client roster and team roster through the admin settings panel.

### Step 6: Test the Rollover
Before the first midnight rollover:
1. Go to Settings → Months
2. Click "Manual rollover" for the current month
3. Verify it creates attendance rows, pipeline rows, shoot slots, and calendar cells
4. Check the admin receives the "month_ready" notification

### Step 7: Announce
Send the `portal.skaly.in` URL to your team.

---

## APPENDIX — QUICK REFERENCE FOR CLAUDE CODE SESSIONS

### Starting a New Claude Code Session

Always begin with:
> "I'm building the Scaly Business Portal. My spec documents are in the `docs/` folder of this project. I'm currently on Sprint [X], building [feature]. Read these documents before starting: [list the relevant docs]."

### The "Where Am I" Check

If Claude Code seems confused about your project, paste this:
> "Context check: this is a Next.js 15 frontend (`apps/web/`) talking to a Fastify 5 backend (`apps/api/`). PostgreSQL database via Kysely. Supabase for auth only. Socket.io for real-time. All 14 spec documents are in `docs/`. Currently working on [feature]."

### When Claude Code's Output Looks Wrong

> "This doesn't match my spec. According to `docs/[doc]` Section [X]: [paste the relevant spec text]. Please rebuild this to exactly match what the spec says."

### When You're Not Sure Which File to Change

> "According to my spec at `docs/02-TRD.md` Section 3 (project structure), which file should contain [the thing you're building]? Show me the path and then create it."

---

*This guide covers everything from absolute zero to a live production portal. Work through the parts in order. Sprint 0 is the foundation — do not skip any of its steps. Once Sprint 0 is complete, each subsequent sprint follows the same pattern: read the spec, prompt Claude Code, verify the output, commit.*
