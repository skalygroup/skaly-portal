/**
 * ChatService — the common channel (04-APPFLOW chat flow, 07-API-CONTRACT /v1/chat/*).
 *
 * The SECOND writer to `messages`. ADR-021 deliberately landed first so the bot's
 * write shape was already correct before chat arrived — fixing one writer while adding
 * another to the same table is how you get two half-right writers.
 *
 * INVARIANTS
 *   - Content is stored RAW. Sanitising on write destroys the original and pushes the
 *     problem onto whoever reads the DB directly; escaping belongs at render (NFR §4.3).
 *   - Only @mentions create notification rows. Ordinary messages deliver over the
 *     socket and nothing else (ADR-020) — there is no per-message notification type,
 *     and adding one would be a CHECK-constraint migration AND scope drift.
 *   - Keyset pagination, never OFFSET. At ~15k rows (NFR §2.2) OFFSET is survivable
 *     and still wrong; keyset is the same amount of code.
 *   - Access is a PERMISSION check (`chat.access`), never a role check — Auth-Matrix
 *     §3 marks /chat 🔧 for freelancers, default-denied and admin-grantable.
 *   - Soft delete via lib/queries.ts `softDelete`, which is where it lives (it is NOT
 *     on BaseService).
 */
import { sql } from 'kysely';

import { NotificationService } from './NotificationService.js';
import { PermissionService } from './PermissionService.js';
import { AppError } from '../lib/errors.js';
import { softDelete, softDeletable } from '../lib/queries.js';

import type { CurrentUser } from './AttendanceService.js';
import type { Executor } from './BaseService.js';
import type { Redis } from 'ioredis';

export const CHAT_ACCESS_KEY = 'chat.access';
export const CHAT_CHANNEL = 'common';
export const MESSAGE_MAX_LENGTH = 4000;

export interface ChatMentionDTO {
  staffId: string;
  name: string;
}

export interface ChatMessageDTO {
  id: string;
  /** Always 'common'. Every read filters on it — see getThread's note. */
  channel: 'common';
  senderId: string | null;
  senderName: string | null;
  senderAvatarUrl: string | null;
  content: string;
  parentId: string | null;
  mentions: ChatMentionDTO[];
  replyCount: number;
  isDeleted: boolean;
  createdAt: string;
}

export interface ChatSendInput {
  content: string;
  parentId?: string | null;
}

/** The row shape every read returns, so list/getThread/search cannot drift apart. */
interface ChatRow {
  id: string;
  channel: string;
  sender_id: string | null;
  sender_name: string | null;
  sender_avatar_url: string | null;
  content: string;
  parent_id: string | null;
  deleted_at: Date | null;
  created_at: Date;
}

/**
 * Mention parsing.
 *
 * ⚠️ A REGEX CANNOT KNOW WHERE A NAME ENDS. "@Rahul Menon please look" and "@Rahul can
 * you look" are identical in shape; only the staff table can say that the first is a
 * two-word name and the second is a one-word name followed by prose. A pattern that
 * greedily takes N words mentions "Rahul can you"; one that takes a single word can
 * never match "Rahul Menon".
 *
 * So the parser does not decide. It emits CANDIDATE prefixes per @-site, longest
 * first, and `resolveMentions` picks the longest that is a real active staff member.
 * The database is the authority on where the name stops.
 *
 * The exclusions in `stripNonMentionRegions` matter as much as the pattern: an email
 * address and a code span both contain `@`-adjacent text that is not a mention, and
 * matching inside either produces a notification nobody asked for.
 */
const MENTION_PATTERN = /@([\p{L}\p{N}][\p{L}\p{N}.'-]*(?: [\p{L}\p{N}][\p{L}\p{N}.'-]*){0,2})/gu;

/** How many space-separated words a display name may span. */
const MAX_MENTION_WORDS = 3;

/**
 * Blank out regions where an `@` is not a mention, preserving offsets so the pattern
 * still sees the surrounding text correctly:
 *   - fenced ``` blocks and inline `code`
 *   - URLs (an @ in a path or a userinfo segment)
 *   - bare email addresses
 */
function stripNonMentionRegions(content: string): string {
  const blank = (m: string) => ' '.repeat(m.length);
  return content
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\bhttps?:\/\/\S+/gi, blank)
    .replace(/\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/gu, blank);
}

/**
 * One candidate list per `@` in the message, each ordered longest-first.
 *
 * "@Rahul Menon please look" → [["Rahul Menon please", "Rahul Menon", "Rahul"]].
 * Whichever of those is a real staff name wins; if several are, the longest does, so a
 * full name beats the first name it starts with.
 */
export function parseMentionCandidates(content: string): string[][] {
  const searchable = stripNonMentionRegions(content);
  const sites: string[][] = [];

  for (const match of searchable.matchAll(MENTION_PATTERN)) {
    const words = match[1]?.trim().split(/\s+/).slice(0, MAX_MENTION_WORDS) ?? [];
    if (words.length === 0) continue;
    const candidates: string[] = [];
    for (let take = words.length; take >= 1; take--) {
      candidates.push(words.slice(0, take).join(' '));
    }
    sites.push(candidates);
  }
  return sites;
}

export class ChatService {
  private readonly notifications = new NotificationService();
  private readonly permissions: PermissionService;

  /**
   * Redis is injected rather than imported so a test can hand in its own client —
   * the same shape BotService uses. `app.redis` IS the lib/redis singleton
   * (app.ts:188), so routes passing it get one connection, not two.
   */
  constructor(redis: Redis) {
    this.permissions = new PermissionService(redis);
  }

  /**
   * The `chat.access` gate. A PERMISSION, not a role — this is the key's first real
   * use (Auth-Matrix §3 + §6.2). Admin/manager/team_member default true, freelancer
   * default false and admin-grantable, and `resolvePermission` never fails open.
   *
   * Enforced in the SERVICE, so the bot or any future caller cannot route around a
   * route-level guard.
   */
  async assertAccess(currentUser: CurrentUser, db: Executor): Promise<void> {
    const allowed = await this.permissions.resolvePermission(
      currentUser.staffId,
      currentUser.role,
      CHAT_ACCESS_KEY,
      db,
    );
    if (!allowed) {
      throw new AppError('PERMISSION_DENIED', 'You do not have access to chat.');
    }
  }

  /**
   * Send a message. One transaction: the row, its mention rows, and the fan-out all
   * commit together or not at all.
   */
  async send(input: ChatSendInput, currentUser: CurrentUser, trx: Executor): Promise<ChatMessageDTO> {
    await this.assertAccess(currentUser, trx);

    const content = input.content.trim();
    if (content.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'A message cannot be empty.');
    }
    if (content.length > MESSAGE_MAX_LENGTH) {
      throw new AppError('VALIDATION_ERROR', `A message cannot exceed ${MESSAGE_MAX_LENGTH} characters.`);
    }

    if (input.parentId) {
      // A reply to a missing or deleted parent would orphan the thread.
      const parent = await softDeletable(trx.selectFrom('messages').select('id'))
        .where('id', '=', input.parentId)
        .where('channel', '=', CHAT_CHANNEL)
        .executeTakeFirst();
      if (!parent) {
        throw new AppError('RESOURCE_NOT_FOUND', `Message ${input.parentId} does not exist.`);
      }
    }

    const row = await trx
      .insertInto('messages')
      .values({
        channel: CHAT_CHANNEL,
        sender_id: currentUser.staffId,
        sender_type: 'user',
        // RAW. Escaping happens at render — see the module note.
        content,
        content_type: 'text',
        parent_id: input.parentId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const mentioned = await this.resolveMentions(content, trx);

    if (mentioned.length > 0) {
      await trx
        .insertInto('message_mentions')
        .values(mentioned.map((m) => ({ message_id: row.id, staff_id: m.staffId })))
        .execute();
    }

    // Read once, before the loop — the sender is the same person for every mention,
    // and this row is also what the returned DTO needs.
    const sender = await trx
      .selectFrom('staff')
      .select(['name', 'avatar_url'])
      .where('id', '=', currentUser.staffId)
      .executeTakeFirst();

    // ADR-006: one notification per mentioned user, never combined — and NEVER to the
    // author. A self-mention still creates the message_mentions row (it is real, and
    // the highlight should render) but produces no notification.
    for (const m of mentioned) {
      if (m.staffId === currentUser.staffId) continue;
      await this.notifications.create({
        recipientId: m.staffId,
        type: 'mention',
        title: `${sender?.name ?? 'Someone'} mentioned you`,
        body: content.slice(0, 200),
        data: { messageId: row.id, senderId: currentUser.staffId, recordId: row.id },
        // NOT deduped on the message id alone — every mention is a distinct
        // (recipient, type, record) triple because the recipient differs, so N
        // mentions in one message still produce N notifications.
        recordId: row.id,
        trx,
      });
    }

    return {
      id: row.id,
      channel: row.channel as 'common',
      senderId: row.sender_id,
      senderName: sender?.name ?? null,
      senderAvatarUrl: sender?.avatar_url ?? null,
      content: row.content,
      parentId: row.parent_id,
      mentions: mentioned,
      replyCount: 0,
      isDeleted: false,
      createdAt: row.created_at.toISOString(),
    };
  }

  /**
   * A page of top-level messages, newest first, KEYSET on (created_at, id).
   *
   * `id` is in the key because two messages can share a timestamp under concurrency —
   * with created_at alone, a page boundary landing between them either drops one or
   * repeats it, and neither is visible until someone is actually typing fast.
   */
  async list(
    opts: { limit: number; cursor?: string | null },
    currentUser: CurrentUser,
    db: Executor,
  ): Promise<{ messages: ChatMessageDTO[]; nextCursor: string | null }> {
    await this.assertAccess(currentUser, db);

    let q = this.baseSelect(db)
      .where('m.channel', '=', CHAT_CHANNEL)
      // Top-level only; replies belong to their thread.
      .where('m.parent_id', 'is', null)
      .orderBy('m.created_at', 'desc')
      .orderBy('m.id', 'desc')
      .limit(opts.limit + 1);

    if (opts.cursor) {
      // The cursor is the last row's ID, and the comparison reads that row's
      // (created_at, id) back from the table.
      //
      // It used to carry the timestamp itself, base64'd via toISOString() — which is
      // MILLISECOND precision against a MICROSECOND column. The truncated value sorts
      // below the row it came from, so every message inside that sub-millisecond
      // window was silently skipped. Invisible with messages a second apart, and it
      // dropped half the page the moment two arrived in the same microsecond.
      //
      // Reading the tuple back costs one primary-key lookup and cannot lose precision,
      // because the value never leaves Postgres.
      q = q.where(
        sql<boolean>`(m.created_at, m.id) <
          (SELECT c.created_at, c.id FROM messages c WHERE c.id = ${opts.cursor}::uuid)`,
      );
    }

    const rows = await q.execute();
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    const nextCursor = rows.length > opts.limit && last ? last.id : null;

    return { messages: await this.decorate(page, db), nextCursor };
  }

  /** Replies to one message, OLDEST first — a thread reads top to bottom. */
  async getThread(parentId: string, currentUser: CurrentUser, db: Executor): Promise<ChatMessageDTO[]> {
    await this.assertAccess(currentUser, db);

    const rows = await this.baseSelect(db)
      .where('m.parent_id', '=', parentId)
      // The channel filter is load-bearing, not decoration. `parent_id` is shared with
      // the bot archive (ADR-021 links a bot reply to the user's turn through it), so
      // filtering on parent alone would hand a chat caller somebody's bot conversation
      // given nothing more than a message id.
      .where('m.channel', '=', CHAT_CHANNEL)
      .orderBy('m.created_at', 'asc')
      .execute();

    return this.decorate(rows, db);
  }

  /**
   * Soft-delete a message. Author, admin, or manager.
   *
   * Tombstoned rather than removed: the thread's replies must survive, and a hard
   * delete would take them via the parent_id FK or strand them behind it.
   */
  async remove(id: string, currentUser: CurrentUser, trx: Executor): Promise<{ deleted: true }> {
    await this.assertAccess(currentUser, trx);

    const row = await softDeletable(trx.selectFrom('messages').select(['id', 'sender_id']))
      .where('id', '=', id)
      .where('channel', '=', CHAT_CHANNEL)
      .executeTakeFirst();
    if (!row) {
      throw new AppError('RESOURCE_NOT_FOUND', `Message ${id} does not exist.`);
    }

    const isAuthor = row.sender_id === currentUser.staffId;
    const isModerator = currentUser.role === 'admin' || currentUser.role === 'manager';
    if (!isAuthor && !isModerator) {
      throw new AppError('PERMISSION_DENIED', 'You can only delete your own messages.');
    }

    // softDelete lives in lib/queries.ts, NOT on BaseService (Sprint 9 as-built).
    await softDelete('messages', id, currentUser.staffId, trx);
    return { deleted: true };
  }

  /**
   * Full-text search over the common channel.
   *
   * DELIBERATELY SEPARATE from Sprint 9's /v1/search: `messages` is not one of global
   * search's four categories (ADR-015), and merging them would put chat content into a
   * palette that freelancers can open without `chat.access`.
   */
  async search(
    q: string,
    currentUser: CurrentUser,
    db: Executor,
    limit = 30,
  ): Promise<ChatMessageDTO[]> {
    await this.assertAccess(currentUser, db);

    const term = q.trim();
    if (term.length === 0) return [];

    const rows = await this.baseSelect(db)
      .where('m.channel', '=', CHAT_CHANNEL)
      .where(sql<boolean>`m.search_vector @@ websearch_to_tsquery('english', ${term})`)
      .orderBy(sql`ts_rank(m.search_vector, websearch_to_tsquery('english', ${term}))`, 'desc')
      .orderBy('m.created_at', 'desc')
      .limit(limit)
      .execute();

    return this.decorate(rows, db);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * The ONE row shape every read uses. list, getThread and search all select through
   * here so they cannot disagree about what a message looks like — three private
   * copies of this join is how a field ends up present on one endpoint and missing
   * from another.
   *
   * `softDeletable` is NOT applied: `list` and `getThread` need tombstones so the UI
   * can render "Message deleted" in place rather than silently reflowing the
   * conversation. `decorate` marks them and blanks their content.
   */
  private baseSelect(db: Executor) {
    return db
      .selectFrom('messages as m')
      .leftJoin('staff as s', 's.id', 'm.sender_id')
      .select([
        'm.id as id',
        'm.channel as channel',
        'm.sender_id as sender_id',
        's.name as sender_name',
        's.avatar_url as sender_avatar_url',
        'm.content as content',
        'm.parent_id as parent_id',
        'm.deleted_at as deleted_at',
        'm.created_at as created_at',
      ]);
  }

  /** Attach mentions and reply counts in two queries, never per row (N+1). */
  private async decorate(rows: ChatRow[], db: Executor): Promise<ChatMessageDTO[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const [mentionRows, replyRows] = await Promise.all([
      db
        .selectFrom('message_mentions as mm')
        .innerJoin('staff as s', 's.id', 'mm.staff_id')
        .select(['mm.message_id as message_id', 'mm.staff_id as staff_id', 's.name as name'])
        .where('mm.message_id', 'in', ids)
        .execute(),
      db
        .selectFrom('messages')
        .select(['parent_id', (eb) => eb.fn.countAll<string>().as('count')])
        .where('parent_id', 'in', ids)
        .where('deleted_at', 'is', null)
        .groupBy('parent_id')
        .execute(),
    ]);

    const mentionsByMessage = new Map<string, ChatMentionDTO[]>();
    for (const m of mentionRows) {
      const list = mentionsByMessage.get(m.message_id) ?? [];
      list.push({ staffId: m.staff_id, name: m.name });
      mentionsByMessage.set(m.message_id, list);
    }
    const repliesByParent = new Map(replyRows.map((r) => [r.parent_id!, Number(r.count)]));

    return rows.map((r) => {
      const isDeleted = r.deleted_at !== null;
      return {
        id: r.id,
        channel: r.channel as 'common',
        senderId: r.sender_id,
        senderName: r.sender_name,
        senderAvatarUrl: r.sender_avatar_url,
        // A tombstone must not ship the original text — "deleted" that still sends the
        // content over the wire is not deleted, it is hidden in the client.
        content: isDeleted ? '' : r.content,
        parentId: r.parent_id,
        mentions: isDeleted ? [] : (mentionsByMessage.get(r.id) ?? []),
        replyCount: repliesByParent.get(r.id) ?? 0,
        isDeleted,
        createdAt: r.created_at.toISOString(),
      };
    });
  }

  /**
   * Resolve @names to active staff. Case-insensitive exact match on display name —
   * fuzzy matching would let "@Ra" notify Rahul, and a notification sent to the wrong
   * person is worse than one not sent.
   *
   * An exact match can still be AMBIGUOUS: display names are not unique. Every
   * staff member carrying the matched name is returned, deduped by id — see the
   * note at the Map below for why that beats picking one or refusing.
   */
  private async resolveMentions(content: string, db: Executor): Promise<ChatMentionDTO[]> {
    const sites = parseMentionCandidates(content);
    if (sites.length === 0) return [];

    // One query for every candidate across every @-site. Case-insensitive EXACT match:
    // fuzzy matching would let "@Ra" notify Rahul, and a notification delivered to the
    // wrong person is worse than one not delivered at all.
    const allCandidates = [...new Set(sites.flat().map((c) => c.toLowerCase()))];
    const rows = await softDeletable(db.selectFrom('staff').select(['id', 'name']))
      .where('active', '=', true)
      .where(sql<boolean>`lower(name) = ANY(${allCandidates})`)
      .execute();

    // ⭐ EVERY staff member with this name, not the last row to be inserted.
    //
    // This was `new Map(rows.map((r) => [name, r]))`, which silently kept one of
    // them — so with two active people called "Priya", `@Priya` notified an
    // arbitrary one and the other never heard about it. No error, nothing for the
    // author to notice, and the composer offers the two identically, so they
    // could not have corrected it if they had.
    //
    // Notifying every match trades that silent misdirection for over-notification:
    // the intended person is always in the set, and the others are in a COMMON
    // channel where they can already read the message, so the cost is a spurious
    // bell — not private information going to the wrong desk. Refusing an
    // ambiguous mention was the alternative and it is worse: it makes a real
    // colleague permanently unmentionable.
    //
    // ponytail: identity by display string, deliberately. The clean fix is for the
    // composer — which already made the author pick a specific person — to carry
    // the chosen staffId through the send payload, so this never re-derives an id
    // from a name. Only load-bearing if two ACTIVE staff share a display name;
    // do it when that first happens for real.
    const byLowerName = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.name.toLowerCase();
      const bucket = byLowerName.get(key);
      if (bucket) bucket.push(r);
      else byLowerName.set(key, [r]);
    }

    const resolved: ChatMentionDTO[] = [];
    const seen = new Set<string>();

    for (const candidates of sites) {
      // Longest-first, so "@Rahul Menon" resolves to Rahul Menon rather than to a
      // different staff member called Rahul.
      for (const candidate of candidates) {
        const hits = byLowerName.get(candidate.toLowerCase());
        if (!hits) continue;
        for (const hit of hits) {
          if (seen.has(hit.id)) continue;
          seen.add(hit.id);
          resolved.push({ staffId: hit.id, name: hit.name });
        }
        break;
      }
    }
    return resolved;
  }

}

