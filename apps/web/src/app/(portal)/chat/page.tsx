import { ChatView } from '@/components/modules/chat/chat-view';
import { getStaffMe } from '@/lib/get-staff-me';

/**
 * Common chat (04-APPFLOW chat flow).
 *
 * `chat.access` is enforced by the API on every route (Auth-Matrix §3 — the freelancer
 * 🔧 key), so a freelancer without the override sees the error state rather than a
 * blank page. The gate is deliberately NOT duplicated here: a second copy in the UI
 * would be a second thing to keep in step with PermissionService, and the server is
 * the layer that actually protects the data.
 */
export default async function ChatPage() {
  const me = await getStaffMe();
  return <ChatView me={me} />;
}
