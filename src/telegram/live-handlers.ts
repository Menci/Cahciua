import type { Logger } from '@guiiai/logg';

import { adaptDelete, adaptEdit, adaptMessage, adaptServiceEvent, isServiceMessage } from './adaptation';
import type { TelegramEventSink } from './event-sink';
import type { IngressTelegramMessageDelete } from './ingress-meta';
import type { TelegramManager } from './manager';
import { contentToPlainText } from '../adaptation/content';
import type { CanonicalIMEvent, ContentNode } from '../adaptation/types';
import type { Attachment, TelegramMessage, TelegramMessageEdit } from './message/types';

export interface TelegramMessageStore {
  loadLatestMessageContent(chatId: string, messageId: string): {
    text: string | null;
    content: ContentNode[] | null;
    attachments: Attachment[] | null;
  } | undefined;
  persistMessage(message: TelegramMessage): void;
  persistMessageEdit(edit: TelegramMessageEdit): void;
  persistMessageDelete(deletion: IngressTelegramMessageDelete): void;
}

export const createTelegramLiveHandlers = (deps: {
  manager: TelegramManager;
  eventSink: TelegramEventSink;
  messageStore: TelegramMessageStore;
  handleTyping: (chatId: string) => void;
  logger: Logger;
}) => {
  const canonicalEvents = new WeakMap<object, CanonicalIMEvent>();
  const platformPersisted = new WeakSet<object>();

  const canonicalEvent = <T extends CanonicalIMEvent>(
    ingress: object,
    adapt: () => T,
  ): T => {
    const existing = canonicalEvents.get(ingress);
    if (existing) return existing as T;
    const event = adapt();
    canonicalEvents.set(ingress, event);
    return event;
  };

  const persist = (
    ingress: object,
    event: CanonicalIMEvent,
    persistPlatform: () => void,
  ): void => {
    if (platformPersisted.has(ingress)) return;
    persistPlatform();
    deps.eventSink.persist(event);
    platformPersisted.add(ingress);
  };

  const start = (): void => {
    deps.manager.onMessage(message => {
      if (isServiceMessage(message)) {
        const event = canonicalEvent(message, () => adaptServiceEvent(message));
        deps.logger.withFields({
          source: message.source,
          chatId: message.chatId,
          action: event.action.action,
        }).log('Service event received');
        deps.eventSink.accept(event, { hydrateAltText: false });
        return;
      }

      deps.logger.withFields({
        source: message.source,
        chatId: message.chatId,
        messageId: message.messageId,
        sender: message.sender?.username ?? message.sender?.firstName ?? message.sender?.id ?? 'unknown',
        text: message.text.length > 100 ? `${message.text.slice(0, 100)}...` : message.text,
        length: message.text.length,
      }).log('Message received');

      const event = canonicalEvent(message, () => adaptMessage(message));
      persist(message, event, () => deps.messageStore.persistMessage(message));
      deps.eventSink.publish(event);
    });

    deps.manager.onMessageEdit(edit => {
      deps.logger.withFields({
        chatId: edit.chatId,
        messageId: edit.messageId,
        sender: edit.sender?.username ?? edit.sender?.firstName ?? edit.sender?.id ?? 'unknown',
        text: edit.text.length > 100 ? `${edit.text.slice(0, 100)}...` : edit.text,
        length: edit.text.length,
      }).log('Message edited');

      const event = canonicalEvent(edit, () => adaptEdit(edit));
      if (!platformPersisted.has(edit)) {
        const previous = deps.messageStore.loadLatestMessageContent(event.chatId, event.messageId);
        if (previous) {
          const plainText = contentToPlainText(event.content);
          const text = plainText === '' ? null : plainText;
          const content = event.content.length > 0 ? event.content : null;
          const attachments = event.attachments.length > 0 ? event.attachments : null;
          if (previous.text === text
            && JSON.stringify(previous.content) === JSON.stringify(content)
            && JSON.stringify(previous.attachments) === JSON.stringify(attachments)) {
            deps.logger.withFields({ chatId: edit.chatId, messageId: edit.messageId }).log('Phantom edit skipped (content unchanged)');
            return;
          }
        }
      }

      persist(edit, event, () => deps.messageStore.persistMessageEdit(edit));
      deps.eventSink.publish(event);
    });

    deps.manager.onTyping(typing => deps.handleTyping(typing.chatId));

    deps.manager.onMessageDelete(deletion => {
      deps.logger.withFields({
        chatId: deletion.chatId,
        messageIds: deletion.messageIds,
      }).log('Message deleted');

      const event = canonicalEvent(deletion, () => adaptDelete(deletion));
      persist(deletion, event, () => deps.messageStore.persistMessageDelete(deletion));
      deps.eventSink.publish(event, { hydrateAltText: false });
    });
  };

  return { start };
};

export type TelegramLiveHandlers = ReturnType<typeof createTelegramLiveHandlers>;
