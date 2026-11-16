import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DB } from './client';
import { events } from './schema';

/**
 * The archived author of an evidence message. This is the only input moderation
 * needs to identify a target, so an account stays actionable after its message
 * is gone.
 */
export const findModerationAuthor = (db: DB, chatId: string, messageId: number): { userId: string } | undefined => {
  const row = db.select({ senderId: events.senderId })
    .from(events)
    .where(and(
      eq(events.chatId, chatId),
      eq(events.messageId, String(messageId)),
      inArray(events.type, ['message', 'edit']),
    ))
    .orderBy(events.id)
    .limit(1)
    .get();
  return row?.senderId ? { userId: row.senderId } : undefined;
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
