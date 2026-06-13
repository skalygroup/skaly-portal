# SKALY PORTAL — COMPLETE FIX GUIDE V2
## For Mohammed Arslaan — Every Pending Item Solved
**Plain English. No jargon. Exact file paths. Copy-paste prompts.**

---

## FIRST: YOUR QUESTIONS ANSWERED

### "What are these 13 documents and how do they connect to the audit?"

Think of it like building a house. Before any bricks are laid, you need a full set of plans. Your 13 documents ARE those plans:

| Document | What it is in plain English |
|---|---|
| **01-PRD** | What the portal does. Every feature listed. The "what we're building" document. |
| **02-TRD** | Which technologies and tools are used (Next.js, Fastify, etc). The "how we're building it" document. |
| **03-UIUX** | What every screen looks like. Colors, fonts, spacing. The design rulebook. |
| **04-APPFLOW** | Every click, every page transition, every action a user takes. The "journey maps" document. |
| **05-BACKEND-SCHEMA** | The exact shape of the database — every table, every column. The "data blueprint". |
| **06-IMPLEMENTATION-PLAN** | The 14-week sprint plan. Who does what, when. The "project schedule". |
| **07-API-CONTRACT** | Every endpoint the backend exposes. Exactly what the frontend sends and receives. The "communication contract" between frontend and backend. |
| **08-AUTH-MATRIX** | Who is allowed to see and do what. Admin vs Manager vs Team Member vs Freelancer. |
| **09-ERROR-HANDLING** | What message the user sees when things go wrong. Every error, every scenario. |
| **10-INFRA-DEPLOYMENT** | How the app is hosted. Railway, Vercel, environment variables, CI/CD. |
| **11-THIRD-PARTY-INTEGRATIONS** | How the app talks to Supabase, Anthropic, Cloudflare R2, Upstash. |
| **12-TESTING-STRATEGY** | What tests exist, how to run them, what they verify. |
| **13-NFRS** | Performance targets, security rules, browser support, accessibility requirements. |

**Document 14 (the Pre-Build Audit)** is a senior developer reading ALL 13 documents and finding the gaps, contradictions, and missing pieces before any coding starts. It found 39 issues. The previous guide solved some. This guide solves the rest — including all 21 items you said were still pending.

---

## HOW TO USE THIS GUIDE

Every fix below follows the same 4-part structure:

1. **Plain English** — what the problem actually is
2. **Why it matters** — what breaks if you skip it
3. **Exact steps** — numbered, specific, no guessing
4. **Your AI prompt** — paste this exactly into Cursor, GitHub Copilot, or whatever AI coding tool you use. The prompt is written so the AI produces the right output immediately.

---

---

# SECTION A — CRITICAL ITEMS (Must be done in Sprint 0)

---

## C-05 — When a Login Session Expires Mid-Use, WebSockets Break Silently

### Plain English
When someone logs into the portal, they get a login "pass" (called a JWT token) that lasts exactly 1 hour. Your normal web pages already handle this — at the 55-minute mark, they quietly get a fresh pass in the background. 

But there's a different kind of connection called a WebSocket (used for real-time things: chat messages appearing instantly, bot responses streaming, notifications popping up). This connection stays open the whole time someone is using the portal. After 60 minutes, the login pass inside that open connection has expired — but the connection is still alive and nobody knows.

**What breaks if ignored:** After 1 hour of continuous use, chat might silently stop delivering messages. The bot might stop responding. Worse, if someone stole a login token, they could keep using the WebSocket connection past the 1-hour expiry forever.

**The fix:** The server watches each WebSocket connection's token expiry. 60 seconds before it expires, it warns the browser: "your pass expires soon." The browser gets a new pass and sends it back. If the browser doesn't respond in 30 seconds, the server closes the connection. The user reconnects normally (this takes about 1-2 seconds and is invisible).

### Exact Steps

**Step 1:** In your AI coding assistant, open your backend project at `apps/api/src/`

**Step 2:** Ask your AI to create this file (use the prompt below)

**Step 3:** After the file is created, ask your AI to connect it to your main Socket.io server setup (second prompt below)

**Step 4:** In your frontend project at `apps/web/src/lib/`, open your Socket.io client file (or ask AI to find it for you with the third prompt)

**Step 5:** Add the client-side handler (fourth prompt below)

**Step 6:** Open `07-API-CONTRACT.md` and add the two new socket events to Section 6 (WebSocket Events table) — the AI prompt for this is last

---

**🤖 AI PROMPT 1 — Create the server-side token watcher:**
> "In my Fastify + Socket.io backend project at `apps/api/src/plugins/`, create a new file called `socketTokenWatcher.ts`. This plugin monitors JWT expiry for every active WebSocket connection. Here is exactly what it should do:
> 
> When a new socket connects, read the `exp` field from `socket.handshake.auth.exp` (this is a Unix timestamp — seconds since 1970). Calculate how many milliseconds until that token expires.
>
> Set a timer to fire 60 seconds BEFORE the token expires. When that timer fires, emit an event to that specific socket called `auth:refresh_required` with this payload: `{ message: 'Your session expires in 60 seconds', expiresAt: <ISO date string of expiry> }`.
>
> Also set a second timer to fire 30 seconds AFTER the token expires. If that timer fires, disconnect the socket using `socket.disconnect(true)`.
>
> Also listen for an event from the client called `auth:refresh` with payload `{ token: string }`. When this arrives, verify the new token is valid (check it is a non-empty string and has a future `exp` claim). If valid: cancel the disconnect timer, update `socket.handshake.auth.exp` with the new token's expiry, and emit `auth:refreshed` back to the client. If invalid: disconnect the socket.
>
> When the socket disconnects for any reason, clear both timers to prevent memory leaks.
>
> If `socket.handshake.auth.exp` is missing or in the past when the connection is first made, disconnect immediately.
>
> Export this as a default function called `setupSocketTokenWatcher(io: Server)` where `Server` is imported from `socket.io`."

---

**🤖 AI PROMPT 2 — Connect it to your Socket.io server:**
> "In my Fastify API project, find the file where I set up my Socket.io server (it will have `new Server(` or `io.on('connection'` in it). Import my new `setupSocketTokenWatcher` function from `./plugins/socketTokenWatcher` and call it with my `io` instance, right after the io server is created and before any other `io.on('connection')` handlers."

---

**🤖 AI PROMPT 3 — Find and update the frontend Socket.io client:**
> "In my Next.js frontend project at `apps/web/`, find the file where I create and configure my Socket.io client connection (it will have `io(` or `socket.io-client` in it). Show me the file path and its current contents."

---

**🤖 AI PROMPT 4 — Add client-side handler:**
> "In my Socket.io client file (the one you just showed me), after the socket connection is established, add event listeners for these two new server events:
>
> 1. `auth:refresh_required` — when this arrives, immediately call my Supabase refresh session function. The Supabase client is available as `supabase` and the refresh call is `supabase.auth.refreshSession()`. This returns `{ data: { session } }`. If `session?.access_token` exists, emit `auth:refresh` back to the server with payload `{ token: session.access_token }`. If the refresh fails (catch block), log the error to console — the server will automatically disconnect after 30 seconds and the normal reconnect flow will handle re-authentication.
>
> 2. `auth:refreshed` — when this arrives, log to console: `'Socket session extended successfully'`."

---

**🤖 AI PROMPT 5 — Update the spec document:**
> "Open the file `07-API-CONTRACT.md` in my project. Find Section 6 which contains the WebSocket Events table. Add these 3 new rows to the table:
>
> Server → Client events:
> - Event name: `auth:refresh_required` | Room: `user:{staffId}` | Payload: `{ message: string, expiresAt: string }` | Description: JWT expires in 60 seconds — client must refresh token
>
> Client → Server events:
> - Event name: `auth:refresh` | Payload: `{ token: string }` | Description: Client sends fresh JWT after refresh
> - Event name: `auth:refreshed` | Payload: `{}` | Description: Server confirms new token accepted, connection extended"

---

## C-06 — First-Ever Rollover Will Fail the Test (Bootstrap Problem)

### Plain English
Every night at midnight IST, the portal automatically runs a "rollover" — it creates next month's data and locks the current month. Step 2 of this rollover is: "lock the previous month." 

But what happens on the very FIRST time this ever runs — say, June 1st when there's no "May" in the system yet? The code tries to lock "May" but May doesn't exist. In PostgreSQL, updating a row that doesn't exist just does nothing silently. That's technically okay. BUT — your test for this step checks that May IS locked (`expect(may.locked).toBe(true)`), and this test will fail when May doesn't exist. Also, what if someone tries to manually create July when only May exists, skipping June? The system should prevent that gap.

**What breaks if ignored:** Your test suite will fail on the bootstrap (first run) scenario. Operations might create months out of order without realising.

### Exact Steps

**Step 1:** Ask your AI to find your rollover service file (Prompt 1 below)

**Step 2:** Ask it to update the Step 2 logic to handle the "no prior month" case (Prompt 2)

**Step 3:** Ask it to add a bootstrap test to your test file (Prompt 3)

---

**🤖 AI PROMPT 1 — Find the rollover service:**
> "In my backend project at `apps/api/src/services/`, find the file that handles the monthly rollover. It will contain code that creates a new month in the `months` table and locks the previous month. Show me the file path and the specific section of code that handles Step 2 (locking the previous month)."

---

**🤖 AI PROMPT 2 — Add the bootstrap guard:**
> "In my rollover service, update the Step 2 logic (locking the previous month) to handle the case where no previous month exists in the database. Here is the exact logic to implement:
>
> Before attempting to lock the previous period, first query the `months` table to check if the previous period row exists: `SELECT period FROM months WHERE period = previousPeriod`.
>
> If the row EXISTS: proceed with the UPDATE to set `locked = true`, `locked_at = NOW()`, `locked_by = NULL` (NULL means the system did it, not a human).
>
> If the row does NOT EXIST: skip the lock step entirely and add a log message: `'Rollover bootstrap: no previous period found for [previousPeriod] — skipping lock step (first-ever rollover)'`.
>
> Both branches should be inside the same database transaction that handles Steps 1–7.
>
> Also add validation: before running rollover for a target period (e.g. July 2026), verify that the period immediately before it (June 2026) either exists in the months table OR this is truly the first month ever (months table is empty). If June doesn't exist but other months do, throw an error: `'Cannot create [targetPeriod] — previous period [prevPeriod] does not exist. Months must be created in sequence.'`"

---

**🤖 AI PROMPT 3 — Add the bootstrap test:**
> "In my rollover test file (find it in `apps/api/src/services/__tests__/` or similar), add two new test cases:
>
> Test 1 — name it: `'bootstrap rollover succeeds when no prior period exists in months table'`
> - Before running: clear all rows from the months table
> - Run: `RolloverService.run('2026-06')` (or whatever the current period is)
> - Assert: the function resolves without throwing
> - Assert: a row exists in months table with `period = '2026-06'` and `locked = false`
> - Assert: no other rows exist in the months table (there was nothing to lock)
>
> Test 2 — name it: `'rollover throws if a non-contiguous period is requested'`
> - Before running: insert one months row with `period = '2026-05'` only
> - Run: `RolloverService.run('2026-07')` — trying to skip June
> - Assert: the function throws with a message containing 'does not exist'"

---

---

# SECTION B — HIGH SEVERITY ITEMS (Fix before the sprint they affect)

---

## H-01 — Removing a Holiday Doesn't Restore the Attendance Grid (Fix before Sprint 3)

### Plain English
When an admin marks a day as a holiday (say August 15), two things happen: (1) a row is added to the holidays table, (2) all attendance rows for that date get marked as "holiday type" — the attendance grid shows them as gold/locked rows that nobody can interact with.

When the admin REMOVES that holiday, currently only thing (1) is undone — the holidays table is updated. But thing (2) is forgotten — those attendance rows still say "holiday type" and the grid still shows them as gold locked rows. Staff try to mark their attendance for that day and can't.

**What breaks if ignored:** Staff won't be able to mark attendance on un-holidayed dates. The visual shows it as a holiday even after removal. Support requests go to admin.

### Exact Steps

**Step 1:** Ask AI to find your holidays service (Prompt 1)

**Step 2:** Ask AI to update the remove/delete function (Prompt 2)

---

**🤖 AI PROMPT 1 — Find the holiday removal code:**
> "In my backend at `apps/api/src/services/`, find the file that handles holiday operations. Show me specifically the function or route handler that processes holiday deletion or removal (it will handle `DELETE /v1/holidays/:id`)."

---

**🤖 AI PROMPT 2 — Fix the removal to update both tables:**
> "Update my holiday removal function so that when a holiday is deleted, it updates BOTH the holidays table AND the attendance_logs table inside a single database transaction. Here is exactly what the transaction must do:
>
> Step A: Update the holidays row — set `active = false`, `removed_by = [the staffId of the admin doing this]`, `removed_at = NOW()`. (Do NOT hard-delete the row — just soft-delete it by marking it inactive.)
>
> Step B: Update ALL rows in the `attendance_logs` table WHERE `date = [the holiday's date]` AND `period = [the holiday's period]` AND `day_type = 'holiday'`. Change their `day_type` back to `'working'`.
>
> Step C: Insert an entry into the `audit_log` table recording: `staff_id = [admin's staffId]`, `changed_by_source = 'user'`, `table_name = 'holidays'`, `record_id = [the holiday's id]`, `action = 'UPDATE'`, `new_value = { active: false, removedBy: staffId }`.
>
> If any of Steps A, B, or C fail, the entire transaction should roll back — none of the changes should be saved.
>
> After the transaction commits successfully (outside the transaction): emit a Socket.io event `'attendance:holiday_removed'` to the room `'org:all'` with payload `{ period: holidayPeriod, date: holidayDate }`. This tells all connected browsers to refresh their attendance grid."

---

## H-02 — Deleted Records Could Accidentally Appear in Grids (Fix before Sprint 2)

### Plain English
In your database, when a task is "deleted" or a staff member is "deactivated," the row is not actually removed. Instead, a `deleted_at` timestamp is added to it (called "soft delete"). The row is still there — it just has a date stamped on it saying "treat this as gone."

This means EVERY query that reads tasks, staff, clients, or messages must include a filter: "only give me rows where `deleted_at` is empty." If any developer forgets this filter even once on one query, deleted records start leaking into grids. A deactivated staff member appears in the task assignee dropdown. A deleted task shows up in someone's task list.

**What breaks if ignored:** Data integrity problems. Deactivated/deleted records leaking into the UI. Hard to debug because it works for months and then quietly breaks.

### Exact Steps

**Step 1:** Ask AI to create one helper file that all services use (Prompt 1)

**Step 2:** Add a code-review rule (Prompt 2 — this goes in a README or wiki note)

---

**🤖 AI PROMPT 1 — Create the soft-delete helper:**
> "In my backend at `apps/api/src/lib/`, create a new file called `softDelete.ts`. This file exports a single helper function that makes it easy for any database query to automatically exclude soft-deleted records.
>
> The tables that support soft deletion (they have a `deleted_at` column) are: `tasks`, `staff`, `clients`, `messages`.
>
> The helper function should be called `excludeDeleted`. It takes two parameters: the Kysely expression builder `eb` and the table name (a string). It returns a Kysely WHERE condition that filters for rows where `[tableName].deleted_at IS NULL`.
>
> Write the function with proper TypeScript types using Kysely's `ExpressionBuilder`. Include JSDoc comment explaining: 'All SELECT queries on tasks, staff, clients, and messages MUST use this helper. Forgetting it causes soft-deleted records to appear in the UI.'
>
> Also include 4 usage examples in the JSDoc:
> - Example for tasks: `db.selectFrom('tasks').where(excludeDeleted(eb, 'tasks')).selectAll().execute()`
> - Example for staff: `db.selectFrom('staff').where(excludeDeleted(eb, 'staff')).selectAll().execute()`
> - Example for clients: `db.selectFrom('clients').where(excludeDeleted(eb, 'clients')).selectAll().execute()`
> - Example for messages: `db.selectFrom('messages').where(excludeDeleted(eb, 'messages')).selectAll().execute()`"

---

**🤖 AI PROMPT 2 — Add the rule to README:**
> "In my project's `README.md` file, add a new section called '## Development Rules'. Under it, add this rule:
>
> '### Soft Delete Rule
> The tables `tasks`, `staff`, `clients`, and `messages` use soft deletion — records are marked with a `deleted_at` timestamp rather than actually removed. Every SELECT query on these tables MUST use the `excludeDeleted()` helper from `apps/api/src/lib/softDelete.ts`. Forgetting this filter will cause deleted/deactivated records to appear in the UI.
>
> Code review checklist: before approving any PR that adds a new query on these tables, verify the `excludeDeleted()` helper is present.'"

---

## H-03 — Dashboard Shows Empty After Database Setup (Fix before Sprint 11, but do in Sprint 0)

### Plain English
Your dashboard pulls numbers from special "summary tables" called materialised views. These views exist in the database, but they're only populated with data after the first monthly rollover runs. On a brand new setup (fresh database, just migrated), these views exist but contain nothing.

Every developer who sets up the project locally will open the dashboard, see empty numbers, assume something is broken, and spend 30–60 minutes debugging something that's actually working fine. Same problem on a fresh staging environment.

**What breaks if ignored:** Developer time wasted. Dashboard always shows empty on fresh setups.

### Exact Steps

**Step 1:** Ask AI to add a database command (Prompt 1)

**Step 2:** Ask AI to add it to package.json scripts (Prompt 2)

**Step 3:** Ask AI to add it to the README setup instructions (Prompt 3)

---

**🤖 AI PROMPT 1 — Create the refresh script:**
> "In my backend project at `apps/api/src/scripts/`, create a new file called `refreshViews.ts`. This script, when run, executes these two SQL commands against my PostgreSQL database in sequence:
>
> `REFRESH MATERIALIZED VIEW dashboard_org_stats;`
> `REFRESH MATERIALIZED VIEW dashboard_staff_task_stats;`
>
> These must be run NON-CONCURRENTLY (without the CONCURRENTLY keyword) because the views may be empty when this script runs, and PostgreSQL doesn't allow CONCURRENTLY on empty views.
>
> The script should:
> 1. Connect to the database using the same Kysely `db` instance used elsewhere in the project
> 2. Run the first refresh and log: `'✅ Refreshed dashboard_org_stats'`
> 3. Run the second refresh and log: `'✅ Refreshed dashboard_staff_task_stats'`
> 4. Log: `'All dashboard views populated successfully'`
> 5. Close the database connection with `db.destroy()`
> 6. If any error occurs, log the error and call `process.exit(1)`
>
> The script is a standalone runnable file — it should call the main function at the bottom of the file."

---

**🤖 AI PROMPT 2 — Add to package.json:**
> "In my `apps/api/package.json`, add a new script entry: `'db:refresh-views': 'tsx src/scripts/refreshViews.ts'`. This script should sit alongside my existing `db:migrate` and `db:seed` scripts."

---

**🤖 AI PROMPT 3 — Add to README:**
> "In my project `README.md`, find the local dev setup instructions (the numbered list of setup steps). After the step that runs `pnpm --filter api db:seed` (or db:migrate), add a new step:
>
> `pnpm --filter api db:refresh-views` — with the comment: '# Populates dashboard summary tables (required for dashboard to show data)'"

---

## H-04 — Bot Streaming Pattern Has No Reference Example (Fix before Sprint 8)

### Plain English
Your AI bot streams responses word by word, like watching someone type in real time. Under the hood, this is complex: the backend talks to Anthropic's API, receives words one at a time, and needs to forward each word to the user's browser via WebSocket — while also handling tool calls (when the bot needs to look up data), and saving the conversation to the database, and updating the Redis session.

Without a reference example of how all these pieces wire together, your lead developer for Sprint 8 will spend 2+ days figuring out the wiring alone. With one ready-made example file, it becomes a half-day of integration work.

**What breaks if ignored:** Sprint 8 will run significantly over time. Streaming might be implemented incorrectly — words drop, conversation doesn't save, Redis session gets out of sync.

### Exact Steps

**Step 1:** Ask AI to create the reference file (Prompt 1 below — the most important one)

---

**🤖 AI PROMPT 1 — Create the bot stream handler reference:**
> "In my backend at `apps/api/src/bot/`, create a new file called `streamHandler.ts`. This is a REFERENCE IMPLEMENTATION showing how to wire Anthropic streaming into Socket.io. It should not be incomplete — it should be a fully working pattern.
>
> The file should export one main async function: `handleBotStream({ staffId, sessionMessages, filteredTools, io, redisClient, redisSessionKey, db })`.
>
> This function orchestrates the full bot response cycle:
>
> **Phase 1 — First Anthropic call:**
> Call `anthropic.messages.stream({ model: process.env.ANTHROPIC_MODEL_PROD, max_tokens: 1024, tools: filteredTools, messages: sessionMessages })`.
> As text tokens arrive (using the `.on('text', callback)` event), emit each token immediately to the user's Socket.io room (`user:{staffId}`) as: `io.to('user:' + staffId).emit('bot:message', { chunk: token, done: false })`.
> Collect all text tokens into a `fullResponseText` variable.
> Wait for the stream to finish using `await stream.finalMessage()` and save as `firstResponse`.
>
> **Phase 2 — Check for tool calls:**
> Look at `firstResponse.content` for any blocks with `type === 'tool_use'`.
>
> If NO tool blocks: emit the final done event: `io.to('user:' + staffId).emit('bot:message', { chunk: '', done: true, toolsUsed: [], card: null })`. Jump to Phase 4.
>
> If tool blocks EXIST:
> - Emit a status update: `io.to('user:' + staffId).emit('bot:message', { chunk: '', done: false, status: 'running_tools' })`
> - For each tool block, call `executeToolCall(staffId, toolBlock)` (assume this function exists — it will be built in Sprint 8)
> - Collect results as an array of objects: `{ type: 'tool_result', tool_use_id: toolBlock.id, content: JSON.stringify(result) }`
>
> **Phase 3 — Second Anthropic call (only if tools were used):**
> Build `secondCallMessages` = [...sessionMessages, { role: 'assistant', content: firstResponse.content }, { role: 'user', content: toolResults }]
> Call `anthropic.messages.stream` again with these messages.
> Stream tokens to the user exactly as in Phase 1.
> Wait for this stream to finish.
> Emit final done event: `io.to('user:' + staffId).emit('bot:message', { chunk: '', done: true, toolsUsed: [array of tool names used], card: null })`.
>
> **Phase 4 — Save to Redis:**
> Build `updatedHistory` = [...sessionMessages, { role: 'assistant', content: fullResponseText }]
> Keep only the last 100 items (50 user turns + 50 assistant turns): `updatedHistory.slice(-100)`
> Save to Redis: `await redisClient.setex(redisSessionKey, 43200, JSON.stringify(updatedHistory))` (43200 = 12 hours in seconds)
>
> **Phase 5 — Archive to database:**
> Insert into the `messages` table: `{ channel: 'bot', sender_id: staffId, sender_type: 'user', content: fullResponseText, content_type: 'text' }`
>
> **Error handling:**
> Wrap the entire function in try/catch. On any error, emit: `io.to('user:' + staffId).emit('bot:message', { chunk: '', done: true, error: 'Something went wrong. Please try again.' })`
> Then re-throw the error for upstream logging.
>
> Add a JSDoc comment at the top of the file explaining this is the canonical streaming pattern for Sprint 8 and Sprint 9 developers to follow."

---

## H-05 — Comment Notifications Have No Defined Recipients (Fix before Sprint 12)

### Plain English
When someone posts a comment on a Shoot Planner row, Content Dropper row, or Content Calendar cell, the spec says "the owner of the record gets notified." But it never defines who the "owner" is. For a calendar cell — who is the owner? Nobody created it (it was auto-generated by rollover). For a shoot slot — is the owner the freelancer assigned to it? The last person who edited it? All managers?

Without this defined, three developers building three different modules will make three different decisions and the notification system will be inconsistent.

**The decision (made here):** Notifications go to ALL admins and managers always (they run the operation and need to know), PLUS the assigned freelancer if the comment is on a shoot slot that has a freelancer assigned to it.

### Exact Steps

**Step 1:** Update the spec document (Prompt 1)

**Step 2:** Ask AI to find your comment service (Prompt 2)

**Step 3:** Ask AI to add the notification logic (Prompt 3)

---

**🤖 AI PROMPT 1 — Update the spec:**
> "Open `04-APPFLOW.md`. Find Section 13, the Comments Flow. Find the line that says `'Owner of record receives 'new_comment' notification'`. Replace that entire line with:
>
> `New comment notification recipients:`
> `• All staff with role 'admin' or 'manager' always receive the notification (broadcast to role:admin and role:manager Socket.io rooms)`
> `• Additionally, if the module is 'shoot_planner' AND the shoot slot has a freelancer_id assigned: also notify that freelancer`
> `• Team members are NOT notified of comments on records they didn't post on`"

---

**🤖 AI PROMPT 2 — Find the comment service:**
> "In my backend at `apps/api/src/services/`, find the file that handles comment creation (POST /v1/comments). Show me the function that runs when a new comment is created, specifically the part after the comment is saved to the database."

---

**🤖 AI PROMPT 3 — Add the notification logic:**
> "In my comment creation function (after the comment has been successfully saved to the database), add a notification dispatch function called `notifyCommentRecipients`. Here is exactly what it should do:
>
> 1. Always emit a Socket.io notification to the `'role:admin'` room: `io.to('role:admin').emit('notify:new', notificationPayload)`
> 2. Always emit the same notification to the `'role:manager'` room: `io.to('role:manager').emit('notify:new', notificationPayload)`
> 3. If `comment.module === 'shoot_planner'`: query the `shoot_schedules` table for the row with `id = comment.record_id`. Check if that row has a `freelancer_id` value (not null). If it does, emit an additional notification: `io.to('user:' + slot.freelancer_id).emit('notify:new', notificationPayload)`
>
> The `notificationPayload` should be: `{ type: 'new_comment', module: comment.module, recordContext: comment.record_context, commentId: comment.id, authorName: <name of the person who posted the comment>, link: '/' + comment.module }`
>
> Also insert a row into the `notifications` table for each recipient, so they see the notification when they log in later even if they weren't online. The notification row should have: `staff_id = <recipient's staffId>`, `type = 'new_comment'`, `payload = <the JSON payload above>`, `read = false`."

---

## H-06 — Shoot Slot Counts Not Confirmed (Decision + Code Needed Before Sprint 5)

### Plain English
Each of your clients gets a certain number of shoot slots per month. Naaz Furniture might get 4 shoots, Hyatt Hotels might get 6. These numbers need to be in the database before Sprint 5, because Sprint 5 builds the Shoot Planner which generates slots based on these numbers.

Your operations team hasn't confirmed the actual numbers yet. The plan: use 4 as a placeholder for every client, build the portal, and when real numbers come in, use a special method to adjust them.

**What breaks if ignored:** Sprint 5 can't run without slot counts. If wrong numbers go in and there's no way to fix them, the entire shoot planner grid will have wrong numbers of rows from day one.

### Exact Steps

**Step 1:** Make the operations team deadline decision (write it down — Prompt 1 is a document update)

**Step 2:** Ask AI to add the slot-adjustment method to your backend (Prompt 2)

---

**🤖 AI PROMPT 1 — Document the decision:**
> "In `06-IMPLEMENTATION-PLAN.md`, find the row for Sprint 5 in the sprint summary table. Add a note to its Deliverable column saying: 'Requires per-client shoot_slots_per_month values. If not confirmed by operations by end of Sprint 4: use placeholder value of 4 for all clients. Use ShootSchedulerService.adjustSlotCount() for corrections after real values arrive.'
>
> Also find Section 18 (External Dependencies table) and update the row for OD-05 (Per-client shoot slot counts) to say: 'Decision deadline: end of Sprint 4, Week 5. Fallback: 4 slots per client. Adjustment method: ShootSchedulerService.adjustSlotCount() available from Sprint 5.'"

---

**🤖 AI PROMPT 2 — Create the slot adjustment method:**
> "In my backend at `apps/api/src/services/`, find the file that handles shoot planner operations (it will have queries on the `shoot_schedules` table). Add a new exported async function called `adjustSlotCount` that takes these parameters: `clientId: string`, `period: string`, `newCount: number`, `requestedBy: string`.
>
> This function allows changing the number of shoot slots for a client in a specific period. Here is the exact logic:
>
> 1. Query the `shoot_schedules` table to get all current slots for this client + period, ordered by `slot_index`. Store this as `currentSlots`. Get `currentCount = currentSlots.length`.
>
> 2. If `newCount === currentCount`: return immediately (nothing to do, log 'Slot count unchanged').
>
> 3. If `newCount < currentCount` (reducing slots):
>    - Find the slots that would be removed: `currentSlots` with `slot_index > newCount`
>    - Check if ANY of those slots have `slot_status` that is NOT `'Unset'` (meaning they're already scheduled or confirmed)
>    - If yes: throw an error with message: `'Cannot reduce slot count from [currentCount] to [newCount] — slots [list the slot_index numbers] already have data assigned. Remove or reassign those slots first.'`
>    - If no (all would-be-removed slots are Unset): delete those rows from `shoot_schedules`
>
> 4. If `newCount > currentCount` (adding slots):
>    - Calculate how many new slots to add: `newCount - currentCount`
>    - Insert that many new rows into `shoot_schedules`, with `slot_index` starting from `currentCount + 1` up to `newCount`, `slot_status = 'Unset'`, `client_id = clientId`, `period = period`, `pieces_expected = 1`
>
> 5. Always insert an audit log entry with: `staff_id = requestedBy`, `changed_by_source = 'user'`, `table_name = 'shoot_schedules'`, `action = 'UPDATE'`, `new_value = { clientId, period, slotCountChanged: { from: currentCount, to: newCount } }`"

---

## H-07 — No Error Tracking (Add Sentry — Sprint 13)

### Plain English
When something breaks in production right now, you have to log into Railway, find the logs, and try to search through them to find what happened. Sentry is a free service that automatically catches every error the moment it happens, with full details: who was using the portal, what they were doing, the exact line of code that failed, and how many times it's happened. It's the difference between "something broke, let me dig through logs" and "here's exactly what broke and why."

**What breaks if ignored:** Production debugging is extremely painful. You can't see errors as they happen. Launch week (highest-risk period) you'll be flying blind.

### Exact Steps

**Step 1:** Create a free Sentry account at sentry.io

**Step 2:** Create two projects in Sentry dashboard: one called "skaly-portal-frontend" (type: Next.js) and one called "skaly-portal-backend" (type: Node.js)

**Step 3:** Copy the DSN value from each project (it looks like `https://abc123@sentry.io/12345`)

**Step 4:** Ask AI to set it up in your frontend (Prompt 1)

**Step 5:** Ask AI to set it up in your backend (Prompt 2)

**Step 6:** Add the environment variables (Prompt 3 — this is just adding variables, no code)

---

**🤖 AI PROMPT 1 — Frontend Sentry setup:**
> "Install and configure Sentry in my Next.js frontend at `apps/web/`. Run `pnpm add @sentry/nextjs`. Then create the file `apps/web/sentry.client.config.ts` with this content:
>
> Import Sentry from `@sentry/nextjs`. Call `Sentry.init()` with:
> - `dsn: process.env.NEXT_PUBLIC_SENTRY_DSN`
> - `environment: process.env.NODE_ENV`
> - `tracesSampleRate: 0.1` (capture 10% of transactions — keeps it free tier)
> - `enabled: process.env.NODE_ENV === 'production'` (don't send errors during development)
>
> Also create `apps/web/sentry.server.config.ts` with the same content but using `SENTRY_DSN` instead of `NEXT_PUBLIC_SENTRY_DSN`."

---

**🤖 AI PROMPT 2 — Backend Sentry setup:**
> "Install and configure Sentry in my Fastify backend at `apps/api/`. Run `pnpm add @sentry/node`. Then in my main server file (the one that creates the Fastify instance, likely `apps/api/src/server.ts`), add Sentry initialization at the very TOP of the file, before any other imports:
>
> `import * as Sentry from '@sentry/node'`
> `Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV, tracesSampleRate: 0.1, enabled: process.env.NODE_ENV === 'production' })`
>
> Also in my Fastify global error handler (the `app.setErrorHandler` function), add Sentry error capture for unhandled/500 errors: `Sentry.captureException(error)` — add this line just before the `logger.error(...)` call for unexpected errors."

---

**🤖 AI PROMPT 3 — Add environment variables:**
> "I need to add Sentry DSN environment variables. Tell me:
> 1. Which file in `apps/web/` stores environment variables (probably `.env.local`)
> 2. Which file in `apps/api/` stores environment variables (probably `.env`)
>
> Then show me the exact lines to add to each file:
> - Frontend: `NEXT_PUBLIC_SENTRY_DSN=` (I'll fill in the actual value from Sentry dashboard)
> - Backend: `SENTRY_DSN=` (I'll fill in the actual value from Sentry dashboard)
>
> Also show me where to add these in Vercel (frontend env vars) and Railway (backend env vars) for production."

---

## H-08 — Missing Content Security Policy Header (Sprint 13)

### Plain English
A Content Security Policy (CSP) is a security instruction you put in your website's headers. It tells every user's browser: "only trust scripts and styles from these approved sources — block everything else." Without it, if a hacker somehow sneaks malicious code into your portal (through a chat message, for example), the browser will run it. With CSP, the browser blocks it even if it gets in.

Your portal already sanitizes chat messages (that's the DOMPurify library in your stack). CSP is the second layer of protection.

**What breaks if ignored:** No immediate breakage. But if any XSS vulnerability is ever found, there's no second line of defense. Security audits will flag this.

### Exact Steps

**Step 1:** Find your `vercel.json` file (Prompt 1)

**Step 2:** Add the CSP header (Prompt 2)

---

**🤖 AI PROMPT 1 — Find vercel.json:**
> "In my Next.js project at `apps/web/`, find the `vercel.json` file. If it doesn't exist, show me the project root and ask me to confirm where it should be created. Show me the current contents of `vercel.json`."

---

**🤖 AI PROMPT 2 — Add the CSP header:**
> "In my `vercel.json` file, find the `headers` array. There should already be headers for `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy`. Add a fourth header to the same array:
>
> Key: `Content-Security-Policy`
> Value: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.skaly.in wss://api.skaly.in https://*.supabase.co; frame-ancestors 'none';`
>
> Note: The `unsafe-inline` and `unsafe-eval` are required for Next.js to function correctly. This is intentional and normal for Next.js apps."

---

## H-09 — Database Connection Pool Monitoring (Sprint 13)

### Plain English
Your database allows a maximum of 20 simultaneous connections from your backend (this is the "connection pool"). At 50 users this is fine. But if the system grows, or if a slow query holds a connection open for a long time, you could run out of available connections. When this happens, new requests have to wait — pages load slowly and users notice.

Currently there's no way to see how many connections are in use right now. This adds it to the health check endpoint that Railway already monitors.

### Exact Steps

**Step 1:** Ask AI to find and update your health check endpoint (Prompt 1 below)

---

**🤖 AI PROMPT 1 — Update the health check:**
> "In my backend, find the route handler for `GET /v1/health` (it currently checks database connectivity and Redis connectivity). Update it to also include connection pool statistics.
>
> After checking database and Redis status, add pool metrics to the response. Using my Kysely database instance (called `db` or similar), access the underlying pg pool stats. Most Kysely setups expose this via `db.pool` or the underlying pg Pool instance. Include in the response:
>
> `pool: { total: <total connections>, idle: <idle connections>, waiting: <requests waiting for a connection>, utilizationAlert: <'HIGH' if (total-idle)/total > 0.8, otherwise 'ok'> }`
>
> The final response should look like:
> `{ status: 'ok' or 'degraded', services: { database: 'ok' or 'error', redis: 'ok' or 'error' }, pool: { total: 5, idle: 3, waiting: 0, utilizationAlert: 'ok' }, timestamp: '<ISO string>' }`
>
> If pool stats are not available from the Kysely instance, include `pool: { available: false, note: 'Pool stats require direct pg Pool access — configure in db.ts' }` and note that we should expose the underlying Pool for monitoring."

---

---

# SECTION C — MEDIUM SEVERITY ITEMS

---

## M-01 — Profile Picture: Allow Team Members to Upload Their Own Image

### Your Note
You said: *"For Profile picture — allow team member to add their image for identity."*

This is changing from the original spec (which planned initials-only for MVP). Here is the complete solution to allow profile photo uploads.

### Plain English
The database already has an `avatar_url` column on the staff table — it was planned for Phase 2. You're bringing it into MVP. The flow works like task attachments: browser requests a temporary upload link from the backend → browser uploads directly to Cloudflare R2 → backend records the URL. Fast, secure, no image going through your server.

### Exact Steps

**Step 1:** Add the two new API endpoints (Prompt 1)

**Step 2:** Build the profile photo component in the frontend (Prompt 2)

**Step 3:** Update the Avatar display component to show real photos (Prompt 3)

---

**🤖 AI PROMPT 1 — Backend: add avatar upload endpoints:**
> "In my Fastify backend, add two new endpoints to the staff routes file:
>
> **Endpoint 1:** `POST /v1/staff/me/avatar/presign`
> Auth: All roles (any logged-in user can upload their own avatar)
> This endpoint generates a presigned upload URL for Cloudflare R2. The logic:
> 1. Generate a unique file key: `avatars/{staffId}/{timestamp}.jpg`
> 2. Use the R2 S3 client to create a presigned PUT URL with expiry of 300 seconds (5 minutes)
> 3. Return: `{ data: { presignedUrl: '<url>', fileKey: '<key>' } }`
>
> **Endpoint 2:** `POST /v1/staff/me/avatar/confirm`
> Auth: All roles
> Request body: `{ fileKey: string }`
> This endpoint records that the upload was successful. The logic:
> 1. Validate that `fileKey` starts with `avatars/{staffId}/` (prevent overwriting other users' avatars)
> 2. Construct the public display URL from the file key: store the fileKey as `avatar_url` in the staff table
> 3. Update the `staff` table: `UPDATE staff SET avatar_url = fileKey WHERE id = staffId`
> 4. Insert audit log entry
> 5. Return: `{ data: { avatarUrl: fileKey } }`
>
> Both endpoints should be in the staff routes, accessible to all authenticated users."

---

**🤖 AI PROMPT 2 — Frontend: Avatar upload component:**
> "In my Next.js frontend at `apps/web/components/profile/`, create a component called `AvatarUpload.tsx`. This component:
>
> **Visual design:** Shows the current avatar (if set) or initials (if no avatar). Has a circular overlay with a camera icon on hover. Clicking anywhere on it opens a file picker. Uses the portal's dark theme colors from globals.css.
>
> **Upload flow:**
> 1. User clicks the component → opens file picker (accept: 'image/jpeg,image/png,image/webp', max 5MB)
> 2. On file selection: show a loading spinner over the avatar circle
> 3. Call `POST /v1/staff/me/avatar/presign` to get `{ presignedUrl, fileKey }`
> 4. PUT the file directly to `presignedUrl` using `fetch(presignedUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })`
> 5. On successful PUT: call `POST /v1/staff/me/avatar/confirm` with `{ fileKey }`
> 6. Update the displayed avatar to show the new image
> 7. Show a brief success toast: 'Profile photo updated'
>
> **Error states:**
> - File too large (> 5MB): show toast 'Image must be under 5MB'
> - Upload fails: show toast 'Upload failed — please try again', remove spinner
>
> **Props:** `currentAvatarUrl: string | null`, `staffName: string`, `onAvatarUpdated: (newUrl: string) => void`"

---

**🤖 AI PROMPT 3 — Update Avatar display everywhere:**
> "In my frontend, find all places where I display a staff member's avatar or initials. Update them to use this logic: if `avatarUrl` is not null and not empty, display an `<img>` tag pointing to `{process.env.NEXT_PUBLIC_API_URL}/v1/staff/{staffId}/avatar` (the backend will generate a presigned URL for the request). If `avatarUrl` is null or empty, show the initials-based colored circle instead.
>
> For the initials circle: use the first letter of first name and first letter of last name, both uppercase, white text on a colored background. Generate a consistent background color from the name by: taking the char code of the first character, modulo 6, and picking from these colors: `['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#eab308']`."

---

**🤖 AI PROMPT 4 — Backend: Serve avatar via presigned URL:**
> "Add one more endpoint: `GET /v1/staff/:id/avatar`
> Auth: All roles (any authenticated user can view any avatar)
> This endpoint: generates a presigned GET URL (1-hour expiry) for the staff member's `avatar_url` file key from R2, then returns a 302 redirect to that presigned URL. This means `<img src='/v1/staff/{id}/avatar'>` works directly in the browser."

---

## M-02 — Mobile Users See a Broken Layout (Sprint 0)

### Plain English
Your portal requires at least 1280px wide screen. On a phone, the layout breaks completely. The spec says "mobile app is Phase 2" but doesn't specify what a mobile user should see when they visit the web portal. Right now they'd see a broken jumbled layout.

### Exact Steps

**One prompt. Done in 10 minutes.**

---

**🤖 AI PROMPT 1 — Add mobile fallback:**
> "In my Next.js frontend, find the portal layout file at `apps/web/app/(portal)/layout.tsx`. This is the wrapper around all authenticated portal pages.
>
> At the beginning of the return statement, before the existing portal content, add a mobile gate:
>
> Wrap the existing portal content in a `div` with class `hidden md:block` (this hides it on screens smaller than 768px and shows it on 768px+).
>
> Before that div, add a new div with class `flex md:hidden` (shows on small screens, hidden on 768px+). This div should display a centered, full-screen message with:
> - Background: `--bg-base` color (`#0D0D0F`)
> - 'Skaly Business Portal' heading in Big Shoulders Display font, gold color (`#FDC257`), centered
> - Text below: 'This portal requires a desktop browser.' in DM Sans, secondary text color
> - Text below that: 'Mobile app coming soon.' in smaller, muted text
>
> Both divs should have `min-h-screen` so they fill the full viewport height."

---

## M-03 — Orphaned Files in R2 (Accepted Tech Debt — Document It)

### Plain English
If a task is ever permanently deleted from the database, any file attachments it had in Cloudflare R2 will become "orphaned" — they'll sit in R2 taking up space with no matching database record. Since tasks are soft-deleted (not permanently deleted), this is unlikely to happen in practice. But we should document it.

### Exact Steps

**One prompt, one file.**

---

**🤖 AI PROMPT 1 — Add a code comment:**
> "In my task service file at `apps/api/src/services/tasks.service.ts` (or wherever task deletion logic lives), find the soft-delete function (the one that sets `deleted_at = NOW()`). Add a code comment directly above it:
>
> `// NOTE: Tasks use SOFT DELETE only. Hard-delete is intentionally not implemented.`
> `// If hard-delete is ever added (post-MVP), add R2 file cleanup to the same transaction:`
> `// 1. Query task_attachments WHERE task_id = id to get all fileKeys`
> `// 2. Delete each fileKey from R2 using r2.send(new DeleteObjectCommand({ Key: fileKey }))`
> `// 3. Delete the task_attachments rows`
> `// 4. Then delete the task row`
> `// Skipping this creates orphaned files in R2 (storage cost, no data risk)`"

---

## M-05 — Search Query Strategy Not Documented (Fix before Sprint 9)

### Plain English
Your portal has a CMD+K search that searches across tasks, staff, clients, and comments simultaneously. The spec says what the search RETURNS but never says HOW to write the database queries. Without this, the Sprint 9 developer will have to design the query strategy on their own.

The strategy: run all 4 searches at the same time (in parallel), each returning up to 5 results, then combine them in code.

### Exact Steps

---

**🤖 AI PROMPT 1 — Add search query strategy to the spec:**
> "Open `07-API-CONTRACT.md`. Find the section for `GET /v1/search` endpoint. After the endpoint description (and before or after the response format), add this implementation note:
>
> '**Search Implementation Strategy (for Sprint 9 developer):**
> Run 4 database queries in PARALLEL using `Promise.all()`, not sequentially. Each query returns up to 5 results:
>
> Query 1 — Tasks:
> `SELECT id, description, status, period FROM tasks WHERE search_vector @@ plainto_tsquery(query) [AND period = currentPeriod IF scope='current'] AND deleted_at IS NULL ORDER BY ts_rank(search_vector, plainto_tsquery(query)) DESC LIMIT 5`
>
> Query 2 — Staff:
> `SELECT id, name, role, avatar_url FROM staff WHERE name ILIKE '%' || query || '%' AND active = true AND deleted_at IS NULL LIMIT 5`
>
> Query 3 — Clients:
> `SELECT id, name, active FROM clients WHERE name ILIKE '%' || query || '%' AND deleted_at IS NULL LIMIT 5`
>
> Query 4 — Comments:
> `SELECT id, content, module, record_context, period FROM comments WHERE search_vector @@ plainto_tsquery(query) [AND period = currentPeriod IF scope='current'] ORDER BY ts_rank(search_vector, plainto_tsquery(query)) DESC LIMIT 5`
>
> Combine all 4 results in the service layer. Return: `{ tasks: [...], staff: [...], clients: [...], comments: [...] }`. Use `plainto_tsquery` not `to_tsquery` — it handles user input without crashing on special characters.'"

---

## M-06 — Rate Limit Headers Not Shown to Frontend (Sprint 2)

### Plain English
When someone hits the rate limit (e.g., makes too many API requests), the server returns a 429 error. Your `@fastify/rate-limit` package already handles this. But by default, it doesn't send extra information in the response headers that would tell the browser: "you have X requests left out of Y total, and the limit resets at Z time." Adding these headers lets the frontend show a better message or slow down automatically.

### Exact Steps

---

**🤖 AI PROMPT 1 — Enable rate limit headers:**
> "In my Fastify backend, find where I register `@fastify/rate-limit` (it will be in my server setup file with `fastify.register(rateLimit, { ... })`). Add this option inside the registration config object:
>
> ```
> addHeaders: {
>   'x-ratelimit-limit': true,
>   'x-ratelimit-remaining': true,
>   'x-ratelimit-reset': true,
>   'retry-after': true
> }
> ```
>
> These are standard HTTP rate-limit headers. `@fastify/rate-limit` supports them natively — this just enables sending them in the response."

---

## M-07 — Add Missing Test: Rollover Should Not Send Double Notification (Sprint 12)

### Plain English
Your rollover is "idempotent" — if it runs twice for the same month (say the cron job fires, then an admin also manually triggers it), the second run exits immediately because the month already exists. But there's no test verifying the notification ("month is ready") only fires once. This test protects against accidentally notifying all admins twice.

### Exact Steps

---

**🤖 AI PROMPT 1 — Add the test:**
> "In my rollover test file, add a new test case:
>
> Name: `'idempotent rollover does NOT send month_ready notification on the second call'`
>
> Logic:
> 1. Create a spy/mock on my NotificationService's admin notification function (the one that sends 'month_ready' notifications)
> 2. Run `RolloverService.run('2026-06')` — this is the FIRST run, should succeed and send notification once
> 3. Assert: the notification function was called exactly 1 time
> 4. Run `RolloverService.run('2026-06')` again — this is the SECOND run (same month), should exit early via idempotency check
> 5. Assert: the notification function was STILL called exactly 1 time (not 2 times)
>
> This verifies the idempotency exit happens BEFORE the notification, not after."

---

## M-08 — Bot Tool Errors Need Better User Messages (Sprint 9)

### Plain English
When the bot calls a tool (like "create a task") and the tool fails because of bad input (wrong client name, invalid date format), right now the user sees "Something went wrong." That's not helpful. The bot should be able to say "I tried to create a task but the client name wasn't recognized — could you clarify which client you mean?"

This is done by passing the error back to the Anthropic API as a "tool result" — the model then composes a helpful human-readable explanation.

### Exact Steps

---

**🤖 AI PROMPT 1 — Update tool execution error handling:**
> "In my bot tool execution code (find it in `apps/api/src/bot/`), find the function that executes individual tool calls. Currently when a tool throws an error, it probably propagates up and causes a generic error response.
>
> Update the error handling so that when a tool call fails due to validation or business logic errors (as opposed to a server crash), the error is returned as a TOOL_RESULT error back to the Anthropic API rather than crashing the bot flow.
>
> The return value in error cases should be:
> ```
> {
>   type: 'tool_result',
>   tool_use_id: <the tool block's id>,
>   is_error: true,
>   content: `Tool [toolName] failed: [error.message]. Please ask the user to clarify.`
> }
> ```
>
> This way, the second Anthropic API call (after tool execution) receives the error as context and the model generates a response like 'I couldn't complete that — [explanation]. Could you clarify [specific thing]?' rather than a generic error.
>
> Only do this for application errors (ValidationError, BusinessRuleError, ResourceNotFoundError). Actual unexpected server errors (database connection failure, etc.) should still propagate as real errors."

---

## M-10 — Development Seed Data (Sprint 0)

### Plain English
Every developer who sets up the project locally needs test data to work with. Without it, they have to manually create staff accounts, clients, and periods through the UI just to test their module. This takes 30–60 minutes every time someone does a fresh setup. A "seed" file creates all this test data automatically with one command.

### Exact Steps

---

**🤖 AI PROMPT 1 — Create the dev seed file:**
> "In my project at `database/seeds/`, create a new file called `002_dev_data.ts`. This file creates test data for local development only — it should NEVER run in production.
>
> At the top of the file, add: `if (process.env.NODE_ENV === 'production') { console.log('Skipping dev seed — production'); process.exit(0); }`
>
> The seed should insert this data using `onConflict().doNothing()` on all inserts (so running it twice is safe):
>
> **4 staff members (one of each role):**
> - id: `'11111111-1111-1111-1111-111111111111'`, name: `'Admin Test'`, email: `'admin@test.skaly.in'`, role: `'admin'`, active: `true`, mfa_enrolled: `true`
> - id: `'22222222-2222-2222-2222-222222222222'`, name: `'Manager Test'`, email: `'manager@test.skaly.in'`, role: `'manager'`, active: `true`, mfa_enrolled: `true`
> - id: `'33333333-3333-3333-3333-333333333333'`, name: `'Team Test'`, email: `'team@test.skaly.in'`, role: `'team_member'`, active: `true`, mfa_enrolled: `false`
> - id: `'44444444-4444-4444-4444-444444444444'`, name: `'Freelancer Test'`, email: `'freelancer@test.skaly.in'`, role: `'freelancer'`, active: `true`, mfa_enrolled: `false`
>
> **3 clients:**
> - id: `'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`, name: `'Naaz Furniture'`, is_internal: `false`, active: `true`, shoot_slots_per_month: `4`, pieces_per_visit: `2`
> - id: `'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'`, name: `'Hyatt Hotels'`, is_internal: `false`, active: `true`, shoot_slots_per_month: `6`, pieces_per_visit: `3`
> - id: `'cccccccc-cccc-cccc-cccc-cccccccccccc'`, name: `'Skaly Internal'`, is_internal: `true`, active: `true`, shoot_slots_per_month: `2`, pieces_per_visit: `1`
>
> **Current month in the months table:**
> Calculate the current year and month programmatically using JavaScript's `new Date()`. Insert a months row with `locked: false`.
>
> Log success messages after each batch: '✅ Dev staff seeded', '✅ Dev clients seeded', '✅ Dev month seeded'."

---

**🤖 AI PROMPT 2 — Add to package.json:**
> "In `apps/api/package.json`, find the scripts section. Update my `db:seed` script to run BOTH seed files in sequence: first `database/seeds/001_system_actor.ts` and then `database/seeds/002_dev_data.ts`. If the script currently only runs one file, update it to run both using `&&` or by creating a separate seed runner script."

---

## M-11 — No README File Exists (Sprint 0)

### Plain English
If anyone new joins the project — or if you come back to it after a month away — there's no single document that says "here's how to set this up and run it." This is the README file that every software project needs.

### Exact Steps

---

**🤖 AI PROMPT 1 — Create the README:**
> "Create a `README.md` file in the root of my monorepo (not inside any app folder — at the top level). Include these sections:
>
> **# Skaly Business Portal**
> Brief description: 'Internal operations platform for Skaly Group. Replaces Google Sheets + WhatsApp coordination with a unified, role-aware portal for content production management.'
>
> **## Quick Start**
> Prerequisites list (Node.js 20+, pnpm 9+, Docker Desktop)
> Then numbered setup steps:
> 1. Clone and enter repo
> 2. `pnpm install` — install all dependencies
> 3. `docker compose up -d` — start local PostgreSQL and Redis
> 4. `cp apps/api/.env.example apps/api/.env` — copy env template (edit with your values)
> 5. `cp apps/web/.env.example apps/web/.env` — copy env template (edit with your values)
> 6. `pnpm --filter api db:migrate` — run database migrations
> 7. `pnpm --filter api db:seed` — seed development data
> 8. `pnpm --filter api db:refresh-views` — populate dashboard views
> 9. `pnpm dev` — start everything
>
> After step 9: Frontend at http://localhost:3000 | Backend at http://localhost:3001
>
> **## Test Accounts (Dev Only)**
> Table with 4 rows: Admin, Manager, Team Member, Freelancer — email and password for each dev account
>
> **## Project Structure**
> Brief description of apps/web (Next.js frontend), apps/api (Fastify backend), packages/shared (shared types and Zod schemas), database/migrations (Kysely DB migrations)
>
> **## Running Tests**
> `pnpm test` — unit and integration tests
> `pnpm test:e2e` — Playwright end-to-end tests (needs staging env)
>
> **## Specification Documents**
> Link to all 14 spec documents with one-line descriptions for each
>
> **## Development Rules**
> The soft-delete rule from H-02 fix"

---

## M-12 — Add API Documentation Browser (Sprint 2)

### Plain English
Your API Contract document (the markdown file) describes every endpoint. But developers have to manually read the file and test endpoints using tools like Postman or Insomnia. Swagger UI is a web page that shows all your API endpoints with the ability to test them directly in the browser. Fastify generates it automatically from your existing route definitions — it's a small install.

### Exact Steps

---

**🤖 AI PROMPT 1 — Install and configure Swagger:**
> "In my Fastify backend project `apps/api/`, install these two packages: `@fastify/swagger` and `@fastify/swagger-ui`.
>
> In my main server file where I register other Fastify plugins (like helmet, cors, rate-limit), add these two plugin registrations IN THIS ORDER (they must come before route registrations):
>
> First, register `@fastify/swagger` with:
> - openapi version: `'3.0.0'`
> - info.title: `'Skaly Business Portal API'`
> - info.description: `'Internal portal API — requires JWT authentication on all protected routes'`
> - info.version: `'1.0.0'`
> - servers: `[{ url: 'https://api.skaly.in/v1' }]`
> - security: Bearer JWT scheme
>
> Then register `@fastify/swagger-ui` with:
> - routePrefix: `'/v1/docs'`
> - uiConfig.docExpansion: `'list'`
>
> After doing this, protect the `/v1/docs` route so that only authenticated admins can access it in production (in development, it can be open). The Swagger UI will be available at `http://localhost:3001/v1/docs` during development."

---

---

# SECTION D — PART 5: LOW SEVERITY ITEMS (After Launch)

These are things to do AFTER you launch and the portal is live. They're small improvements and safety nets, not launch blockers.

---

## L-01 — Health Check Doesn't Check R2 or Anthropic

**Do after launch.** Your health check already checks PostgreSQL and Redis. R2 and Anthropic are not checked because their failures are visible to users directly (file uploads fail, bot shows "unavailable"). Adding them could cause false alarms.

**Action after launch:**
> "In my health check endpoint `GET /v1/health`, optionally add a non-blocking R2 check: call `r2.send(new HeadBucketCommand({ Bucket: process.env.R2_BUCKET_NAME }))` and include the result in the response as `r2: 'ok' or 'error'`. Mark this as non-critical: even if R2 is down, return HTTP 200 (not 503) since core portal functionality still works."

---

## L-02 — No Virus Scanning on Uploaded Files

**Do after launch (Phase 2).** For MVP with 50 known internal staff uploading files, the risk is very low. After launch, when you're comfortable with the portal, consider adding Cloudflare Workers with ClamAV to scan files before they're confirmed in R2.

**Document this accepted risk now:**
> "In your project's risk log or IMPLEMENTATION-PLAN.md risk register, add: 'File uploads have no virus scanning for MVP. Accepted risk: only 50 known internal staff with file upload access. Phase 2: evaluate Cloudflare Workers + ClamAV integration for pre-confirm scan.'"

---

## L-03 — No CDN Caching for Static API Endpoints

**Not needed now.** Your API is a single Railway instance serving 50 users. CDN caching for API responses adds complexity for no practical benefit at this scale. Note for future: if you ever expand geographically or beyond 200+ users, revisit.

**No action needed.**

---

## L-04 — No Background Job Queue

**Not needed now.** At MVP, your only long-running job is the daily rollover, which runs at midnight. It's already handled with retry logic. Background job queues (like BullMQ) add complexity. If you ever need to process more than one type of background job, add it then.

**No action needed.**

---

## L-05 — Backup Restore Drill Is Manual

**Schedule after launch.** Once a month, restore your latest R2 database backup to a temporary database and verify the row counts look right. Destroy the temp database. This proves your backups actually work.

**Action after launch (recurring, monthly):**
> "In your team calendar, add a recurring monthly reminder: 'Restore drill — spin up temp Railway PostgreSQL, restore latest R2 backup, verify counts, destroy.' The Railway dashboard makes this a 20-minute task."

---

## L-06 — Past Months Selector Endpoint

**Works implicitly — no action needed.** Your `GET /v1/months` endpoint returns all months. The frontend filters them to show past months. This is fine.

---

## L-07 — Mobile Offline Replay (Phase 2)

**Phase 2 only.** When you build the mobile app, decide whether offline mutations are queued and replayed on reconnect. The web portal doesn't have offline mode. No action for MVP.

---

## L-08 — Bot Session Beyond 12 Hours

**Working as intended — no action needed.** The Redis session (12-hour TTL) is the active working memory. Long-term bot history is archived to the `messages` table. If a user wants to refer back to a conversation from yesterday, the messages table has it. The 12-hour limit is intentional.

---

## L-09 — Enable GitHub Dependabot (Do This in 5 Minutes Today)

**Do this right now — it takes 5 minutes.**

Go to your GitHub repository → click **Settings** tab → scroll down to **Security** in the left sidebar → click **Code security and analysis** → click **Enable** next to **Dependabot alerts** and **Dependabot security updates**.

That's it. Dependabot will now automatically tell you when any package you use has a known security vulnerability, and will even open pull requests to update them automatically.

---

---

# COMPLETE SPRINT 0 CHECKLIST

Print this or put it in Notion. Every item must be checked before Sprint 1 starts.

```
BLOCKERS (from previous guide — verify these are done)
  [ ] B-01  Migration 026_database_roles.ts exists and has been applied to staging
  [ ] B-02  Template decision documented (templates received OR fallback path confirmed)  
  [ ] B-03  internalAuth.plugin.ts exists with timingSafeEqual comparison

CRITICALS (from this guide)
  [ ] C-05  socketTokenWatcher.ts created and connected to Socket.io server
  [ ] C-05  Frontend auth:refresh_required handler added to socket client
  [ ] C-05  auth:refresh and auth:refreshed events added to API-CONTRACT §6
  [ ] C-06  Rollover service has bootstrap guard (checks if prev period exists before locking)
  [ ] C-06  Bootstrap rollover test added and passing
  [ ] C-06  Non-contiguous period validation added and tested

HIGH ITEMS DUE SPRINT 0
  [ ] H-02  excludeDeleted() helper created at apps/api/src/lib/softDelete.ts
  [ ] H-03  db:refresh-views script created and in package.json
  [ ] H-03  README setup instructions include db:refresh-views step
  [ ] H-04  stream-handler.ts reference implementation created at apps/api/src/bot/
  [ ] M-02  Mobile fallback gate added to portal layout
  [ ] M-10  002_dev_data.ts seed file created and working
  [ ] M-11  README.md created at project root
  [ ] L-09  GitHub Dependabot enabled on repository

DECISIONS THAT MUST BE DOCUMENTED BY SPRINT 0 END
  [ ] H-05  Comment notification rule written into 04-APPFLOW.md §13
  [ ] H-06  Shoot slot count deadline communicated to operations team in writing
  [ ] C-03  Transactional email = out of scope confirmed in PRD §6

ITEMS SCHEDULED FOR SPECIFIC SPRINTS (do not forget these)
  [ ] H-01  Holiday removal cascade (Sprint 3)
  [ ] H-05  Comment notification service code (Sprint 12)
  [ ] H-06  adjustSlotCount() method (Sprint 5)
  [ ] H-07  Sentry setup — frontend + backend (Sprint 13)
  [ ] H-08  CSP header in vercel.json (Sprint 13)
  [ ] H-09  Connection pool monitoring in health check (Sprint 13)
  [ ] M-01  Avatar upload endpoints + UI component (Sprint 11)
  [ ] M-05  Search query strategy added to API-CONTRACT (Sprint 9)
  [ ] M-06  Rate limit headers enabled (Sprint 2)
  [ ] M-07  Rollover double-notification test (Sprint 12)
  [ ] M-08  Bot tool error recovery (Sprint 9)
  [ ] M-09  PDF font files downloaded and registered (Sprint 12)
  [ ] M-12  Swagger UI installed (Sprint 2)

AFTER LAUNCH (post-go-live backlog)
  [ ] L-01  Optional R2 health check in /v1/health endpoint
  [ ] L-02  Document virus scanning as accepted risk in risk register
  [ ] L-05  Add monthly restore drill to team calendar
  [ ] L-09  ✅ Already done above (Dependabot)
```

---

## QUICK SUMMARY: WHAT EACH FILE IS AND WHY IT MATTERS TO YOUR BUILD

| Document | Affects which sprints | Example of what goes wrong without it |
|---|---|---|
| PRD (01) | All of them — it's the source of truth for features | Developers build features that don't match what you intended |
| TRD (02) | Sprint 0 — tech stack is chosen here | Wrong package installed, conflicts discovered mid-build |
| UIUX (03) | Sprint 1, 3–12 — every screen references it | Colors wrong, fonts wrong, layout doesn't match design |
| APPFLOW (04) | Sprint 1–12 — every user flow | Developers invent flows that don't match your intended UX |
| Schema (05) | Sprint 0, 2 — database is built here | Missing columns, wrong types, constraints not enforced |
| Impl Plan (06) | All 14 weeks | Nobody knows what to build when, work gets duplicated |
| API Contract (07) | Sprint 1–12 — frontend/backend must agree | Endpoints don't match, frontend can't talk to backend |
| Auth Matrix (08) | Sprint 1–2 | Wrong people see wrong data, security issues |
| Error Handling (09) | Sprint 1–12 | Inconsistent error messages, bad UX on failures |
| Infra (10) | Sprint 0 | Infrastructure not set up right, deployment fails |
| Third Party (11) | Sprint 0, 1, 8 | Supabase, Anthropic, R2 not integrated correctly |
| Testing (12) | Sprint 0–13 | No automated tests, bugs ship to production |
| NFRs (13) | Sprint 13 — performance testing | Portal is slow, accessibility fails, security gaps |
| Audit (14, this doc) | Sprint 0 | All the gaps above — this doc found them before coding started |

---

*This guide covers all 21 pending items you listed, plus the Part 5 post-launch items. Every prompt is written to be pasted directly into Cursor, GitHub Copilot Chat, or any AI coding assistant.*
