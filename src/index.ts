import { execFile } from 'node:child_process';

import { adaptDelete, adaptEdit, adaptMessage, adaptServiceEvent, contentToPlainText, isServiceMessage } from './adaptation';
import type { CanonicalIMEvent, ContentNode } from './adaptation/types';
import { getChatIds, loadConfig, resolveChatConfig, resolveModel, resolveRuntime } from './config/config';
import { setupLogger, useLogger } from './config/logger';
import { loadContacts } from './contacts';
import { createDatabase, loadCompaction, loadEvents, loadEventsWithId, loadImageAltTextByHash, loadKnownChatIds, loadLastProbeTime, loadLatestMessageContent, loadMessageAttachments, loadMessageFileId, loadTurnResponses, lookupChatId, persistCompaction, persistEvent, persistImageAltText, persistMessage, persistMessageDelete, persistMessageEdit, persistProbeResponse, persistTurnResponse, runMigrations, updateEventAttachments } from './db';
import { createDriver } from './driver';
import { createPipeline } from './pipeline';
import type { RenderParams } from './rendering';
import { createTelegramManager } from './telegram';
import { createAnimationToTextResolver } from './telegram/animation-to-text';
import { createCustomEmojiToTextResolver, emojiCacheKey } from './telegram/custom-emoji-to-text';
import { canExtractFrames, extractFrames } from './telegram/frame-extractor';
import { computeThumbnailHash, createImageToTextResolver } from './telegram/image-to-text';
import type { Attachment } from './telegram/message/types';
import { renderMarkdownToTelegramHTML } from './telegram/markdown';
import { loadSession } from './telegram/session';

setupLogger();

const logger = useLogger('cahciua');

const main = async () => {
  const config = loadConfig();
  const runtimeConfig = resolveRuntime(config);

  const chatIds = getChatIds(config);

  // Validate runtime config against tool enablement
  for (const chatId of chatIds) {
    const chatConfig = resolveChatConfig(config, chatId);
    if (chatConfig.tools.bash.enabled && runtimeConfig.shell.length === 0)
      throw new Error(`Chat ${chatId} has bash.enabled=true but runtime.shell is not configured`);
    if (chatConfig.tools.downloadFile.enabled && !runtimeConfig.writeFile)
      throw new Error(`Chat ${chatId} has downloadFile.enabled=true but runtime.writeFile is not configured`);
    if (chatConfig.tools.sendMessage.enableAttachments && !runtimeConfig.readFile)
      throw new Error(`Chat ${chatId} has sendMessage.enableAttachments=true but runtime.readFile is not configured`);
  }

  // Compute per-chat image-to-text enablement
  const imageToTextChatIds = new Set(
    chatIds.filter(id => resolveChatConfig(config, id).imageToText.enabled),
  );

  // Use default chat config's imageToText model for the shared resolver
  const defaultChatConfig = resolveChatConfig(config, 'default');
  if (imageToTextChatIds.size > 0 && !defaultChatConfig.imageToText.model)
    throw new Error('imageToText.model is required when imageToText.enabled=true (in chats.default or per-chat override)');

  // Compute per-chat animation-to-text enablement
  const animationToTextChatIds = new Set(
    chatIds.filter(id => resolveChatConfig(config, id).animationToText.enabled),
  );
  if (animationToTextChatIds.size > 0 && !defaultChatConfig.animationToText.model)
    throw new Error('animationToText.model is required when animationToText.enabled=true (in chats.default or per-chat override)');

  // Compute per-chat custom-emoji-to-text enablement
  const customEmojiToTextChatIds = new Set(
    chatIds.filter(id => resolveChatConfig(config, id).customEmojiToText.enabled),
  );
  if (customEmojiToTextChatIds.size > 0 && !defaultChatConfig.customEmojiToText.model)
    throw new Error('customEmojiToText.model is required when customEmojiToText.enabled=true (in chats.default or per-chat override)');

  const db = createDatabase(config.database.path, logger);
  runMigrations(db, logger);

  // Image-to-text resolver — shared between cold-start replay and live ingress.
  const imageToTextResolver = createImageToTextResolver({
    enabled: imageToTextChatIds.size > 0,
    model: defaultChatConfig.imageToText.model ? resolveModel(config, defaultChatConfig.imageToText.model) : undefined,
    logger,
    lookupByHash: imageHash => loadImageAltTextByHash(db, imageHash),
    persist: record => persistImageAltText(db, record),
  });

  // Animation-to-text resolver — same pattern, for GIF/animated sticker descriptions.
  const animationToTextResolver = createAnimationToTextResolver({
    enabled: animationToTextChatIds.size > 0,
    model: defaultChatConfig.animationToText.model ? resolveModel(config, defaultChatConfig.animationToText.model) : undefined,
    logger,
    lookupByHash: hash => loadImageAltTextByHash(db, hash),
    persist: record => persistImageAltText(db, record),
  });

  // Custom-emoji-to-text resolver — resolves custom emoji sticker images/animations to descriptions.
  // Bot API functions are bound lazily via closure over `ref` (telegram manager is created after resolver).
  const ref: { telegram?: ReturnType<typeof createTelegramManager> } = {};
  const customEmojiToTextResolver = createCustomEmojiToTextResolver({
    enabled: customEmojiToTextChatIds.size > 0,
    model: defaultChatConfig.customEmojiToText.model ? resolveModel(config, defaultChatConfig.customEmojiToText.model) : undefined,
    maxFrames: defaultChatConfig.customEmojiToText.maxFrames,
    logger,
    lookupByHash: hash => loadImageAltTextByHash(db, hash),
    persist: record => persistImageAltText(db, record),
    getCustomEmojiStickers: async ids => {
      const bot = ref.telegram!.bot.raw();
      return await bot.api.getCustomEmojiStickers(ids);
    },
    downloadFile: async fileId => {
      return await ref.telegram!.bot.downloadFile(fileId);
    },
    resolvePackTitle: async setName => {
      return await ref.telegram!.resolvePackTitle(setName);
    },
  });

  // Sync hydration: after persistEvent, set altText transiently on canonical
  // attachments and custom_emoji content nodes from the image_alt_texts table.
  // This is a sync DB lookup (better-sqlite3) — never stored back into events.
  const walkCustomEmoji = (nodes: ContentNode[], fn: (node: Extract<ContentNode, { type: 'custom_emoji' }>) => void) => {
    for (const n of nodes) {
      if (n.type === 'custom_emoji') fn(n);
      if ('children' in n) walkCustomEmoji(n.children, fn);
    }
  };

  const hydrateAltTextFromCache = (event: CanonicalIMEvent) => {
    if (event.type !== 'message' && event.type !== 'edit') return;
    for (const att of event.attachments) {
      if (att.altText) continue;
      if (att.thumbnailWebp && imageToTextChatIds.size > 0) {
        const cached = loadImageAltTextByHash(db, computeThumbnailHash(att.thumbnailWebp));
        if (cached) { att.altText = cached.altText; continue; }
      }
      if (att.animationHash && animationToTextChatIds.size > 0) {
        const cached = loadImageAltTextByHash(db, att.animationHash);
        if (cached) {
          att.altText = cached.altText;
          if (cached.stickerSetName) att.stickerSetName = cached.stickerSetName;
        }
      }
    }
    // Hydrate custom_emoji altText + stickerSetName from cache
    if (customEmojiToTextChatIds.size > 0) {
      walkCustomEmoji(event.content, node => {
        if (node.altText) return;
        const cached = loadImageAltTextByHash(db, emojiCacheKey(node.customEmojiId));
        if (cached) {
          node.altText = cached.altText;
          if (cached.stickerSetName) node.stickerSetName = cached.stickerSetName;
        } else {
          const error = customEmojiToTextResolver.getError(node.customEmojiId);
          if (error) node.altTextError = error;
        }
      });
    }
  };

  // Bot user ID from token — available immediately, used for myself detection
  const botUserId = config.telegram.botToken.split(':')[0]!;
  const contactNames = loadContacts(logger);
  const renderParams: RenderParams = { botUserId, contactNames };

  const pipeline = createPipeline(renderParams);

  // Cold-start: replay events per chat to rebuild IC + RC.
  // If a compaction cursor exists, only load events from that point onward —
  // older events are summarised and no longer needed for IC or rendering.
  for (const chatId of loadKnownChatIds(db)) {
    const compaction = loadCompaction(db, chatId);
    if (compaction)
      pipeline.setCompactCursor(chatId, compaction.newCursorMs);
    const events = loadEvents(db, chatId, compaction?.newCursorMs);
    if (imageToTextChatIds.has(chatId)) {
      const tasks: Promise<void>[] = [];
      for (const event of events) {
        if ((event.type === 'message' || event.type === 'edit') && event.attachments.length > 0) {
          const caption = contentToPlainText(event.content);
          tasks.push(imageToTextResolver.hydrateCanonicalAttachments(event.attachments, caption));
        }
      }
      if (tasks.length > 0) await Promise.all(tasks);
    }
    // Sync-hydrate: set altText transiently from cache (covers both image and animation)
    for (const event of events) hydrateAltTextFromCache(event);
    pipeline.replayChat(chatId, events);
  }
  logger.withFields({ sessions: pipeline.getChatIds().length }).log('Cold start complete');

  const hasUserbot = config.telegram.apiId != null && config.telegram.apiHash != null;

  const telegram = createTelegramManager({
    botToken: config.telegram.botToken,
    ...(hasUserbot ? {
      apiId: config.telegram.apiId,
      apiHash: config.telegram.apiHash,
      session: loadSession(config.telegram.session ?? ''),
    } : {}),
    initialChatIds: loadKnownChatIds(db),
    resolveChatId: messageIds => lookupChatId(db, messageIds),
    imageToText: imageToTextChatIds.size > 0 ? imageToTextResolver : undefined,
    imageToTextChatIds,
    animationToText: animationToTextChatIds.size > 0 ? animationToTextResolver : undefined,
    animationToTextChatIds,
    animationMaxFrames: defaultChatConfig.animationToText.maxFrames,
    customEmojiToText: customEmojiToTextChatIds.size > 0 ? customEmojiToTextResolver : undefined,
    customEmojiToTextChatIds,
  }, logger);
  ref.telegram = telegram;

  // Helper: read a file from the workspace via the configured readFile command.
  const readWorkspaceFile = (path: string): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
      const cmd = runtimeConfig.readFile!;
      const child = execFile(
        cmd[0]!,
        [...cmd.slice(1), path],
        { timeout: 60_000, maxBuffer: runtimeConfig.readFileSizeLimit + 1024, encoding: 'buffer' as BufferEncoding },
        (error, stdout) => {
          if (error) return reject(new Error(`readFile failed: ${error.message}`));
          const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
          if (buf.length > runtimeConfig.readFileSizeLimit)
            return reject(new Error(`File too large: ${buf.length} bytes exceeds limit of ${runtimeConfig.readFileSizeLimit} bytes`));
          resolve(buf);
        },
      );
      // Ensure stdin is closed so the child process can exit
      child.stdin?.end();
    });

  // Helper: send a media attachment via the appropriate Bot API method.
  const sendSingleMedia = async (
    chatId: string,
    type: string,
    buffer: Buffer,
    caption?: string,
    replyToMessageId?: number,
    fileName?: string,
  ) => {
    const opts = {
      caption,
      captionParseMode: caption ? 'HTML' as const : undefined,
      replyToMessageId,
      fileName,
    };
    switch (type) {
    case 'photo': return await telegram.sendPhoto(chatId, buffer, opts);
    case 'video': return await telegram.sendVideo(chatId, buffer, opts);
    case 'audio': return await telegram.sendAudio(chatId, buffer, opts);
    case 'voice': return await telegram.sendVoice(chatId, buffer, opts);
    case 'animation': return await telegram.sendAnimation(chatId, buffer, opts);
    case 'video_note': return await telegram.sendVideoNote(chatId, buffer, opts);
    case 'document':
    default: return await telegram.sendDocument(chatId, buffer, { ...opts, fileName });
    }
  };

  // Helper: create a synthetic event for a bot-sent message and inject into pipeline.
  const injectSyntheticEvent = (chatId: string, sent: { messageId: number; date: number; text: string; entities?: import('./telegram/message/types').MessageEntity[] }, replyToMessageId?: number) => {
    const botInfo = telegram.bot.botInfo();
    const syntheticMsg = {
      messageId: sent.messageId,
      chatId,
      sender: {
        id: botUserId,
        firstName: botInfo?.firstName ?? 'Bot',
        username: botInfo?.username,
        isBot: true,
        isPremium: false,
      },
      date: sent.date,
      text: sent.text,
      entities: sent.entities,
      replyToMessageId,
      source: 'bot' as const,
    };
    const event = adaptMessage(syntheticMsg);
    event.isSelfSent = true;

    const ic = pipeline.getIC(chatId);
    if (ic?.nodes.some(n => n.type === 'message' && n.messageId === event.messageId))
      logger.withFields({ chatId, messageId: event.messageId }).warn('Synthetic bypass: userbot arrived first (isSelfSent merged via dedup)');

    persistEvent(db, event);
    hydrateAltTextFromCache(event);
    pipeline.pushEvent(chatId, event);
  };

  const driver = createDriver({
    chatIds,
    resolveChatConfig: id => resolveChatConfig(config, id),
  }, {
    loadTurnResponses: (chatId, afterMs) => loadTurnResponses(db, chatId, afterMs),
    persistTurnResponse: (chatId, tr) => persistTurnResponse(db, chatId, tr),
    persistProbeResponse: (chatId, probe) => persistProbeResponse(db, chatId, probe),
    // TODO: introduce async background tasks for large file transfers
    sendMessage: async (chatId, text, replyToMessageId, attachments) => {
      // --- Text-only message ---
      if (!attachments || attachments.length === 0) {
        const sent = await telegram.sendMessage(chatId, text, replyToMessageId ? { replyToMessageId } : undefined);
        injectSyntheticEvent(chatId, sent, replyToMessageId);
        return sent;
      }

      // --- Message with attachments ---
      // Read all files from workspace
      const buffers = await Promise.all(
        attachments.map(att => readWorkspaceFile(att.path)),
      );

      const htmlCaption = text ? renderMarkdownToTelegramHTML(text) : undefined;

      if (attachments.length === 1) {
        // Single attachment — use type-specific send method
        const att = attachments[0]!;
        const sent = await sendSingleMedia(chatId, att.type, buffers[0]!, htmlCaption, replyToMessageId, att.file_name);
        injectSyntheticEvent(chatId, sent, replyToMessageId);
        return sent;
      }

      // Multiple attachments — use sendMediaGroup
      // Map to MediaGroupItem (only photo, video, audio, document allowed in media groups)
      const mediaGroupTypes = new Set(['photo', 'video', 'audio', 'document']);
      const media = attachments.map((att, i) => ({
        type: (mediaGroupTypes.has(att.type) ? att.type : 'document') as 'photo' | 'video' | 'audio' | 'document',
        buffer: buffers[i]!,
        fileName: att.file_name,
        caption: i === 0 ? htmlCaption : undefined,
        captionParseMode: i === 0 && htmlCaption ? 'HTML' as const : undefined,
      }));

      const sentMessages = await telegram.sendMediaGroup(chatId, media, replyToMessageId ? { replyToMessageId } : undefined);

      // Inject synthetic events for each sent message in the group
      for (const sent of sentMessages) {
        injectSyntheticEvent(chatId, sent, replyToMessageId);
      }

      // Return the first message's info
      return sentMessages[0]!;
    },
    loadCompaction: chatId => loadCompaction(db, chatId),
    loadLastProbeTime: chatId => loadLastProbeTime(db, chatId),
    persistCompaction: (chatId, meta) => persistCompaction(db, chatId, meta),
    setCompactCursor: (chatId, cursorMs) => pipeline.setCompactCursor(chatId, cursorMs),
    runtimeConfig,
    loadMessageAttachments: (chatId, messageId) => loadMessageAttachments(db, chatId, messageId),
    downloadFile: fileId => telegram.bot.downloadFile(fileId),
    downloadMessageMedia: telegram.userbot
      ? (chatId, messageId) => telegram.userbot!.downloadMessageMedia(chatId, messageId)
      : undefined,
    logger,
  });

  logger.withFields({ chatIds }).log('Driver initialized');

  // Feed replayed sessions into Driver so it can respond to un-answered messages
  // and trigger compaction check if context exceeds budget (compaction effect fires
  // automatically when conditions are met — no explicit startup trigger needed).
  for (const chatId of pipeline.getChatIds()) {
    const rc = pipeline.getRC(chatId);
    if (rc) driver.handleEvent(chatId, rc);
  }

  telegram.onMessage(msg => {
    // Service messages (join/leave/rename/pin/etc.) — route to service event path
    if (isServiceMessage(msg)) {
      const event = adaptServiceEvent(msg);
      if (event) {
        logger.withFields({
          source: msg.source,
          chatId: msg.chatId,
          action: event.action.action,
        }).log('Service event received');

        persistEvent(db, event);
        const rc = pipeline.pushEvent(event.chatId, event);
        driver.handleEvent(event.chatId, rc);
      }
      return;
    }

    logger.withFields({
      source: msg.source,
      chatId: msg.chatId,
      messageId: msg.messageId,
      sender: msg.sender?.username ?? msg.sender?.firstName ?? msg.sender?.id ?? 'unknown',
      text: msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text,
      length: msg.text.length,
    }).log('Message received');

    const event = adaptMessage(msg);
    persistEvent(db, event);
    hydrateAltTextFromCache(event);

    try { persistMessage(db, msg); } catch (err) { logger.withError(err).error('Failed to persist message'); }

    const rc = pipeline.pushEvent(event.chatId, event);
    driver.handleEvent(event.chatId, rc);
  });

  telegram.onMessageEdit(edit => {
    logger.withFields({
      chatId: edit.chatId,
      messageId: edit.messageId,
      sender: edit.sender?.username ?? edit.sender?.firstName ?? edit.sender?.id ?? 'unknown',
      text: edit.text.length > 100 ? `${edit.text.slice(0, 100)}...` : edit.text,
      length: edit.text.length,
    }).log('Message edited');

    const event = adaptEdit(edit);

    // Phantom edit detection: Telegram fires updateEditMessage with editDate set
    // for metadata-only changes (link preview resolved, reactions, client re-saves).
    // Skip if text, content, and attachments are identical to the stored event.
    const prev = loadLatestMessageContent(db, event.chatId, event.messageId);
    if (prev) {
      const newText = contentToPlainText(event.content) || null;
      const newContent = event.content.length > 0 ? event.content : null;
      const newAttachments = event.attachments.length > 0 ? event.attachments : null;
      if (prev.text === newText
        && JSON.stringify(prev.content) === JSON.stringify(newContent)
        && JSON.stringify(prev.attachments) === JSON.stringify(newAttachments)) {
        logger.withFields({ chatId: edit.chatId, messageId: edit.messageId }).log('Phantom edit skipped (content unchanged)');
        return;
      }
    }

    persistEvent(db, event);
    hydrateAltTextFromCache(event);

    try { persistMessageEdit(db, edit); } catch (err) { logger.withError(err).error('Failed to persist message edit'); }

    const rc = pipeline.pushEvent(event.chatId, event);
    driver.handleEvent(event.chatId, rc);
  });

  telegram.onMessageDelete(del => {
    logger.withFields({
      chatId: del.chatId ?? 'unknown',
      messageIds: del.messageIds,
    }).log('Message deleted');

    const event = adaptDelete(del);
    persistEvent(db, event);

    try { persistMessageDelete(db, del); } catch (err) { logger.withError(err).error('Failed to persist message delete'); }

    const rc = pipeline.pushEvent(event.chatId, event);
    driver.handleEvent(event.chatId, rc);
  });

  const shutdown = async () => {
    logger.log('Shutting down...');
    driver.stop();
    await telegram.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await telegram.start();
  logger.log('Cahciua is running');

  // Post-startup: backfill animationHash for historical events that lack it.
  // Runs after telegram.start() so download functions are available.
  if (animationToTextChatIds.size > 0) {
    const backfillLog = logger.withContext('animation-backfill');
    for (const chatId of animationToTextChatIds) {
      const compaction = loadCompaction(db, chatId);
      const eventsWithId = loadEventsWithId(db, chatId, compaction?.newCursorMs);
      const tasks: Promise<void>[] = [];
      for (const { id: eventId, event } of eventsWithId) {
        if (event.type !== 'message' && event.type !== 'edit') continue;
        for (const att of event.attachments) {
          if (att.animationHash || att.type === 'photo') continue;
          // CanonicalAttachment lacks isAnimatedSticker/isVideoSticker fields.
          // Heuristic: animation → always eligible; sticker without thumbnailWebp → animated/video sticker.
          const isAnimation = att.type === 'animation';
          const isLikelyAnimatedSticker = att.type === 'sticker' && !att.thumbnailWebp;
          if (!isAnimation && !isLikelyAnimatedSticker) continue;

          const caption = contentToPlainText(event.content);
          tasks.push((async () => {
            try {
              const messageId = parseInt(event.messageId, 10);
              if (isNaN(messageId)) return;

              // Try userbot first (works for all media), then Bot API via fileId from messages table
              let buffer = await telegram.userbot?.downloadMessageMedia(chatId, messageId);
              if (!buffer) {
                const fileId = loadMessageFileId(db, chatId, messageId);
                if (fileId) buffer = await telegram.bot.downloadFile(fileId);
              }
              if (!buffer) {
                backfillLog.withFields({ chatId, messageId }).warn('Backfill skipped: download failed');
                return;
              }

              // Reconstruct minimal Attachment for canExtractFrames/extractFrames.
              // Animated/video distinction is lost in canonical form; treat sticker
              // without thumbnail as video sticker (ffmpeg handles both WEBM and TGS-converted).
              const syntheticAtt: Attachment = {
                type: att.type as 'animation' | 'sticker',
                isVideoSticker: isLikelyAnimatedSticker,
                mimeType: att.mimeType,
              };
              if (!canExtractFrames(syntheticAtt)) return;

              const { frames, cacheKey, frameTimestamps } = await extractFrames(buffer, syntheticAtt, defaultChatConfig.animationToText.maxFrames);
              att.animationHash = cacheKey;
              updateEventAttachments(db, eventId, event.attachments);

              await animationToTextResolver.resolve({
                cacheKey,
                frames,
                caption,
                isSticker: att.type === 'sticker',
                duration: att.duration,
                frameTimestamps,
              });
            } catch (err) {
              backfillLog.withError(err).warn('Failed to backfill animation');
            }
          })());
        }
      }
      if (tasks.length > 0) {
        backfillLog.withFields({ chatId, tasks: tasks.length }).log('Backfilling animation hashes');
        await Promise.all(tasks);
      }
    }
  }
  // Post-startup: resolve custom emoji descriptions for historical events.
  // Runs after telegram.start() so Bot API (getCustomEmojiStickers) is available.
  if (customEmojiToTextChatIds.size > 0) {
    for (const chatId of customEmojiToTextChatIds) {
      const compaction = loadCompaction(db, chatId);
      const events = loadEvents(db, chatId, compaction?.newCursorMs);
      const emojiIds = new Map<string, string>();
      for (const event of events) {
        if (event.type !== 'message' && event.type !== 'edit') continue;
        walkCustomEmoji(event.content, node => {
          if (!emojiIds.has(node.customEmojiId)) {
            const fallback = contentToPlainText(node.children);
            emojiIds.set(node.customEmojiId, fallback);
          }
        });
      }
      if (emojiIds.size > 0) {
        logger.withFields({ chatId, count: emojiIds.size }).log('Cold-start: resolving custom emoji descriptions');
        await customEmojiToTextResolver.resolve(emojiIds);
        // Re-hydrate + re-replay to get fresh altText into IC → RC
        // (IC nodes from initial replay are Immer-frozen, so we must re-build)
        for (const event of events) hydrateAltTextFromCache(event);
        pipeline.replayChat(chatId, events);
      }
    }
  }
};

main().catch(err => {
  logger.withError(err).error('Fatal error');
  process.exit(1);
});
