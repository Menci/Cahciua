import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DB } from './client';
import { events } from './schema';

export const findModerationSender = (db: DB, chatId: string, messageId: number): string | undefined =>
  db.select({ senderId: events.senderId })
    .from(events)
    .where(and(
      eq(events.chatId, chatId),
      eq(events.messageId, String(messageId)),
      inArray(events.type, ['message', 'edit']),
    ))
    .orderBy(events.id)
    .limit(1)
    .get()?.senderId ?? undefined;

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
