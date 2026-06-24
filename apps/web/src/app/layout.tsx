import type { Metadata } from 'next';
// Google renamed "Big Shoulders Display" to "Big Shoulders"; this Next
// version exports it as `Big_Shoulders` (NOT `Big_Shoulders_Display`).
import { Big_Shoulders, DM_Sans, DM_Mono } from 'next/font/google';
import './globals.css';
import { cn } from "@/lib/utils";
import { Providers } from "@/components/providers";

const bigShoulders = Big_Shoulders({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '600', '700'],
  variable: '--font-big-shoulders',
  // next/font can't derive fallback size-adjust metrics for "Big Shoulders"
  // (logs "Failed to find font override values…"). Opt out of the auto
  // fallback to silence it; this is a display heading, so CLS impact is nil.
  adjustFontFallback: false,
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-dm-sans',
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '500'],
  variable: '--font-dm-mono',
});

export const metadata: Metadata = {
  title: 'Skaly Business Portal',
  description: 'Internal operations platform for Skaly Group',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: browser extensions inject attributes onto <html>
    // (e.g. webcrx="") before React hydrates, which otherwise trips a hydration
    // mismatch. Scoped to this element only — it won't mask mismatches below.
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(bigShoulders.variable, dmSans.variable, dmMono.variable, "font-sans")}
    >
      {/* suppressHydrationWarning: extensions also tag <body> (e.g. ColorZilla's
          cz-shortcut-listen="true"). Same one-level scope as <html> above. */}
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
