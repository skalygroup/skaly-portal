export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Mobile fallback — shown on screens < 768px (M-02 fix) */}
      <div className="flex md:hidden min-h-screen items-center justify-center px-6"
           style={{ background: 'var(--bg-base)' }}>
        <div className="text-center">
          <h1 style={{ fontFamily: 'var(--font-display)', color: 'var(--accent-gold)' }}
              className="text-3xl font-bold">
            Scaly Business Portal
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
        {children}
      </div>
    </>
  );
}
