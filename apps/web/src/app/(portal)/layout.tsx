import { NotificationBell } from '@/components/shared/notification-bell';
import { SearchPalette } from '@/components/shared/search-palette';

export default function PortalLayout({ children }: { children: React.ReactNode }) {
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

      {/* Portal content — visible on md+ screens */}
      <div className="hidden md:block min-h-screen">
        {/* The topbar UIUX §16 assumes ("panel slides down from topbar") did not
            exist — pages render their own <main> and the only shared chrome was the
            CMD+K palette. This is the minimum that makes the spec true: one row, one
            bell, mounted ONCE like SearchPalette so there is a single socket
            subscription and a single notifications cache entry for the whole app.
            Nav and the topbar search icon are deliberately NOT invented here; they
            belong to Sprint 11's Settings/Dashboard chrome. */}
        <header className="flex h-14 items-center justify-end gap-2 px-8">
          <NotificationBell />
        </header>
        {children}
        {/* Mounted ONCE here, not per page: one CMD+K listener, every route
            (FR-SEARCH-01). Inside the md+ branch — the palette is desktop-only,
            like the rest of the portal. */}
        <SearchPalette />
      </div>
    </>
  );
}
