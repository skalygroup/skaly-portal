import { AppSidebar } from '@/components/shared/app-sidebar';
import { CommentPanelHost } from '@/components/shared/comment-panel';
import { ConnectionBanner } from '@/components/shared/connection-banner';
import { MonthLockSync } from '@/components/shared/month-lock-sync';
import { NotificationBell } from '@/components/shared/notification-bell';
import { PermissionSync } from '@/components/shared/permission-sync';
import { RolloverBanner } from '@/components/shared/rollover-banner';
import { SearchPalette } from '@/components/shared/search-palette';
import { getStaffMe } from '@/lib/get-staff-me';
import { visibleModules } from '@/lib/modules';

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  // Server-side, so a person's HTML never contains a link to a module they
  // cannot open — the same derivation the settings shell already uses.
  const me = await getStaffMe();
  const modules = visibleModules(me);

  return (
    <>
      {/* Mobile fallback — shown on screens < 768px (M-02 fix) */}
      <div className="flex md:hidden min-h-screen items-center justify-center px-6"
           style={{ background: 'var(--bg-base)' }}>
        <div className="text-center">
          <h1 style={{ fontFamily: 'var(--font-display)', color: 'var(--accent-gold)' }}
              className="text-3xl font-bold">
            Skaly Business Portal
          </h1>
          <p style={{ fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}
             className="mt-4">
            This portal requires a desktop browser.
          </p>
          <p style={{ fontFamily: 'var(--font-body)', color: 'var(--text-muted)' }}
             className="mt-2 text-sm">
            Mobile app coming soon.
          </p>
        </div>
      </div>

      {/* Portal content — visible on md+ screens.
          Padded to clear the FIXED sidebar (56px, 220px from xl). Fixed rather
          than a grid column because every module renders its own full-height
          scrolling <main>; a grid would put the nav inside that scroll context
          and it would slide away up the page on a long attendance grid. */}
      <div className="hidden min-h-screen pl-14 md:block xl:pl-[220px]">
        {/* The topbar UIUX §16 assumes ("panel slides down from topbar") did not
            exist — pages render their own <main> and the only shared chrome was the
            CMD+K palette. This is the minimum that makes the spec true: one row, one
            bell, mounted ONCE like SearchPalette so there is a single socket
            subscription and a single notifications cache entry for the whole app.
            Nav and the topbar search icon are deliberately NOT invented here; they
            belong to Sprint 11's Settings/Dashboard chrome. */}
        {/* Non-blocking, fixed to the top of the viewport (Error-Handling §5.4). */}
        <ConnectionBanner />
        {/* Informational only (NFR §3.1 — the API stays fully operational through
            00:01–00:05; Tier 2's CONCURRENTLY refresh is what makes that true).
            Sits one z-layer below the connection banner: if the socket is also
            down, "reconnecting" is the more urgent of the two. */}
        <RolloverBanner />
        {/* ADR-029. Mounted here, not in the settings shell: a revoked module
            has to leave the nav of whatever page the user is idling on, and
            that is usually not Settings. Renders nothing. */}
        <PermissionSync />
        {/* Same reasoning, same place: a month that has just been locked has to
            go read-only on whatever grid the user is idling on, which is never
            Settings → Months. Renders nothing. */}
        <MonthLockSync />
        {/* UIUX §4.1. Mounted here, once, beside the bell — the nav has to be on
            every portal route, and a per-page copy would drift the moment one
            page forgot it. Items are pre-filtered above. */}
        <AppSidebar items={modules} />
        <header className="flex h-14 items-center justify-end gap-2 px-8">
          <NotificationBell />
        </header>
        {children}
        {/* Mounted ONCE here, not per page: one CMD+K listener, every route
            (FR-SEARCH-01). Inside the md+ branch — the palette is desktop-only,
            like the rest of the portal. */}
        <SearchPalette />
        {/* One panel for every grid's comment buttons. Mounted here rather than
            inside the trigger because the triggers live in TanStack cells, and a
            column rebuild remounts those — taking an open panel with it. */}
        <CommentPanelHost />
      </div>
    </>
  );
}
