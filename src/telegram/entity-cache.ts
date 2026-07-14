import type * as Td from 'tdlib-types';

import type { TelegramUser } from './message';
import { firstNonEmptyString, nonEmptyString } from './tdlib-string';

export interface EntityCache {
  putUser(u: Td.user): void;
  putChat(c: Td.chat): void;
  resolveUser(userId: number | string): TelegramUser | undefined;
  resolveChatAsUser(chatId: number | string): TelegramUser | undefined;
}

const userToCanonical = (u: Td.user): TelegramUser => ({
  id: String(u.id),
  firstName: u.first_name,
  lastName: nonEmptyString(u.last_name),
  username: firstNonEmptyString(
    u.usernames?.editable_username,
    u.usernames?.active_usernames?.[0],
  ),
  isBot: u.type._ === 'userTypeBot',
  isPremium: u.is_premium,
});

const chatToCanonical = (c: Td.chat): TelegramUser => ({
  id: String(c.id),
  firstName: c.title,
  isBot: false,
  isPremium: false,
});

export const createEntityCache = (): EntityCache => {
  const users = new Map<number, Td.user>();
  const chats = new Map<number, Td.chat>();

  return {
    putUser: u => { users.set(u.id, u); },
    putChat: c => { chats.set(c.id, c); },
    resolveUser: id => {
      const u = users.get(typeof id === 'string' ? Number(id) : id);
      return u ? userToCanonical(u) : undefined;
    },
    resolveChatAsUser: id => {
      const c = chats.get(typeof id === 'string' ? Number(id) : id);
      return c ? chatToCanonical(c) : undefined;
    },
  };
};
