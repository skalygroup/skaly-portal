import { redirect } from 'next/navigation';

/**
 * `/` → `/home`.
 *
 * This was a Sprint 1 placeholder that greeted you by name and said "module
 * dashboards arrive in Sprint 11". Sprint 11 shipped Settings and Reports and
 * never came back for it, so post-login every user landed on a page with no
 * links to anything — with no sidebar either, the portal was unreachable
 * without typing URLs.
 *
 * The sidebar (UIUX §4.1) fixes the navigation; this fixes the landing. `/home`
 * is the real thing the placeholder stood in for — it is in the permission
 * registry (`module.home.read`, granted to every role including freelancers)
 * and it renders the activity feed.
 *
 * A redirect rather than moving Home's content here: `/home` is already the
 * canonical route, it is what the sidebar links to, and two URLs rendering the
 * same page is how one of them quietly stops being maintained.
 */
export default function PortalIndexPage() {
  redirect('/home');
}
