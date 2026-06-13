# 03 — UI/UX DESIGN SPECIFICATION
## Skaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** PRD §3, TRD §2.5, APPFLOW §1-20, AUTH-MATRIX §3

---

## 1. DESIGN PRINCIPLES

1. **Dark by default.** Every surface is dark. Gold is the only colour used for interaction.
2. **Data density without clutter.** Grids must hold many clients × many days. Whitespace is earned.
3. **Gold means action.** The 60/30/10 rule: 60% black, 30% white/grey, 10% gold. Gold never appears without meaning.
4. **Zero ambiguity for state.** Locked months, disabled cells, and read-only views must be visually unambiguous without tooltips.
5. **Speed over elegance.** Loading states are optimistic. Interactions feel instant.

---

## 2. COLOR SYSTEM — 60/30/10

### 2.1 Authoritative CSS Variables

```css
/* globals.css — single source of truth for all colours */
:root {
  /* Backgrounds — 60% black family */
  --bg-base:           #0D0D0F;
  --bg-surface:        #141417;
  --bg-elevated:       #1E1E23;
  --bg-hover:          #252529;
  --bg-selected:       #2A2A30;

  /* Borders */
  --border-subtle:     #2C2C33;
  --border-default:    #3A3A43;
  --border-strong:     #52525E;

  /* Text — 30% white family */
  --text-primary:      #F4F4F5;
  --text-secondary:    #A1A1AA;
  --text-muted:        #71717A;
  --text-disabled:     #3F3F46;

  /* Gold — 10% accent */
  --accent-gold:          #FDC257;
  --accent-gold-hover:    #FFD07A;
  --accent-gold-dim:      rgba(253, 194, 87, 0.12);   /* column highlight bg */
  --accent-gold-border:   rgba(253, 194, 87, 0.60);   /* column highlight border */
  --accent-gold-06:       rgba(253, 194, 87, 0.06);   /* today row */

  /* Status colours */
  --status-green:  #22C55E;   /* Posted, Done, Confirmed, Completed */
  --status-blue:   #3B82F6;   /* In Progress, Under Progress, Scheduled */
  --status-amber:  #F59E0B;   /* Pending, Awaiting */
  --status-red:    #EF4444;   /* Blocked, Delayed, Failed, Overdue */
  --status-teal:   #14B8A6;   /* Ready */
  --status-grey:   #6B7280;   /* Cancelled, Locked, No Activity, Rescheduled */
  --status-gold:   #FDC257;   /* Posted (calendar chip uses accent-gold) */

  /* shadcn/ui raw channel format */
  --background:        13 13 15;
  --foreground:        244 244 245;
  --primary:           253 194 87;
  --primary-foreground: 13 13 15;
  --muted:             30 30 35;
  --muted-foreground:  161 161 170;
  --border:            58 58 67;
  --radius:            1rem;

  /* Typography */
  --font-display: var(--font-big-shoulders);
  --font-body:    var(--font-dm-sans);
  --font-mono:    var(--font-dm-mono);
}
```

### 2.2 Usage Rules
- Gold (#FDC257) on dark backgrounds only — never on white or near-white
- Status colours used as chip/dot backgrounds at 15% opacity; text at full saturation
- Locked month cells: `--text-disabled` text on `--bg-base` background, no border

---

## 3. TYPOGRAPHY

### 3.1 Three-Font Stack (All Required)

| Font | CSS Variable | Used For |
|------|-------------|---------|
| **Big Shoulders Display** | `--font-display` | Page headings, module titles, large stat numbers, empty state headlines |
| **DM Sans** | `--font-body` | All UI text — labels, descriptions, button text, nav items, messages |
| **DM Mono** | `--font-mono` | All data — timestamps, IDs, table cell values, code blocks, file sizes, periods (e.g. "Jun 2025") |

### 3.2 Type Scale

| Role | Font | Size | Weight | Usage |
|------|------|------|--------|-------|
| Page title | Big Shoulders Display | 32px | 700 | Module heading (h1) |
| Section heading | Big Shoulders Display | 24px | 600 | Card headers, section labels |
| Stat number | Big Shoulders Display | 48px | 700 | Dashboard metrics |
| Body default | DM Sans | 14px | 400 | Most UI text |
| Body strong | DM Sans | 14px | 600 | Labels, active nav, button text |
| Caption | DM Sans | 12px | 400 | Timestamps (label), helper text |
| Data cell | DM Mono | 13px | 400 | All grid cell values |
| Data label | DM Mono | 12px | 500 | Period strings, IDs, file names |
| Code | DM Mono | 13px | 400 | Code blocks, API examples |

---

## 4. COMPONENT LIBRARY

### 4.1 Navigation Sidebar
- Width: 220px expanded / 56px icon-only (tablet: 768–1279px)
- Background: `--bg-surface`
- Active nav item: `box-shadow: inset 3px 0 0 var(--accent-gold)` (NOT border-left)
- Active text: `--accent-gold`
- Hover background: `--bg-hover`
- Logo: Big Shoulders Display, 18px, gold
- Icons: 20px, Lucide React

### 4.2 Grid Cell Types

| Type | Visual Treatment |
|------|-----------------|
| Editable | `--bg-elevated` background, `--border-default` border, pointer cursor |
| Read-only | `--bg-base` background, no border, default cursor, `--text-secondary` text |
| Locked | `<span>` rendered (no input), `--text-disabled` text, italic |
| Sunday | `--bg-base` background, `--text-disabled` text, cross-hatch pattern optional |
| Holiday | `rgba(253,194,87,0.06)` background, gold bottom border 1px |
| N/A (slot) | `--bg-base` background, `opacity: 0.15`, cursor not-allowed |
| Active (gold highlight) | `--accent-gold-dim` background, `--accent-gold-border` left/right borders |

### 4.3 Status Chips

```
Size: height 24px, padding 0 10px, border-radius 12px, DM Sans 12px/500
Background: status-colour at 15% opacity
Text: status-colour at 100%

Chip labels:
  No Activity    — grey chip (no chip rendered — cell is empty, no background)
  Under Progress — blue chip
  Ready          — teal chip
  Posted         — gold chip
  Pending        — amber chip
  Rescheduled    — grey chip
  To Do          — grey chip
  In Progress    — blue chip
  Blocked        — red chip
  Done           — green chip
  Cancelled      — grey chip (strikethrough text)
  Unset          — no chip (dashed border cell)
  Scheduled      — blue chip
  Confirmed      — gold chip
  Completed      — green chip
```

### 4.4 Gold Column Highlight (Amendment 2)

Full specification — applies to every editable grid in the portal.

```typescript
// hooks/useColumnHighlight.ts
import { create } from 'zustand'

interface Store {
  activeColumnId: string | null
  setActiveColumn: (id: string | null) => void
}

export const useColumnHighlightStore = create<Store>((set) => ({
  activeColumnId: null,
  setActiveColumn: (id) => set({ activeColumnId: id }),
}))

export function useColumnHighlight(columnId: string) {
  const { setActiveColumn } = useColumnHighlightStore()
  return {
    onFocus: () => setActiveColumn(columnId),
    onBlur:  () => setActiveColumn(null),
  }
}
```

**Virtual-scrolled grids (Content Calendar):** Use a positioned overlay div:
```
Position: absolute, top: 0, height: 100% (full grid height)
Width: column width in px
Left: computed column offset in px
Background: var(--accent-gold-dim)
Border-left/right: 1px solid var(--accent-gold-border)
Pointer-events: none (never blocks clicks)
Z-index: 1 (below cell content)
Transition: left 80ms ease
```

**State rules:**
1. `onFocus` → `setActiveColumn(columnId)` → overlay appears on that column
2. Save in-flight → column stays highlighted
3. Save success → `setActiveColumn(null)` → overlay fades (150ms)
4. Save failure → overlay stays → status dot turns red → toast appears → `setActiveColumn(null)` after 1.5s
5. Locked months → no `onFocus` events (cells are `<span>`, not `<input>`)

### 4.5 Modal Pattern
- Overlay: `rgba(0,0,0,0.65)` backdrop blur 4px
- Modal card: `--bg-elevated`, `--border-default`, `border-radius: var(--radius)`
- Framer Motion: `{ opacity: 0, scale: 0.96 }` → `{ opacity: 1, scale: 1 }`, duration 180ms
- Close: Escape key, backdrop click, explicit close button

---

## 5. HOME PAGE

**Layout:** 2-column: content (left, 70%) + activity feed (right, 30%)

**Role-specific primary widgets:**
- Admin: Org attendance % card + Task completion summary + Pipeline overview + Signup request badge
- Manager: Today's content statuses (mini calendar row) + Upcoming shoots this week + Team tasks
- Team Member: My tasks today (count by status) + My attendance toggle + Recent comments
- Freelancer: My next shoot card (large) + My month's shoots list

**Activity feed (right column):** Last 10 events via `GET /v1/activity-feed` — role-filtered. NOT the audit log. Timestamps in DM Mono.

**Quick actions (Manager/Admin):** Gold CTA buttons: [+ New Task] [Generate Report] [Add Holiday]. Open modal on click. Never navigate away from home.

---

## 6. SHARED PAGE ELEMENTS

### 6.1 Period Selector
- Location: top of sidebar, below logo
- Current month: gold text, "June 2025" in DM Mono
- Past months: grey text, chevron to expand history
- On change: `router.push` updates `?period=YYYY-MM` URL param → MonthContext updates → all module queries re-key
- "Viewing past month" banner: gold bar below header with [Back to current] link
- Period always in URL — supports bookmarking and browser back

### 6.2 Search Trigger
- Topbar search icon + keyboard shortcut badge (CMD+K / Ctrl+K)
- On open: full-screen dark overlay, search input centred, placeholder "Search tasks, clients, staff..."
- Scope toggle below input: [This month ✓] [All time] pill toggle
- Results: 4 labelled sections (Tasks, Clients, Staff, Comments), grouped by category

---

## 7-14. MODULE LAYOUTS

### 7. Staff Attendance
- **Layout:** Full-width grid. Date column (sticky left, 120px). Staff columns (140px each).
- **Row height:** 48px for regular cells; 56px when work-log is shown inline
- **Interactions:** Click toggle → immediate optimistic update. Click work-log cell → inline expand
- **Footer row:** "Total present" count per column (DM Mono)
- **Locked banner:** Gold banner top of page: "June 2025 is locked — read only"

### 8. Work Allocation — Tasks
- **Layout:** Full-width list grouped by date. Date group headers (collapsible).
- **Column order:** Date · Client · Description · Assignees (avatar stack) · Status chip · Priority badge · Dependency indicator · Deadline · Attachments count
- **Row expansion:** Click row → inline details panel (remark, result, time logs schema-ready)
- **Add task:** [+ Add task] button → slide-in right panel form

### 9. Shoot Planner
- **Layout:** Full-width grid. Client column (sticky left, 200px). Slot columns (dynamic count).
- **Week groupings:** Computed at render. Group headers show "Week 1 (May 6–10)".
- **N/A cells:** `opacity: 0.15`, dashed border, "—" text
- **Slot cell:** Shows status chip + slot_date (DM Mono) + pieces count badge
- **Slot popover:** Opens below cell (200px wide). Date picker + pieces stepper + Assignee dropdown + CTA button.

### 10. Content Dropper — Pipeline
- **Layout:** Full-width grid. Client (sticky, 200px) + Visit Type + Last Shoot + RAW + Finals + Posted + Coming Shoot.
- **Stage cells (RAW, Finals, Posted):** Empty = dashed border "Click to mark" · Filled = timestamp (DM Mono) + avatar
- **Progress bar:** 3px gold bar at bottom of each row (0%–100% based on stages complete)
- **Coming Shoot Date:** Shows "↑" indicator + tooltip "Set by Shoot Planner" when source='trigger'

### 11. Content Calendar
- **Layout:** Sticky date column (left, 80px). Client columns (dynamic, min 90px).
- **Row height:** 48px standard.
- **Today row:** `var(--accent-gold-06)` background. Auto-scroll to today on page load.
- **Cell click:** Inline popover (200px). Status dropdown + note textarea (800ms debounce). Closes on outside click.
- **Pipeline-triggered cells:** 6px gold dot at chip top-right + tooltip "Auto-updated from Content Dropper"
- **Optimistic update:** Status changes immediately; reverts on API failure with toast

### 12. AI Management Bot
- **Layout:** Chat-style interface. Bot messages left-aligned. User messages right-aligned.
- **Bot response cards:** Rendered based on tool type (see TRD §9.3 for card registry)
- **Confirmation turn:** Bot message with entity summary + "Shall I proceed?" + [Confirm] [Cancel] action buttons inline
- **New conversation:** Clear chat icon top-right → confirmation dialog → `DELETE /v1/bot/session/current`

### 13. Common Chat
- **Layout:** Left: channel list. Right: message area (infinite scroll). Right panel: thread view.
- **Message row:** Avatar (32px) + Name (DM Sans, 13px, bold) + Timestamp (DM Mono, 12px, muted) + Content
- **Typing indicator:** "Sohail is typing..." with three-dot pulse animation
- **Mention highlight:** @name rendered in gold within message content

### 14. Dashboard
- **Admin layout:** 3-column grid of stat cards + data tables + audit log summary
- **Stat cards:** Big Shoulders Display 48px number + DM Sans label
- **Stat colours:** Green for positive metrics, Amber for warnings, Gold for neutral counts
- **All data from materialised views** — never raw tables

---

## 15. SETTINGS

- **Layout:** Left navigation (Settings sections) + right content area
- **Staff table:** Name · Role · Status · Joined · Actions (⋯ menu per row)
- **Signup requests table:** Name · Role requested · DOB · Mobile · Submitted · Actions (Review / Approve / Reject buttons)
- **Months management:** Period list with status badges + [Lock] / [Unlock] buttons + [Trigger Rollover] CTA

---

## 16. NOTIFICATIONS

- **Bell icon:** Skaly lion logo mark SVG, 24px. Outlined state default. Filled state when unread count > 0.
- **Unread badge:** Gold circle, DM Mono, max "99+"
- **Panel:** 380px width, slides down from topbar. Max height: 480px, scrollable.
- **Notification row:** 64px min height. Icon + Title + Message preview (2-line truncate except rollover_failed) + DM Mono timestamp
- **rollover_failed:** Full-height, red/10 tint, no truncation, inline [Manual rollover] gold button

---

## 17. SEARCH PALETTE (CMD+K)

- **Trigger:** CMD+K / Ctrl+K or topbar icon
- **Overlay:** Full page, dark backdrop
- **Input:** Centred, 600px wide on desktop
- **Scope toggle:** Below input, pill style — [This month] [All time]
- **Results:** Grouped by category (Tasks / Clients / Staff / Comments), max 5 per category visible initially, [Show more] per category
- **Keyboard:** ↑↓ to navigate, Enter to open, Escape to close
- **Debounce:** 200ms

---

## 18. COMMENT BOXES

Available in: Shoot Planner, Content Dropper, Content Calendar only.

- **Trigger:** 💬 icon at far right of each row. Badge count on icon.
- **Non-virtual grids:** TanStack Table row expansion — pushes rows below down
- **Virtual grids (Content Calendar):** Portal-positioned overlay anchored below the row — does not affect virtual row pool
- **Comment entry:** Textarea at bottom of expanded section, [Post] button
- **Comment row:** Avatar + Name + Timestamp (DM Mono) + Content + [✓ Noted] button (manager/admin only)
- **Acknowledged:** Green ✓ badge + "Acknowledged by [Name]" in muted text

---

## 19. ERROR STATES & EMPTY STATES

- **Empty grid:** Big Shoulders Display "Nothing here yet" + DM Sans helper text + optional CTA
- **API error:** Red toast bottom-right: "Failed to save. Try again." with retry action
- **Locked period write attempt:** Gold inline message: "This period is locked. Contact an admin to unlock."
- **Version conflict (409):** Inline cell message: "Updated by [Name] — [Refresh row →]" — gold link
- **Session expired:** Full-page: "Session expired" with [Sign in again] button — no data loss

---

## 20. ACCESSIBILITY

- All interactive elements have `aria-label` or visible label
- Focus ring: `outline: 2px solid var(--accent-gold)` on all focusable elements
- Minimum touch target: 44×44px
- Colour is never the only differentiator for status (always paired with text or icon)
- Keyboard navigation through all grids (Tab + arrow keys)
- Screen reader: `role="grid"`, `role="gridcell"`, `aria-rowindex`, `aria-colindex` on all TanStack Table grids

---

## 21. MOBILE APP SPECIFICATION (REACT NATIVE + EXPO)

**This section defines the native mobile application. It is NOT a responsive CSS layout. It uses React Native components, not HTML elements.**

**Platform:** Android + iOS via Expo managed workflow (SDK 51+)  
**Styling:** NativeWind v4 (Tailwind classes → React Native StyleSheet)  
**Navigation:** Expo Router v3 (file-based routing)

### 21.1 Navigation Structure

```
Root: Stack Navigator
├── (auth)/
│   ├── login.tsx
│   └── signup.tsx
└── (tabs)/           ← Tab Navigator (5 tabs)
    ├── index.tsx     [Home]
    ├── tasks.tsx     [Tasks]
    ├── calendar.tsx  [Calendar — Content Calendar]
    ├── chat.tsx      [Chat]
    └── profile.tsx   [Profile]
```

**Bottom Tab Bar:**
- 5 tabs: Home · Tasks · Calendar · Chat · Profile
- Background: `#141417` (--bg-surface equivalent)
- Active icon + label: `#FDC257` (--accent-gold)
- Inactive icon + label: `#71717A` (--text-muted)
- Height: 56px + safe area inset (home indicator)
- Font: DM Sans 10px for labels
- Tab icons: Lucide React Native (22×22px)

### 21.2 Home Tab (Native)

```jsx
<ScrollView>
  <StatusBar style="light" />
  <SafeAreaView>
    <Header title="Good morning, Naaz" period="June 2025" />
    {/* Role-specific cards as FlatList items */}
    <FlatList
      data={homeCards}
      renderItem={({ item }) => <HomeCard {...item} />}
      showsVerticalScrollIndicator={false}
    />
    <ActivityFeed />
  </SafeAreaView>
</ScrollView>
```

**HomeCard component:** `View` with `border-radius: 16`, `backgroundColor: #1E1E23`, padding 16px. Title in Big Shoulders Display 18px. Value in Big Shoulders Display 32px gold. Label in DM Sans 12px muted.

### 21.3 Tasks Tab (Native)

```jsx
<SafeAreaView>
  <FlatList
    data={tasksByDate}   // grouped by date, section headers
    keyExtractor={(item) => item.id}
    renderItem={({ item }) => (
      <TaskRow
        task={item}
        onStatusChange={(status) => handleStatusChange(item.id, status)}
      />
    )}
    ListHeaderComponent={<PeriodSelector />}
    stickyHeaderIndices={sectionHeaderIndices}
  />
  <FAB onPress={() => router.push('/task-create')} />
</SafeAreaView>
```

**TaskRow:** Full-width `Pressable` with ripple. Shows description (DM Sans 14px), client chip, status chip, deadline (DM Mono 12px). Right-swipe: mark Done. Left-swipe: open detail.

### 21.4 Calendar Tab (Native — Content Calendar)

**Not a CSS grid — uses a SectionList with horizontal scroll per row.**

```jsx
// Mobile calendar: show ONE client at a time (swipe between clients)
// Unlike web (all clients as columns), mobile shows client switcher

<SafeAreaView>
  <ClientSwitcher clients={clients} activeClient={selected} />
  <SectionList
    sections={calendarDays}   // 31 days, grouped by week
    renderItem={({ item: day }) => (
      <CalendarDayRow date={day.date} status={day.status} onPress={() => openEdit(day)} />
    )}
    renderSectionHeader={({ section }) => <WeekHeader label={section.title} />}
    getItemLayout={calendarItemLayout}  // 64px rows for smooth scroll
  />
</SafeAreaView>
```

**CalendarDayRow:** `Pressable` (64px height). Date column (DM Mono 13px). Status chip. Note preview if present.

**Edit bottom sheet:** React Native Bottom Sheet library. Opens from bottom with handle. Status picker (radio group) + note text input + [Save] gold button.

### 21.5 Chat Tab (Native)

```jsx
<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
  <FlashList
    ref={listRef}
    data={messages}
    renderItem={({ item }) => <MessageRow message={item} />}
    estimatedItemSize={64}
    inverted={true}   // newest at bottom
    onEndReached={loadMoreMessages}
  />
  <ChatInput
    value={inputText}
    onChangeText={setInputText}
    onSend={handleSend}
    onMention={handleMention}
  />
</KeyboardAvoidingView>
```

**ChatInput:** `TextInput` with DM Sans font. Send button (gold arrow icon). @ key shows mention sheet.

### 21.6 Profile Tab (Native)

- Full Name (DM Sans)
- Role badge (chip)
- Mobile number (DM Mono)
- Period display (DM Mono)
- [Change password] row
- [Sign out] row (destructive colour)
- Notification preferences section (toggle list)

### 21.7 Authentication Screens (Native)

**Login screen:**
```jsx
<SafeAreaView>
  <Image source={require('./assets/skaly-logo.png')} />
  <Text style={{ fontFamily: 'BigShoulders-Bold', fontSize: 28 }}>Welcome back</Text>
  <TextInput placeholder="Email" keyboardType="email-address" />
  <TextInput placeholder="Password" secureTextEntry />
  <GoldButton onPress={handleLogin}>Sign in</GoldButton>
  <GoogleSignInButton onPress={handleGoogleAuth} />
</SafeAreaView>
```

**MFA screen:**
```jsx
<OTPInput length={6} onFill={handleMFAVerify} autoFocus />
```

### 21.8 Push Notification Handling

```typescript
// app/_layout.tsx
import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

// On app foreground: handled by Socket.io (same as web)
// On app background/quit: handled by Expo Notifications (FCM/APNs)
// On tap: router.push(notification.data.link)
```

### 21.9 Offline Behaviour

- Task list: cached in Expo SecureStore (last 50 tasks, current period)
- Calendar: cached in Expo SecureStore (current period, selected client)
- Mutations while offline: queued in Zustand, replayed on reconnect
- Offline banner: "No internet connection — changes will sync when reconnected"

**Replay failure handling (audit M-09 — Phase 2 documentation):**

Queued mutations must be tagged with the optimistic-lock `version` value at the moment of queue entry. On replay:
- **HTTP 423 `PERIOD_LOCKED` returned** — the period was locked between the offline mutation and the reconnect. Surface to the user: *"Some changes couldn't be saved — the period was locked while you were offline."* with a list of affected records.
- **HTTP 409 `STALE_DATA` returned** — another user (or the same user on web) updated the record while this device was offline. Surface: *"Some changes conflict with updates made by others while you were offline. Please review and re-apply where needed."* with a diff view of what changed.
- **Network errors after retry exhaustion** — keep in queue, retry on next reconnect.

The mobile app's offline queue must persist across app launches (write to Expo SecureStore on every queue mutation, not just on app exit). A queue of 100+ mutations after several days offline is acceptable; the replay protocol handles it gracefully.

### 21.10 Typography in React Native

```typescript
// React Native font loading (Expo)
const [fontsLoaded] = useFonts({
  'BigShoulders-Regular':    require('./assets/fonts/BigShouldersDisplay-Regular.ttf'),
  'BigShoulders-Bold':       require('./assets/fonts/BigShouldersDisplay-Bold.ttf'),
  'DMSans-Regular':          require('./assets/fonts/DMSans-Regular.ttf'),
  'DMSans-Medium':           require('./assets/fonts/DMSans-Medium.ttf'),
  'DMSans-SemiBold':         require('./assets/fonts/DMSans-SemiBold.ttf'),
  'DMMono-Regular':          require('./assets/fonts/DMMono-Regular.ttf'),
  'DMMono-Medium':           require('./assets/fonts/DMMono-Medium.ttf'),
});
// Apply via style: { fontFamily: 'BigShoulders-Bold', fontSize: 32 }
// NativeWind class: className="font-display text-3xl font-bold"
```

### 21.11 Screen Size Targets

| Device | Screen Width | Layout Adaptation |
|--------|-------------|------------------|
| iPhone SE (3rd) | 375px | Single column, compact cards |
| iPhone 14 Pro | 393px | Single column, standard |
| iPhone 14 Pro Max | 430px | Single column, expanded padding |
| Samsung Galaxy S24 | 360px | Single column, compact |
| Galaxy Tab S9 | 800px | Split view: sidebar (280px) + content |

---

## 22. ANIMATION SPEC (FRAMER MOTION — WEB)

| Element | Animation | Duration |
|---------|-----------|---------|
| Page transition | `{ opacity: 0, y: 8 }` → `{ opacity: 1, y: 0 }` | 200ms |
| Modal open | `{ opacity: 0, scale: 0.96 }` → `{ opacity: 1, scale: 1 }` | 180ms |
| Modal close | `{ opacity: 1, scale: 1 }` → `{ opacity: 0, scale: 0.96 }` | 150ms |
| Notification toast | Slide in from bottom-right | 240ms |
| Column highlight overlay | `opacity: 0` → `opacity: 1` | 80ms |
| Status chip change | Fade crossfade | 120ms |
| Row expand (comment) | Height tween via `layout` prop | 200ms |
| Gold column clear | `opacity: 1` → `opacity: 0` | 150ms |
