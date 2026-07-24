import { BotChat } from '@/components/modules/bot/bot-chat';

/**
 * AI Bot (04-APPFLOW §9). The whole reply streams over /ws/notify (C-01); the
 * panel owns the chat state, streaming render, and the 11-card registry.
 */
export default function BotPage() {
  return (
    <main className="h-screen">
      <BotChat />
    </main>
  );
}
