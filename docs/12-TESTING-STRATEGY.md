# 12 — TESTING STRATEGY
## Skaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** TRD §5.2, ERROR-HANDLING §4-5, IMPL-PLAN §3-5, NFR §1

---

## 1. TESTING PHILOSOPHY

Every test must prove something the business depends on. The test suite exists to:
1. Catch regressions in business rules (rollover transaction, stage sequences, RBAC)
2. Protect data integrity (dependency blocking, month lock enforcement, optimistic locking)
3. Verify the two priority features work end-to-end (self-signup approval, gold column highlight)
4. Ensure cross-module triggers are reliable (shoot→dropper, dropper→calendar)
5. Validate bot mutation safety (confirmation protocol, no hallucination)

---

## 2. TEST STACK

| Layer | Tool | Configuration |
|-------|------|--------------|
| Unit + Integration | Vitest | `apps/api/vitest.config.ts` + real PostgreSQL (Docker) |
| Frontend component | Vitest + Testing Library | `apps/web/vitest.config.ts` |
| E2E (critical journeys) | Playwright | `playwright.config.ts` — Chromium + WebKit |
| Performance / Load | k6 | `tests/k6/` — deployed against staging |
| Type checking | TypeScript tsc | Runs in CI before any test |

---

## 3. COVERAGE TARGETS

| Layer | Minimum Coverage | Priority Focus |
|-------|-----------------|----------------|
| Service layer (API) | ≥ 85% | Business rules, RBAC, data integrity |
| Route handlers | ≥ 70% | Happy path + each error type |
| Frontend hooks | ≥ 80% | useColumnHighlight, useMonthContext |
| Utilities (shared) | 100% | Date helpers, period calculations |

---

## 4. UNIT TESTS (VITEST — SERVICE LAYER)

### 4.1 Rollover Service — Critical Tests

```typescript
describe('RolloverService', () => {
  test('idempotency: exits cleanly if period already exists', async () => {
    await db.insertInto('months').values({ period: '2025-06', label: 'June 2025' }).execute();
    const txSpy = vi.spyOn(db, 'transaction');
    await RolloverService.run('2025-06');
    expect(txSpy).not.toHaveBeenCalled();
  });

  test('new month AND prior month lock commit in same transaction', async () => {
    await RolloverService.run('2025-06');
    const june = await db.selectFrom('months').where('period', '=', '2025-06').executeTakeFirst();
    const may  = await db.selectFrom('months').where('period', '=', '2025-05').executeTakeFirst();
    expect(june).toBeDefined();
    expect(may?.locked).toBe(true);
  });

  test('full rollback if any step fails mid-transaction', async () => {
    vi.spyOn(AttendanceService, 'generateForPeriod').mockRejectedValue(new Error('DB timeout'));
    await expect(RolloverService.run('2025-06')).rejects.toThrow();
    const june = await db.selectFrom('months').where('period', '=', '2025-06').executeTakeFirst();
    const may  = await db.selectFrom('months').where('period', '=', '2025-05').executeTakeFirst();
    expect(june).toBeUndefined();         // rolled back
    expect(may?.locked).toBe(false);      // rolled back
  });

  test('shoot slots generated without week_number field', async () => {
    await RolloverService.run('2025-06');
    const slots = await db.selectFrom('shoot_schedules').where('period', '=', '2025-06').selectAll().execute();
    expect(slots.length).toBeGreaterThan(0);
    slots.forEach(s => expect(Object.keys(s)).not.toContain('week_number'));
  });

  test('pipeline_status field does not exist in content_pipelines', async () => {
    await RolloverService.run('2025-06');
    const pipe = await db.selectFrom('content_pipelines').where('period', '=', '2025-06').executeTakeFirst();
    expect(Object.keys(pipe!)).not.toContain('pipeline_status');
  });
});
```

### 4.2 Task Service — Dependency Tests

```typescript
describe('TaskService', () => {
  test('blocks Done when dependency is not Done', async () => {
    const dep  = await createTask({ status: 'In Progress' });
    const task = await createTask({ dependency_id: dep.id });
    await expect(TaskService.updateStatus(managerId, task.id, 'Done', 1))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNRESOLVED' });
  });

  test('allows Done when dependency is Done', async () => {
    const dep  = await createTask({ status: 'Done' });
    const task = await createTask({ dependency_id: dep.id });
    const result = await TaskService.updateStatus(managerId, task.id, 'Done', 1);
    expect(result.status).toBe('Done');
  });

  test('team member cannot update unassigned task', async () => {
    const task = await createTask({ created_by: managerId });
    await expect(TaskService.updateStatus(teamMemberId, task.id, 'Done', 1))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
```

### 4.3 Content Dropper — Stage Sequence Tests

```typescript
describe('ContentDropperService', () => {
  test('rejects Finals before Raw is set', async () => {
    const pipeline = await createPipeline({ raw_received_at: null });
    await expect(ContentDropperService.markStage(pipeline.id, 'finals'))
      .rejects.toMatchObject({ code: 'STAGE_SEQUENCE_VIOLATION' });
  });

  test('fires calendar trigger when Posted', async () => {
    const spy = vi.spyOn(ContentCalendarService, 'updateCell');
    const pipeline = await createPipeline({
      raw_received_at: new Date(), finals_ready_at: new Date()
    });
    await ContentDropperService.markStage(pipeline.id, 'posted');
    expect(spy).toHaveBeenCalledWith(
      pipeline.client_id, pipeline.period, expect.any(String), 'Posted', 'pipeline_trigger'
    );
  });
});
```

### 4.4 Bot Permission Guard Tests

```typescript
describe('BotPermissionGuard', () => {
  test('denies mutation tool for team_member with no override', () => {
    expect(canUseTool('create_task', 'team_member', [])).toBe(false);
  });

  test('allows mutation tool for team_member with explicit TRUE override', () => {
    const overrides = [{ permission_key: 'bot.tool.create_task', value: true }];
    expect(canUseTool('create_task', 'team_member', overrides)).toBe(true);
  });

  test('denies for manager with explicit FALSE override', () => {
    const overrides = [{ permission_key: 'bot.tool.deactivate_client', value: false }];
    expect(canUseTool('deactivate_client', 'manager', overrides)).toBe(false);
  });
});
```

### 4.5 useColumnHighlight Hook Tests

```typescript
describe('useColumnHighlight', () => {
  test('sets activeColumnId on focus', () => {
    const { result } = renderHook(() => useColumnHighlight('col-sohail'));
    act(() => result.current.onFocus());
    expect(useColumnHighlightStore.getState().activeColumnId).toBe('col-sohail');
  });

  test('clears activeColumnId on blur', () => {
    const { result } = renderHook(() => useColumnHighlight('col-sohail'));
    act(() => result.current.onFocus());
    act(() => result.current.onBlur());
    expect(useColumnHighlightStore.getState().activeColumnId).toBeNull();
  });

  test('last focused column wins when two cells focused', () => {
    const { result: r1 } = renderHook(() => useColumnHighlight('col-sohail'));
    const { result: r2 } = renderHook(() => useColumnHighlight('col-naaz'));
    act(() => r1.current.onFocus());
    act(() => r2.current.onFocus());
    expect(useColumnHighlightStore.getState().activeColumnId).toBe('col-naaz');
  });
});
```

---

## 5. INTEGRATION TESTS (VITEST + DOCKER POSTGRESQL)

### 5.1 Cross-Module Trigger Tests

```typescript
test('shoot confirmed triggers content_pipelines.coming_shoot_date update', async () => {
  const slot = await createShootSlot({ slot_status: 'Scheduled', slot_date: '2025-06-20' });
  await ShootPlannerService.confirmSlot(managerId, slot.id, '2025-06-20', 1);
  const pipeline = await db.selectFrom('content_pipelines')
    .where('client_id', '=', slot.client_id).where('period', '=', '2025-06')
    .executeTakeFirst();
  expect(pipeline?.coming_shoot_date).toBe('2025-06-20');
  expect(pipeline?.coming_shoot_source).toBe('trigger');
});

test('pipeline posted triggers content_calendar cell to Posted', async () => {
  const pipeline = await createPipeline({
    raw_received_at: new Date(), finals_ready_at: new Date()
  });
  await ContentDropperService.markStage(pipeline.id, 'posted');
  const today = format(new Date(), 'yyyy-MM-dd');
  const cell = await db.selectFrom('content_calendar')
    .where('client_id', '=', pipeline.client_id).where('date', '=', today)
    .executeTakeFirst();
  expect(cell?.status).toBe('Posted');
  expect(cell?.source).toBe('pipeline_trigger');
});
```

### 5.2 Optimistic Lock Tests

```typescript
test('PATCH content_calendar returns 409 STALE_DATA with stale version', async () => {
  const cell = await createCalendarCell({ version: 3 });
  const token = await getTestToken({ role: 'manager' });
  const res = await inject({
    method: 'PATCH',
    url: `/v1/content-calendar/${cell.id}`,
    payload: { status: 'Posted', version: 2 },  // stale
    headers: { authorization: `Bearer ${token}` }
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('STALE_DATA');
  expect(res.json().error.details.currentVersion).toBe(3);
});
```

### 5.3 Freelancer Data Isolation Tests (audit M-07)

```typescript
test('freelancer receives only their own shoot slots', async () => {
  const freelancer1 = await createStaff({ role: 'freelancer' });
  const freelancer2 = await createStaff({ role: 'freelancer' });
  const slot1 = await createShootSlot({ freelancer_id: freelancer1.id });
  const slot2 = await createShootSlot({ freelancer_id: freelancer2.id });
  const slot3 = await createShootSlot({ freelancer_id: null });  // unassigned
  const token = await getTestToken({ role: 'freelancer', staffId: freelancer1.id });
  const res = await inject({
    method: 'GET', url: '/v1/shoot-planner?period=2025-06',
    headers: { authorization: `Bearer ${token}` }
  });
  const ids = res.json().data.map(s => s.id);
  expect(ids).toContain(slot1.id);       // own slot — visible
  expect(ids).not.toContain(slot2.id);   // another freelancer's slot — blocked
  expect(ids).not.toContain(slot3.id);   // unassigned — not visible to any freelancer
});

test('freelancer cannot fetch attendance grid', async () => {
  const freelancer = await createStaff({ role: 'freelancer' });
  const token = await getTestToken({ role: 'freelancer', staffId: freelancer.id });
  const res = await inject({
    method: 'GET', url: '/v1/attendance?period=2025-06',
    headers: { authorization: `Bearer ${token}` }
  });
  expect(res.statusCode).toBe(403);
});

test('freelancer cannot view content-dropper', async () => {
  const freelancer = await createStaff({ role: 'freelancer' });
  const token = await getTestToken({ role: 'freelancer', staffId: freelancer.id });
  const res = await inject({
    method: 'GET', url: '/v1/content-dropper?period=2025-06',
    headers: { authorization: `Bearer ${token}` }
  });
  expect(res.statusCode).toBe(403);
});
```

---

### 5.4 Month Lock Tests

```typescript
test('PATCH attendance returns 423 when period is locked', async () => {
  await db.updateTable('months').set({ locked: true }).where('period', '=', '2025-04').execute();
  const log = await db.selectFrom('attendance_logs').where('period', '=', '2025-04').executeTakeFirst();
  const res = await inject({
    method: 'PATCH', url: `/v1/attendance/${log!.id}`,
    payload: { present: true, version: 1 }
  });
  expect(res.statusCode).toBe(423);
  expect(res.json().error.code).toBe('PERIOD_LOCKED');
});
```

### 5.4 Signup Request Tests

```typescript
test('rejection_note is never included in rejection notification payload', async () => {
  const requestId = await createSignupRequest();
  const notificationSpy = vi.spyOn(NotificationService, 'create');
  await SignupService.reject(adminId, requestId, {
    rejectionNote: 'Internal reason only admins see',
    publicRejectionMessage: 'Not approved at this time'
  });
  const notificationPayload = notificationSpy.mock.calls[0][1];
  expect(JSON.stringify(notificationPayload)).not.toContain('Internal reason only admins see');
  expect(JSON.stringify(notificationPayload)).toContain('Not approved at this time');
});

test('admin role cannot be self-requested in signup form', async () => {
  const res = await inject({
    method: 'POST', url: '/v1/auth/signup/request',
    payload: { name: 'Test', email: 't@t.com', dateOfBirth: '1990-01-01',
               mobileNumber: '+91-9876543210', roleRequested: 'admin' }
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('INVALID_ROLE');
});
```

---

## 6. E2E TESTS (PLAYWRIGHT)

### 6.1 Test Configuration

```typescript
// playwright.config.ts
export default defineConfig({
  baseURL: 'https://staging.skaly.in',
  use: { viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
  timeout: 30000,
  expect: { timeout: 10000 },
});
```

### 6.2 Critical Journey E2E Tests

```typescript
test('self-signup with all 6 fields → admin approves → user logs in', async ({ page, browser }) => {
  // User submits signup
  await page.goto('/signup');
  await page.fill('[name="name"]', 'Test Freelancer');
  await page.fill('[name="email"]', 'tf@test.com');
  await page.fill('[name="dateOfBirth"]', '1995-05-20');
  await page.fill('[name="mobileNumber"]', '+91-9988776655');
  await page.selectOption('[name="roleRequested"]', 'freelancer');
  await page.click('[data-testid="submit-signup"]');
  await expect(page).toHaveURL(/\/signup\/pending/);

  // Admin approves in separate context
  const adminCtx  = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await loginAsAdmin(adminPage);
  await adminPage.goto('/settings/signup-requests');
  await adminPage.click(`text=Test Freelancer`);
  await adminPage.click('[data-testid="approve-request"]');
  await adminPage.click('[data-testid="confirm-approve"]');
  await expect(adminPage.getByText('Account created')).toBeVisible();

  // User can now log in
  await page.goto('/login');
  await loginWithEmail(page, 'tf@test.com', 'password');
  await expect(page).toHaveURL(/\/home/);
});

test('gold column highlight activates on cell focus and clears on blur', async ({ page }) => {
  await loginAsManager(page);
  await page.goto('/attendance');
  const cell    = page.getByTestId('attendance-cell-sohail-day-1');
  const overlay = page.getByTestId('column-highlight-sohail');
  await cell.focus();
  await expect(overlay).toBeVisible();
  await cell.blur();
  await expect(overlay).not.toBeVisible();
});

test('shoot confirmed triggers Content Dropper update in real time', async ({ page }) => {
  await loginAsManager(page);
  await page.goto('/shoot-planner');
  await page.click('[data-testid="slot-unset-naaz-1"]');
  await page.fill('[data-testid="slot-date-picker"]', '2025-06-20');
  await page.click('[data-testid="slot-confirm-btn"]');
  await expect(page.getByRole('alert')).toContainText('Shoot confirmed. Content Dropper updated.');
  await page.goto('/content-dropper');
  await expect(page.getByTestId('coming-shoot-naaz')).toContainText('Jun 20');
});

test('bot mutation requires confirmation before executing', async ({ page }) => {
  await loginAsManager(page);
  await page.goto('/bot');
  await page.fill('[data-testid="bot-input"]', 'Create a task for Sohail to edit the Naaz reel, due Friday');
  await page.press('[data-testid="bot-input"]', 'Enter');
  await expect(page.getByTestId('bot-last-message')).toContainText('Shall I go ahead?');

  // Verify task NOT created yet
  await page.goto('/tasks');
  await expect(page.getByText('edit the Naaz reel')).not.toBeVisible();
});

test('rollover manual trigger initialises new period', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/settings/months');
  await page.click('[data-testid="trigger-manual-rollover"]');
  await page.click('[data-testid="confirm-rollover"]');
  await expect(page.getByText('initialised successfully')).toBeVisible({ timeout: 60_000 });
});
```

---

## 7. PERFORMANCE TESTS (k6)

```javascript
// tests/k6/content-calendar.js — run against staging
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    load_test: { executor: 'constant-vus', vus: 50, duration: '2m' },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],  // p95 < 500ms
    http_req_failed:   ['rate<0.01'],  // < 1% errors
  },
};

export default function() {
  const res = http.get(`${BASE_URL}/v1/content-calendar?period=2025-06`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  check(res, { 'status 200': (r) => r.status === 200 });
}
```

### Performance Test Targets

| Test | Concurrent Users | Target |
|------|-----------------|--------|
| Content Calendar full load | 50 | p95 < 500ms |
| CMD+K search | 50 | p95 < 150ms |
| Bot query — TTFT (Haiku dev, CI gate) | 10 | p95 < 2s |
| Bot query — full completion (Haiku dev, CI gate) | 10 | p95 < 4s |
| Bot query — TTFT (Sonnet prod, pre-launch one-time) | 10 | p95 < 2s |
| Bot query — full completion (Sonnet prod, pre-launch one-time) | 10 | p95 < 8s |

> **Production Sonnet performance validation (audit L-04):** k6 tests in CI run against staging with Haiku (the dev model). Before launch, run a one-time manual k6 burst against production with the Sonnet model (10 concurrent users, 100 total requests). This is a launch checklist item, NOT a recurring CI gate — production rate limits and cost would make continuous Sonnet load testing wasteful. Document the observed p95 in the launch report.
| Manual rollover | 1 | < 60 seconds total |
| WebSocket message delivery | 50 simultaneous | < 500ms |

---

## 8. CI INTEGRATION

```yaml
# Test stages in GitHub Actions CI
steps:
  - run: pnpm -r exec tsc --noEmit                # TypeScript compile check
  - run: pnpm -r exec eslint .                     # Lint
  - run: pnpm --filter api db:migrate:test         # Run migrations on test DB
  - run: pnpm --filter api exec vitest run --coverage   # Unit + integration tests
  - run: pnpm --filter web exec vitest run         # Frontend hook tests
  # E2E only on staging (post-merge, not on PR):
  - run: pnpm exec playwright test                 # E2E on staging (post-deploy step)
```

Coverage reports uploaded to CI artifacts. PRs blocked if coverage drops below targets.
