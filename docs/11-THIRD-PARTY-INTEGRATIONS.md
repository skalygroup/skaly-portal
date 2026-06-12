# 11 — THIRD-PARTY INTEGRATION SPECIFICATION
## Scaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** TRD §2.3-2.4, TRD §12-13, INFRA §6, AUTH-MATRIX §10

---

## 1. INTEGRATION INVENTORY

| Service | Purpose | Phase | Criticality |
|---------|---------|-------|-------------|
| Supabase Auth | JWT, Google OAuth, TOTP/MFA | MVP | 🔴 Critical |
| Anthropic API | AI Management Bot (Sonnet 4.6 + Haiku 4.5) | MVP | 🟠 High |
| Cloudflare R2 | File storage — attachments, CVs, PDFs, backups | MVP | 🟠 High |
| Upstash Redis | Sessions, cache, presence state | MVP | 🟠 High |
| Railway | Hosting — API server, PostgreSQL, cron | MVP | 🔴 Critical |
| Vercel | Frontend hosting, CDN | MVP | 🔴 Critical |
| Google Fonts | Big Shoulders Display + DM Sans + DM Mono | MVP | 🟡 Medium |
| Expo Notifications | Mobile push (abstraction over FCM/APNs) | Phase 2 | 🟡 Medium |
| FCM (Firebase) | Android push notifications | Phase 2 | 🟡 Medium |
| APNs (Apple) | iOS push notifications | Phase 2 | 🟡 Medium |

---

## 2. SUPABASE AUTH

**Role in portal:** Token provider only. Supabase manages auth.users. No Supabase DB tables are used for operational data — all data lives in Railway PostgreSQL.

### 2.1 Supabase Setup
```
Dashboard URL: app.supabase.com → Project: skaly-portal
Auth providers enabled: Email/Password, Google OAuth, TOTP
JWT expiry: 3600s (1 hour)
Refresh token expiry: 604800s (7 days)
Redirect URLs: https://portal.skaly.in/**, http://localhost:3000/**
```

### 2.2 Backend Integration
```typescript
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// JWT verification in auth plugin
const { data: { user }, error } = await supabase.auth.getUser(bearerToken);
if (error || !user) throw new UnauthorizedError();

// Create user during signup
const { data, error } = await supabase.auth.admin.createUser({
  email, password,
  email_confirm: true  // pre-confirmed for invite flow
});

// Invite by email
const { error } = await supabase.auth.admin.inviteUserByEmail(email, {
  redirectTo: `https://portal.skaly.in/signup?token=${inviteToken}`,
});

// Revoke sessions (on deactivation)
await supabase.auth.admin.signOut(userId);
```

### 2.3 TOTP/MFA
```typescript
// Enroll factor
const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
// data.totp.qr_code → render as QR for user
// data.totp.secret → show for manual entry

// Verify enrollment
const { data, error } = await supabase.auth.mfa.challengeAndVerify({
  factorId: data.id,
  code: userInputCode
});
// On success: staff.mfa_enrolled = TRUE in Railway PostgreSQL
```

### 2.4 Graceful Degradation
Supabase Auth unavailable → API returns 503 `SUPABASE_UNAVAILABLE` → Frontend: "Sign-in is temporarily unavailable. Please try again shortly."

---

## 3. ANTHROPIC API

**Role:** Powers the AI Management Bot with tool-calling. All operational queries and mutations go through the Anthropic API.

### 3.1 Model Selection (Environment-Driven)
```typescript
const model = process.env.NODE_ENV === 'production'
  ? 'claude-sonnet-4-6'           // Production — reliable tool-calling
  : 'claude-haiku-4-5-20251001';  // Dev/test — 10× cheaper, same tool schema
```
**Why Sonnet in production:** The bot makes real database writes. A wrong tool call (wrong clientId, wrong date) corrupts production data. Sonnet's higher instruction-following accuracy significantly reduces mis-parameterised tool calls.

### 3.2 API Call Pattern
```typescript
const response = await anthropic.messages.create({
  model,
  max_tokens: 1024,
  system: buildSystemPrompt(staffContext),
  tools: filteredToolDefinitions,
  messages: sessionHistory,
});

// Check for tool_use blocks
const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
// Execute each tool, collect tool_result, second API call if needed
```

### 3.3 Cost Control
- Bot endpoint rate limit: 30 requests/minute per user (`@fastify/rate-limit`)
- `max_tokens: 1024` — sufficient for all bot responses
- Monthly spend cap: set in Anthropic console
- dev/test always uses Haiku (10× cheaper)

### 3.4 Retry on 429/529
```typescript
async function callWithRetry(params, retries = 3): Promise<Message> {
  for (let i = 0; i < retries; i++) {
    try { return await anthropic.messages.create(params); }
    catch (e) {
      if ([429, 529].includes(e.status)) {
        await sleep(Math.pow(2, i) * 1000);
        continue;
      }
      throw new AppError('ANTHROPIC_ERROR', 503, 'AI service temporarily unavailable');
    }
  }
  throw new AppError('ANTHROPIC_ERROR', 503, 'AI service temporarily unavailable');
}
```

---

## 4. CLOUDFLARE R2

**Role:** Object storage for all binary files — task attachments, staff CVs, generated PDFs, and DB backups.

### 4.1 Configuration
```
Bucket names: skaly-portal-prod (production), skaly-portal-staging (staging)
Public access: DISABLED — all access via presigned URLs
Versioning: enabled on both buckets (90-day version retention)
```

### 4.2 SDK Setup
```typescript
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});
```

### 4.3 Presigned URL Expiry Policy

> **Fix applied (Gemini audit):** PUT expiry increased from 5 to **15 minutes**. A 50MB MP4 at 500kbps takes ~13 minutes to upload — 5 minutes was insufficient and would silently time out large video attachments.

| Operation | Expiry | Used For | Rationale |
|-----------|--------|---------|-----------|
| PUT upload | **15 minutes** | Task attachment upload, CV upload | Covers 50MB video on a 500kbps office connection (~13 min) with safety margin |
| GET download | 1 hour | Attachment download, CV view, report download | Sufficient for interactive download; limits stale-link exposure |
| GET report | 24 hours | Initial download link after PDF generation | Notification links must survive a full working day |

```typescript
// Use these named constants for all getSignedUrl calls — never hardcode 300
const UPLOAD_EXPIRY_SECONDS   = 900;   // 15 minutes — safe for 50MB video on slow network
const DOWNLOAD_EXPIRY_SECONDS = 3600;  // 1 hour
const REPORT_EXPIRY_SECONDS   = 86400; // 24 hours
```

### 4.4 CORS (for browser PUT uploads)
```json
[{
  "AllowedOrigins": ["https://portal.skaly.in", "http://localhost:3000"],
  "AllowedMethods": ["PUT"],
  "AllowedHeaders": ["Content-Type", "Content-Length"],
  "MaxAgeSeconds": 3600
}]
```

---

## 5. UPSTASH REDIS

**Role:** Bot session history, presence state, RBAC permission cache, JWT staff lookup cache.

### 5.1 Connection
```typescript
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL, {
  tls: {},
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  lazyConnect: true,
  enableReadyCheck: true,
});
redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error — falling back to DB where possible');
});
```

### 5.2 Key Registry
| Key | Type | TTL | Content |
|-----|------|-----|---------|
| `bot:session:{staffId}` | string (JSON) | 12 hours | Conversation array, 50-turn limit |
| `perms:{staffId}` | string (JSON) | 5 minutes | Permission override array |
| `staff_lookup:{supabaseUid}` | string (JSON) | 5 minutes | Staff row snapshot |
| `presence:{staffId}` | string "1" | 60 seconds | Online/offline indicator |

---

## 6. GOOGLE FONTS

**Three fonts required — all loaded at app startup via `next/font/google`.**

```typescript
// app/layout.tsx
import { Big_Shoulders_Display, DM_Sans, DM_Mono } from 'next/font/google';

const bigShoulders = Big_Shoulders_Display({
  subsets: ['latin'], display: 'swap',
  weight: ['400','600','700'], variable: '--font-big-shoulders',
});
const dmSans = DM_Sans({
  subsets: ['latin'], display: 'swap',
  weight: ['400','500','600'], variable: '--font-dm-sans',
});
const dmMono = DM_Mono({
  subsets: ['latin'], display: 'swap',
  weight: ['400','500'], variable: '--font-dm-mono',
});
```

**Mobile (React Native / Phase 2):** Fonts loaded via `expo-google-fonts`:
```typescript
import { useFonts, BigShouldersDisplay_700Bold } from '@expo-google-fonts/big-shoulders-display';
import { DMSans_400Regular, DMSans_600SemiBold } from '@expo-google-fonts/dm-sans';
import { DMMono_400Regular } from '@expo-google-fonts/dm-mono';
```

---

## 7. EXPO PUSH NOTIFICATIONS (PHASE 2)

**Expo Push API** is the recommended approach for MVP mobile launch — it abstracts FCM and APNs behind a single endpoint, handling routing and delivery for both platforms.

### 7.1 Token Registration (Mobile App)
```typescript
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

async function registerPushToken() {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return;

  const token = await Notifications.getExpoPushTokenAsync({
    projectId: Constants.expoConfig?.extra?.eas?.projectId,
  });

  // Register with portal API
  await api.patch('/v1/staff/me/push-token', {
    pushToken: token.data,
    platform: Platform.OS  // 'ios' | 'android'
  });
}
```

### 7.2 Server-Side Push Delivery
```typescript
// apps/api/src/lib/push.ts
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export async function sendExpoPush(staffId: string, payload: PushPayload): Promise<void> {
  const { push_token, push_platform } = await getStaffById(staffId);
  if (!push_token) return;  // no token — in-app Socket.io already delivered it

  const result = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      to: push_token,
      title: payload.title,
      body: payload.message,
      data: { notificationId: payload.id, link: payload.link },
      priority: 'high',
    }),
  }).then(r => r.json());

  // Handle DeviceNotRegistered: token is stale — clear from DB
  if (result.data?.status === 'error' && result.data?.details?.error === 'DeviceNotRegistered') {
    await db.updateTable('staff')
      .set({ push_token: null, push_platform: null })
      .where('id', '=', staffId).execute();
  }
}
```

---

## 8. FCM — FIREBASE CLOUD MESSAGING (PHASE 2, DIRECT)

For production-scale Android push (bypassing Expo Push API):

```
Firebase project: skaly-portal-prod
Android app registered: in.skaly.portal
google-services.json: placed in apps/mobile/android/app/
API: FCM HTTP v1 — POST https://fcm.googleapis.com/v1/projects/skaly-portal-prod/messages:send
Auth: Service account JWT (stored in Railway secrets — never in code)
```

---

## 9. APNS — APPLE PUSH NOTIFICATION SERVICE (PHASE 2, DIRECT)

For production-scale iOS push (bypassing Expo Push API):

```
Apple Developer account: Skaly Group
App ID: in.skaly.portal
Push Notifications capability: enabled
APNs Auth Key (.p8): stored in Railway secrets only (NEVER in git)
Auth: JWT with Key ID + Team ID (preferred over certificate)
APS environment: development (Xcode builds), production (TestFlight + App Store)
HTTP/2 endpoint: api.push.apple.com:443
```

---

## 10. INTEGRATION FAILURE MODES

| Integration | Failure | Portal Impact | Mitigation |
|-------------|---------|--------------|-----------|
| Supabase Auth | Down | Login blocked | Supabase 99.9% SLA; in-session users unaffected |
| Anthropic API | Down | Bot unavailable | User-friendly message; portal fully operational |
| Cloudflare R2 | Down | File ops fail | Toast error; no data loss (DB rows intact) |
| Upstash Redis | Down | Slower API (DB fallback), no presence | Redis errors caught; graceful DB fallback |
| Railway PostgreSQL | Down | Full portal unavailable | 99.9% SLA + daily R2 backups; RTO < 2hr |
| Expo Push API | Down | No background push | In-app Socket.io still works for foreground |
