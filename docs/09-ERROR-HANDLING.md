# 09 — ERROR HANDLING SPECIFICATION
## Skaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** TRD §5.2, API-CONTRACT §1.2, TESTING-STRATEGY §5

---

## 1. ERROR RESPONSE FORMAT

All API error responses follow a single consistent shape:

```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable explanation",
    "details": {}
  }
}
```

`details` is optional but present for validation errors (field-level errors), conflict errors (current version + who updated), and dependency errors (the blocking task).

---

## 2. ERROR CODE REGISTRY

### Authentication

| Code | HTTP | When |
|------|------|------|
| `UNAUTHORIZED` | 401 | JWT missing or invalid signature |
| `TOKEN_EXPIRED` | 401 | JWT has expired — client should attempt silent refresh |
| `ACCOUNT_DEACTIVATED` | 401 | Staff account has been deactivated by an admin |
| `MFA_REQUIRED` | 403 | Admin/Manager must complete MFA enrollment before proceeding |
| `MFA_FAILED` | 403 | Incorrect TOTP code, or a recovery code that is invalid or already spent |
| `MFA_LOCKED` | 403 | 3 failed MFA attempts — 15-minute lockout. **One budget across every credential type**: TOTP and recovery-code failures share the counter, so 2 bad TOTP + 1 bad recovery code locks. A per-type counter would be a bypass dressed as a lockout |
| `PERMISSION_DENIED` | 403 | Role or per-user override blocks this action |
| `INVITE_EXPIRED` | 400 | Invite link is older than 24 hours |
| `INVITE_ALREADY_USED` | 400 | Invite link has already been consumed |

### Period / Month Lock

| Code | HTTP | When |
|------|------|------|
| `PERIOD_LOCKED` | 423 | Write attempted on a locked period |
| `PERIOD_NOT_FOUND` | 404 | Requested period does not exist in months table |
| `UNLOCK_REASON_REQUIRED` | 400 | Unlock attempt missing required `reason` field |
| `ALREADY_PROCESSED` | 409 | Signup request already approved or rejected, or a staff row already exists for this email (duplicate resource) |

### Data Integrity

| Code | HTTP | When |
|------|------|------|
| `VALIDATION_ERROR` | 400 | Zod schema validation failed — `details.fields` lists per-field errors |
| `STALE_DATA` | 409 | Version mismatch in optimistic lock — `details.currentVersion` + `details.updatedBy` |
| `DEPENDENCY_UNRESOLVED` | 400 | Task cannot be Done — dependency task not Done yet |
| `STAGE_SEQUENCE_VIOLATION` | 400 | Pipeline stage order violated |
| `SHOOT_RESET_CONFIRMATION_REQUIRED` | 400 | Reset endpoint called without `{ confirm: true }` |
| `CLIENT_SHOOT_SLOTS_REQUIRED` | 400 | Client creation missing `shoot_slots_per_month` |
| `RESOURCE_NOT_FOUND` | 404 | Resource does not exist or has been soft-deleted |
| `RESOURCE_EXPIRED` | 410 | The row exists but its stored object is gone — a report past R2's 30-day lifecycle rule. Distinct from 404 so the UI can offer `[Regenerate]` instead of "not found" (Sprint 11, `07-API-CONTRACT.md` §Reports) |

### File Upload

| Code | HTTP | When |
|------|------|------|
| `FILE_TOO_LARGE` | 400 | File exceeds 50MB per-file limit |
| `TASK_ATTACHMENT_LIMIT_EXCEEDED` | 400 | Total attachments exceed 200MB per task |
| `INVALID_FILE_TYPE` | 400 | MIME type not in allowed list (PDF, JPG, PNG, MP4, MOV) |
| `INVALID_ROLE` | 400 | Role value not in allowed enum (e.g., 'admin' in self-signup) |

### Bot

| Code | HTTP | When |
|------|------|------|
| `BOT_TOOL_DENIED` | 403 | User does not have permission for the requested bot tool |
| `ANTHROPIC_ERROR` | 503 | Anthropic API unavailable after internal retry |

### Rate Limiting & Server

| Code | HTTP | When |
|------|------|------|
| `RATE_LIMIT_EXCEEDED` | 429 | Rate limit hit — `Retry-After` header included |
| `INTERNAL_ERROR` | 500 | Unexpected failure — `details.traceId` provided for support |
| `DATABASE_UNAVAILABLE` | 503 | PostgreSQL connection failed |
| `CACHE_UNAVAILABLE` | 503 | Redis connection failed — graceful DB fallback where possible |

---

## 3. DETAILED ERROR RESPONSE EXAMPLES

### STALE_DATA (409)
```json
{
  "error": {
    "code": "STALE_DATA",
    "message": "This record was updated while you were editing. Please refresh.",
    "details": {
      "currentVersion": 7,
      "updatedBy": { "staffId": "uuid", "name": "Naaz Ali" },
      "updatedAt": "2025-06-01T09:32:11Z"
    }
  }
}
```

### DEPENDENCY_UNRESOLVED (400)
```json
{
  "error": {
    "code": "DEPENDENCY_UNRESOLVED",
    "message": "Cannot mark as Done — the dependency task must be completed first.",
    "details": {
      "dependencyTask": {
        "id": "uuid",
        "description": "Edit Lavish Furniture reel",
        "status": "In Progress"
      }
    }
  }
}
```

### VALIDATION_ERROR (400)
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": {
      "fields": [
        { "field": "dateOfBirth", "message": "Must be a valid past date" },
        { "field": "mobileNumber", "message": "Must include country code (e.g. +91-9876543210)" }
      ]
    }
  }
}
```

---

## 4. FASTIFY GLOBAL ERROR HANDLER

```typescript
app.setErrorHandler((error, request, reply) => {
  // Known application errors (AppError subclass)
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details ?? undefined }
    });
  }

  // Zod validation errors (from Fastify schema validation)
  if (error.validation) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: { fields: error.validation.map(v => ({ field: v.instancePath, message: v.message })) }
      }
    });
  }

  // Rate limit (@fastify/rate-limit)
  if (error.statusCode === 429) {
    reply.header('Retry-After', error.retryAfter);
    return reply.status(429).send({
      error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please slow down.' }
    });
  }

  // Unexpected — sanitise and log
  const traceId = crypto.randomUUID();
  logger.error({ err: error, traceId, url: request.url }, 'Unhandled error');
  return reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      details: { traceId }
    }
  });
});
```

---

## 5. FRONTEND ERROR HANDLING

### 5.1 Mutation Error Routing (TanStack Query)
```typescript
function handleMutationError(error: AppError) {
  switch (error.code) {
    case 'PERIOD_LOCKED':
      showToast({ type: 'info', message: 'This period is locked — read only.' });
      break;
    case 'STALE_DATA':
      showInlineConflict({
        message: `Updated by ${error.details.updatedBy.name}`,
        action: { label: 'Refresh row →', onClick: () => queryClient.invalidateQueries(currentKey) }
      });
      break;
    case 'DEPENDENCY_UNRESOLVED':
      showDependencyBadge({ task: error.details.dependencyTask });
      break;
    case 'STAGE_SEQUENCE_VIOLATION':
      triggerShakeAnimation(cellRef);
      showToast({ type: 'warning', message: 'Complete the previous stage first.' });
      break;
    case 'PERMISSION_DENIED':
      showToast({ type: 'error', message: "You don't have permission for that action." });
      break;
    case 'RATE_LIMIT_EXCEEDED':
      showToast({ type: 'warning', message: 'Too many requests — please wait a moment.' });
      break;
    default:
      showToast({ type: 'error', message: 'Save failed. Changes reverted.' });
  }
}
```

### 5.2 Module Error Boundary
When a module's data fetch fails after all TanStack Query retries:
- Skaly logo mark (48px, white/30, centred)
- "Something went wrong loading [Module Name]"
- "This may be a temporary issue."
- [Try again] gold CTA (triggers query refetch)
- Trace ID in DM Mono at bottom (from error.details.traceId)

Each module has its own boundary — failures are isolated. Other modules continue working.

### 5.3 Session Expiry Recovery
```typescript
// TanStack Query global error handler
queryClient.setDefaultOptions({
  queries: {
    retry: (failureCount, error) => {
      if (error?.statusCode === 401) return false; // don't retry auth failures
      return failureCount < 3;
    }
  }
});

// On 401 TOKEN_EXPIRED:
// 1. Attempt silent refresh: POST /v1/auth/refresh
// 2. If successful: retry original request with new token
// 3. If refresh fails: router.push('/login')
```

### 5.4 Network Drop Recovery
```
Mutation fails with network error:
  → TanStack Query optimistic update reverts to last server value
  → Save indicator dot turns red
  → Toast: "Save failed — changes reverted. Check connection."
  → TanStack Query retry: 1s, 2s, 4s exponential backoff (3 retries)
  → If retry succeeds: re-applies the intended change
  → If all fail: "Unable to save. Try again when reconnected."

WebSocket disconnect:
  → Socket.io reconnects: 1s → 2s → 4s → 8s... max 30s between attempts
  → Reconnecting banner (amber badge, non-blocking)
  → Client re-emits room:join and AWAITS the server acknowledgement
  → Only then are stale queries refetched — events arriving during the refetch
    are buffered and replayed onto the result (ADR-025)
  → Banner clears on ACK, not on connect
```

> **⚠️ Amended in Sprint 10.1 — see ADR-025.**
>
> This section previously read *"On reconnect: all stale TanStack Query data
> refetched"*, and that instruction is unsafe. It describes invalidate-on-connect,
> which carries a race **on every reconnect**: the refetch is issued before
> membership is re-established, so it can resolve from a server snapshot taken
> *before* an event that arrived in the meantime, and overwrite it.
>
> It was tried during Sprint 10 exactly as written here, and it made the failure
> worse rather than better — the race moved later and became rarer, so it stopped
> failing the test suite and started reaching users as an unreproducible "it
> sometimes doesn't update".
>
> **'connect' is a transport signal, not a subscription signal.** Between the two
> the client is connected but not yet in any room, which is why the banner must
> clear on the ack: clearing on connect tells the user they are live while
> broadcasts are still landing nowhere.
>
> Mount and reconnect are the same mechanism, used twice.

---

## 6. BOT ERROR COMMUNICATION

The bot must never expose technical error codes or stack traces.

| Internal Error | Bot User Response |
|----------------|------------------|
| `PERIOD_LOCKED` | "I can't update that record — [Month] is locked. Ask an admin to unlock it if a correction is needed." |
| `PERMISSION_DENIED` | "I don't have permission to [action] on your behalf. Ask an admin to update your bot access settings." |
| `DEPENDENCY_UNRESOLVED` | "I can't mark that task as Done — it depends on '[dependency name]' which isn't finished yet." |
| `STAGE_SEQUENCE_VIOLATION` | "I can't mark that stage as complete — the previous stage hasn't been done yet." |
| `ANTHROPIC_ERROR` | "I'm having trouble connecting right now. Please try again in a moment." |
| Any unhandled error | "Something went wrong. Please try again or make the change directly in the portal." |

---

## 7. ROLLOVER FAILURE AI SUMMARY

When rollover fails after all 3 retries, Claude Sonnet generates a plain-language summary for admins:

```typescript
const { content } = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 400,
  system: `Write a calm, plain-language incident summary for a non-technical business owner.
           Explain: what happened, whether any data was affected, and what they should do next.
           No technical jargon. 3-5 sentences maximum.`,
  messages: [{
    role: 'user',
    content: `Rollover for period ${period} failed at step "${failedStep}".
              Error: ${error.message}. Attempt ${attempt} of 3.`
  }]
});
// Deliver as rollover_failed notification to all admins
// Full text — no truncation. Red tint. Inline [Manual rollover] button.
```
