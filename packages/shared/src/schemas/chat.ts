import { z } from 'zod';

/**
 * Chat wire schemas (07-API-CONTRACT /v1/chat/*). `.strict()` throughout.
 *
 * Note there is no `channel` enum beyond 'common': the schema's CHECK allows
 * 'common' and 'bot', but /v1/chat only ever addresses the common channel. Bot
 * conversations are reached through /v1/bot/session/current, which resolves ownership
 * by join (ADR-021) — exposing them here would hand every caller a channel filter that
 * returns other people's bot history.
 */
export const CHAT_MESSAGE_MAX = 4000;
export const CHAT_PAGE_LIMIT = 50;

export const ChatMentionSchema = z
  .object({ staffId: z.string().uuid(), name: z.string() })
  .strict();

export const ChatMessageSchema = z
  .object({
    id: z.string().uuid(),
    channel: z.literal('common'),
    senderId: z.string().uuid().nullable(),
    senderName: z.string().nullable(),
    senderAvatarUrl: z.string().nullable(),
    content: z.string(),
    parentId: z.string().uuid().nullable(),
    mentions: z.array(ChatMentionSchema),
    replyCount: z.number().int().min(0),
    isDeleted: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

export const ChatSendSchema = z
  .object({
    content: z.string().min(1).max(CHAT_MESSAGE_MAX),
    /** Present makes this a threaded reply. */
    parentId: z.string().uuid().optional(),
  })
  .strict();

export const ChatListQuerySchema = z
  .object({
    /** Opaque base64url `createdAt|id`. Keyset, never an offset. */
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(CHAT_PAGE_LIMIT).optional(),
  })
  .strict();

export const ChatListResponseSchema = z
  .object({
    data: z.array(ChatMessageSchema),
    meta: z.object({ nextCursor: z.string().nullable() }).strict(),
  })
  .strict();

export const ChatThreadResponseSchema = z
  .object({ data: z.array(ChatMessageSchema) })
  .strict();

export const ChatSearchQuerySchema = z
  .object({
    q: z.string().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(CHAT_PAGE_LIMIT).optional(),
  })
  .strict();

export const ChatDeleteResponseSchema = z
  .object({ data: z.object({ deleted: z.literal(true) }).strict() })
  .strict();

export const ChatSendResponseSchema = z.object({ data: ChatMessageSchema }).strict();

export type ChatMessageDTOWire = z.infer<typeof ChatMessageSchema>;
export type ChatListResponse = z.infer<typeof ChatListResponseSchema>;
export type ChatSendBody = z.infer<typeof ChatSendSchema>;
