import type { StaffMeResponse } from '@skaly/shared/schemas/auth';

import { visiblePanels } from '@/lib/settings-panels';


/**
 * The portal's modules, as data (UIUX §4.1 navigation sidebar, Auth-Matrix §3).
 *
 * The same shape and the same reasoning as `settings-panels.ts`: ONE list, read
 * by the nav, keyed on the SAME resolved permission the backend gates on — never
 * a `role === 'admin'` check in a component. A role check is wrong the moment an
 * admin grants an override, because the override changes the key's value and
 * cannot change the role, so the module would stay hidden from the person who
 * was just given it (ADR-029 pushes exactly that change live).
 *
 * ⚠️ THIS LIST IS NOT A SECURITY BOUNDARY, and must not be mistaken for one. It
 * decides what is NAVIGABLE. Each module's data is gated by the API on every
 * request, which is the only layer an attacker cannot skip — a module hidden
 * here but open at the API is not gated at all. Unlike the settings panels there
 * is deliberately no matching `requireModule()` page guard: the module pages
 * render a grid that the API answers 403 for, and their own error/empty states
 * are the spec'd behaviour (see `chat/page.tsx`, which says so explicitly).
 */
export interface ModuleNavItem {
  href: string;
  label: string;
  /** Lucide icon name, resolved at render (§4.1: 20px, Lucide React). */
  icon: string;
  /**
   * The permission key that makes this module navigable. `null` means every
   * authenticated staff member sees it — used only where no key exists in the
   * registry, which today is the bot: its gating is per-TOOL (`bot.tool.*`), so
   * there is no single key to test and a freelancer legitimately has some of them.
   */
  read: string | null;
}

export const MODULES: ModuleNavItem[] = [
  { href: '/home', label: 'Home', icon: 'House', read: 'module.home.read' },
  { href: '/attendance', label: 'Attendance', icon: 'CalendarCheck', read: 'module.attendance.read' },
  { href: '/tasks', label: 'Tasks', icon: 'ClipboardList', read: 'module.tasks.read' },
  { href: '/shoot-planner', label: 'Shoot Planner', icon: 'Camera', read: 'module.shoot_planner.read' },
  { href: '/content-dropper', label: 'Content Dropper', icon: 'Workflow', read: 'module.content_dropper.read' },
  { href: '/content-calendar', label: 'Content Calendar', icon: 'CalendarDays', read: 'module.content_calendar.read' },
  { href: '/dashboard', label: 'Dashboard', icon: 'ChartColumn', read: 'module.dashboard.read' },
  { href: '/chat', label: 'Chat', icon: 'MessagesSquare', read: 'chat.access' },
  { href: '/bot', label: 'Bot', icon: 'Sparkles', read: null },
  { href: '/profile', label: 'Profile', icon: 'User', read: 'module.profile.read' },
];

/**
 * The modules this person may navigate to, plus Settings when they hold ANY
 * panel.
 *
 * Settings is derived rather than listed above because it has no permission key
 * of its own — it is a shell over the panels, and `visiblePanels` already owns
 * "which of those may this person see". Giving Settings its own key would create
 * the second list that `settings-panels.ts` warns about, and the failure would be
 * a Settings link that opens on a nav with nothing in it.
 */
export function visibleModules(me: StaffMeResponse | null): ModuleNavItem[] {
  if (!me) return [];

  const items = MODULES.filter((m) => m.read === null || me.permissions[m.read] === true);

  return visiblePanels(me).length > 0
    ? [...items, { href: '/settings', label: 'Settings', icon: 'Settings', read: null }]
    : items;
}
