import type { Metadata } from 'next';
// Google renamed "Big Shoulders Display" to "Big Shoulders"; this Next
// version exports it as `Big_Shoulders` (NOT `Big_Shoulders_Display`).
import { Big_Shoulders, DM_Sans, DM_Mono } from 'next/font/google';
import './globals.css';
import { cn } from "@/lib/utils";

const bigShoulders = Big_Shoulders({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '600', '700'],
  variable: '--font-big-shoulders',
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
    <html lang="en" className={cn(bigShoulders.variable, dmSans.variable, dmMono.variable, "font-sans")}>
      <body>{children}</body>
    </html>
  );
}
