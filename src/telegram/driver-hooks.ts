import { execFile } from 'node:child_process';

import { adaptMessage } from './adaptation';
import type { BotInfo, SentMessage } from './bot';
import type { TelegramEventSink } from './event-sink';
import type { IngressTelegramMessage } from './ingress-meta';
import type { TelegramManager } from './manager';
import { renderMarkdownToTelegramHTML } from './markdown';
import type { RuntimeConfig } from '../config/config';
import type { SendMessageAttachment } from '../driver/tools';
import type { Attachment } from './message/types';

export const createTelegramDriverHooks = (deps: {
  manager: TelegramManager;
  runtime: RuntimeConfig;
  botUserId: string;
  eventSink: TelegramEventSink;
}) => {
  const readWorkspaceFile = (path: string): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
      const command = deps.runtime.readFile;
      const child = execFile(
        command[0]!,
        [...command.slice(1), path],
        {
          timeout: 60_000,
          maxBuffer: deps.runtime.readFileSizeLimit + 1024,
          encoding: null,
        },
        (error, stdout) => {
          if (error) {
            reject(new Error(`readFile failed: ${error.message}`));
            return;
          }
          if (stdout.length > deps.runtime.readFileSizeLimit) {
            reject(new Error(`File too large: ${stdout.length} bytes exceeds limit of ${deps.runtime.readFileSizeLimit} bytes`));
            return;
          }
          resolve(stdout);
        },
      );
      if (!child.stdin) throw new Error('Runtime read command has no stdin stream');
      child.stdin.end();
    });

  const sendSingleMedia = async (
    chatId: string,
    type: SendMessageAttachment['type'],
    buffer: Buffer,
    caption?: string,
    replyToMessageId?: number,
    fileName?: string,
  ): Promise<SentMessage> => {
    const options = {
      caption,
      captionParseMode: caption ? 'HTML' as const : undefined,
      replyToMessageId,
      fileName,
    };
    switch (type) {
    case 'photo': return await deps.manager.sendPhoto(chatId, buffer, options);
    case 'video': return await deps.manager.sendVideo(chatId, buffer, options);
    case 'audio': return await deps.manager.sendAudio(chatId, buffer, options);
    case 'voice': return await deps.manager.sendVoice(chatId, buffer, options);
    case 'animation': return await deps.manager.sendAnimation(chatId, buffer, options);
    case 'video_note': return await deps.manager.sendVideoNote(chatId, buffer, options);
    case 'document': return await deps.manager.sendDocument(chatId, buffer, options);
    }
  };

  const injectSyntheticEvent = (
    chatId: string,
    sent: SentMessage,
    bot: BotInfo,
    replyToMessageId?: number,
    attachments?: SendMessageAttachment[],
  ): void => {
    const message: IngressTelegramMessage = {
      messageId: sent.messageId,
      chatId,
      sender: {
        id: deps.botUserId,
        firstName: bot.firstName,
        username: bot.username,
        isBot: true,
        isPremium: false,
      },
      date: sent.date,
      text: sent.text,
      replyToMessageId,
      attachments: attachments?.map((attachment): Attachment => ({
        type: attachment.type,
        fileName: attachment.file_name,
      })),
      source: 'bot',
      receivedAtMs: Date.now(),
      utcOffsetMin: -new Date().getTimezoneOffset(),
    };
    const event = adaptMessage(message);
    event.isSelfSent = true;
    deps.eventSink.accept(event, { notifyDriver: false });
  };

  const sendMessage = async (
    chatId: string,
    text: string,
    replyToMessageId?: number,
    attachments?: SendMessageAttachment[],
  ): Promise<SentMessage> => {
    const bot = deps.manager.bot.botInfo();
    if (!bot) throw new Error('Bot identity is unavailable before send');

    if (!attachments || attachments.length === 0) {
      const sent = await deps.manager.sendMessage(
        chatId,
        text,
        replyToMessageId ? { replyToMessageId } : undefined,
      );
      injectSyntheticEvent(chatId, sent, bot, replyToMessageId);
      return sent;
    }

    const buffers = await Promise.all(attachments.map(attachment => readWorkspaceFile(attachment.path)));
    const caption = text ? renderMarkdownToTelegramHTML(text) : undefined;

    if (attachments.length === 1) {
      const attachment = attachments[0]!;
      const sent = await sendSingleMedia(
        chatId,
        attachment.type,
        buffers[0]!,
        caption,
        replyToMessageId,
        attachment.file_name,
      );
      injectSyntheticEvent(chatId, sent, bot, replyToMessageId, attachments);
      return sent;
    }

    const mediaGroupTypes = new Set(['photo', 'video', 'audio', 'document']);
    const normalizedAttachments = attachments.map(attachment => ({
      ...attachment,
      type: (mediaGroupTypes.has(attachment.type) ? attachment.type : 'document') as 'photo' | 'video' | 'audio' | 'document',
    }));
    const media = normalizedAttachments.map((attachment, index) => ({
      type: attachment.type,
      buffer: buffers[index]!,
      fileName: attachment.file_name,
      caption: index === 0 ? caption : undefined,
      captionParseMode: index === 0 && caption ? 'HTML' as const : undefined,
    }));
    const sent = await deps.manager.sendMediaGroup(
      chatId,
      media,
      replyToMessageId ? { replyToMessageId } : undefined,
    );
    sent.forEach((message, index) =>
      injectSyntheticEvent(chatId, message, bot, replyToMessageId, [normalizedAttachments[index]!]));
    return sent[0]!;
  };

  return {
    sendMessage,
    sendTypingAction: (chatId: string) => deps.manager.sendChatAction(chatId),
    setMessageReaction: (chatId: string, messageId: number, emoji: string | undefined) =>
      deps.manager.setMessageReaction(chatId, messageId, emoji),
    onDebounceStateChange: (chatId: string, isDebouncing: boolean): void => {
      if (isDebouncing) deps.manager.startTypingPolling(chatId);
      else deps.manager.stopTypingPolling(chatId);
    },
    downloadMessageMedia: (chatId: string, messageId: number) =>
      deps.manager.downloadMessageMedia(chatId, messageId),
  };
};

export type TelegramDriverHooks = ReturnType<typeof createTelegramDriverHooks>;
