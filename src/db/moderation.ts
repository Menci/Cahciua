import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DB } from './client';
import { events, users } from './schema';

/**
 * The archived author of an evidence message, with the username observed at
 * ingress. MTProto access hashes are account-scoped, so the bot cannot reuse
 * the userbot's handle; the username lets the bot resolve its own.
 */
export const findModerationAuthor = (db: DB, chatId: string, messageId: number): { userId: string; username?: string } | undefined => {
  const row = db.select({ senderId: events.senderId, username: users.username })
    .from(events)
    .leftJoin(users, eq(users.id, events.senderId))
    .where(and(
      eq(events.chatId, chatId),
      eq(events.messageId, String(messageId)),
      inArray(events.type, ['message', 'edit']),
    ))
    .orderBy(events.id)
    .limit(1)
    .get();
  return row?.senderId
    ? { userId: row.senderId, ...(row.username ? { username: row.username } : {}) }
    : undefined;
};

export const loadModerationMessageIds = (db: DB, chatId: string, userId: string): number[] =>
  db.selectDistinct({ messageId: sql<number>`cast(${events.messageId} as integer)` })
    .from(events)
    .where(and(
      eq(events.chatId, chatId),
      eq(events.senderId, userId),
      inArray(events.type, ['message', 'edit']),
    ))
    .all()
    .map(message => message.messageId);
