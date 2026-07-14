import type { Logger } from '@guiiai/logg';

import { contentToPlainText, visitCustomEmoji } from '../adaptation/content';
import type { CanonicalAttachment } from '../adaptation/types';
import type { CompactionSessionMeta } from '../driver/types';
import type { AnimationToTextResolver } from '../media/animation-to-text';
import type { CustomEmojiResolveItem, CustomEmojiToTextResolver } from '../media/custom-emoji-to-text';
import { extractFrames } from '../media/frame-extractor';
import type { PipelineEvent } from '../pipeline';
import type { TelegramManager } from './manager';

interface PersistedEvent {
  id: number;
  event: PipelineEvent;
}

export const createTelegramPostStartupTasks = (deps: {
  manager: TelegramManager;
  animationResolvers: ReadonlyMap<string, AnimationToTextResolver>;
  customEmojiResolvers: ReadonlyMap<string, CustomEmojiToTextResolver>;
  animationMaxFrames: ReadonlyMap<string, number>;
  hasAltText: (hash: string) => boolean;
  loadCompaction: (chatId: string) => CompactionSessionMeta | null;
  loadEvents: (chatId: string, afterMs?: number) => PipelineEvent[];
  loadEventsWithId: (chatId: string, afterMs?: number) => PersistedEvent[];
  updateEventAttachments: (eventId: number, attachments: CanonicalAttachment[]) => void;
  hydrateAltText: (event: PipelineEvent) => void;
  replayChat: (chatId: string, events: PipelineEvent[]) => void;
  logger: Logger;
}) => {
  const backfillAnimations = async (): Promise<void> => {
    if (deps.animationResolvers.size === 0) return;
    const log = deps.logger.withContext('animation-backfill');

    for (const [chatId, animationResolver] of deps.animationResolvers) {
      const maxFrames = deps.animationMaxFrames.get(chatId);
      if (maxFrames == null) throw new Error(`Missing animation maxFrames for chat ${chatId}`);
      const compaction = deps.loadCompaction(chatId);
      const events = deps.loadEventsWithId(chatId, compaction?.newCursorMs);
      const tasks: Promise<void>[] = [];
      for (const { id: eventId, event } of events) {
        if (event.type !== 'message' && event.type !== 'edit') continue;
        for (const attachment of event.attachments) {
          if (attachment.animationHash && deps.hasAltText(attachment.animationHash)) continue;
          if (attachment.type === 'photo') continue;
          const isAnimation = attachment.type === 'animation';
          const isAnimatedSticker = attachment.type === 'sticker'
            && (attachment.format === 'animated' || attachment.format === 'video');
          if (!isAnimation && !isAnimatedSticker) continue;

          const caption = contentToPlainText(event.content);
          tasks.push((async () => {
            try {
              const messageId = Number(event.messageId);
              const buffer = await deps.manager.downloadMessageMedia(chatId, messageId);
              if (!buffer) {
                log.withFields({ chatId, messageId }).warn('Backfill skipped: download failed');
                return;
              }

              const source = {
                type: attachment.type,
                isAnimatedSticker: attachment.format === 'animated',
                isVideoSticker: attachment.format === 'video',
                mimeType: attachment.mimeType,
              };
              const result = await extractFrames(buffer, source, maxFrames);
              await animationResolver.resolve({
                cacheKey: result.cacheKey,
                frames: result.frames,
                caption,
                isSticker: attachment.type === 'sticker',
                stickerSetName: attachment.stickerSetName,
                duration: attachment.duration,
                frameTimestamps: result.frameTimestamps,
              });
              attachment.animationHash = result.cacheKey;
              deps.updateEventAttachments(eventId, event.attachments);
            } catch (error) {
              log.withError(error).warn('Failed to backfill animation');
            }
          })());
        }
      }
      if (tasks.length > 0) {
        log.withFields({ chatId, tasks: tasks.length }).log('Backfilling animation hashes');
        await Promise.all(tasks);
      }
    }
  };

  const resolveCustomEmoji = async (): Promise<void> => {
    for (const [chatId, customEmojiResolver] of deps.customEmojiResolvers) {
      const compaction = deps.loadCompaction(chatId);
      const events = deps.loadEvents(chatId, compaction?.newCursorMs);
      const items = new Map<string, CustomEmojiResolveItem>();
      for (const event of events) {
        if (event.type !== 'message' && event.type !== 'edit') continue;
        visitCustomEmoji(event.content, node => {
          if (items.has(node.customEmojiId)) return;
          items.set(node.customEmojiId, {
            customEmojiId: node.customEmojiId,
            fallbackEmoji: contentToPlainText(node.children),
            stickerSetName: node.stickerSetName,
          });
        });
      }
      if (items.size === 0) continue;

      deps.logger.withFields({ chatId, count: items.size }).log('Cold-start: resolving custom emoji descriptions');
      await customEmojiResolver.resolve([...items.values()]);
      for (const event of events) deps.hydrateAltText(event);
      deps.replayChat(chatId, events);
    }
  };

  return {
    async run(): Promise<void> {
      await backfillAnimations();
      await resolveCustomEmoji();
    },
  };
};

export type TelegramPostStartupTasks = ReturnType<typeof createTelegramPostStartupTasks>;
