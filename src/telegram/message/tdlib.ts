import type * as Td from 'tdlib-types';

import type { EntityCache } from '../entity-cache';
import type { Attachment, ForwardInfo, MessageEntity, TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, TelegramUser } from './types';

// --- chat / sender ---

export const chatIdToString = (id: number | string): string => String(id);

const senderToUser = (cache: EntityCache, sender: Td.MessageSender): TelegramUser | undefined => {
  if (sender._ === 'messageSenderUser')
    return cache.resolveUser(sender.user_id) ?? { id: String(sender.user_id), firstName: '', isBot: false, isPremium: false };
  return cache.resolveChatAsUser(sender.chat_id) ?? { id: String(sender.chat_id), firstName: '', isBot: false, isPremium: false };
};

// --- entities ---

const ENTITY_TYPE_MAP: Record<string, string> = {
  textEntityTypeMention: 'mention',
  textEntityTypeHashtag: 'hashtag',
  textEntityTypeCashtag: 'cashtag',
  textEntityTypeBotCommand: 'bot_command',
  textEntityTypeUrl: 'url',
  textEntityTypeEmailAddress: 'email',
  textEntityTypePhoneNumber: 'phone_number',
  textEntityTypeBankCardNumber: 'bank_card',
  textEntityTypeBold: 'bold',
  textEntityTypeItalic: 'italic',
  textEntityTypeUnderline: 'underline',
  textEntityTypeStrikethrough: 'strikethrough',
  textEntityTypeSpoiler: 'spoiler',
  textEntityTypeCode: 'code',
  textEntityTypePre: 'pre',
  textEntityTypePreCode: 'pre',
  textEntityTypeBlockquote: 'blockquote',
  textEntityTypeTextUrl: 'text_link',
  textEntityTypeMentionName: 'text_mention',
  textEntityTypeCustomEmoji: 'custom_emoji',
};

const convertEntities = (entities?: Array<Td.textEntity>): MessageEntity[] | undefined => {
  if (!entities || entities.length === 0) return undefined;
  return entities.map(e => {
    const type = ENTITY_TYPE_MAP[e.type._] ?? e.type._;
    const result: MessageEntity = { type, offset: e.offset, length: e.length };
    if (e.type._ === 'textEntityTypeTextUrl') result.url = e.type.url;
    if (e.type._ === 'textEntityTypePreCode') result.language = e.type.language;
    if (e.type._ === 'textEntityTypeMentionName') result.userId = String(e.type.user_id);
    if (e.type._ === 'textEntityTypeCustomEmoji') result.customEmojiId = String(e.type.custom_emoji_id);
    return result;
  });
};

// --- attachments ---

const photoToAttachment = (p: Td.photo, hasSpoiler?: boolean): Attachment | undefined => {
  const largest = [...p.sizes].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!largest) return undefined;
  return {
    type: 'photo',
    width: largest.width,
    height: largest.height,
    fileSize: largest.photo.size,
    ...(hasSpoiler ? { hasSpoiler: true } : {}),
  };
};

const stickerToAttachment = (s: Td.sticker): Attachment => {
  const isCustomEmoji = s.full_type._ === 'stickerFullTypeCustomEmoji';
  const setIdStr = String(s.set_id);
  return {
    type: 'sticker',
    width: s.width,
    height: s.height,
    emoji: s.emoji,
    stickerSetId: setIdStr !== '0' ? setIdStr : undefined,
    isAnimatedSticker: s.format._ === 'stickerFormatTgs',
    isVideoSticker: s.format._ === 'stickerFormatWebm',
    customEmojiId: isCustomEmoji ? String(s.id) : undefined,
    fileSize: s.sticker.size,
  };
};

const animationToAttachment = (a: Td.animation, hasSpoiler?: boolean): Attachment => ({
  type: 'animation',
  width: a.width,
  height: a.height,
  duration: a.duration,
  fileName: a.file_name || undefined,
  mimeType: a.mime_type || undefined,
  fileSize: a.animation.size,
  ...(hasSpoiler ? { hasSpoiler: true } : {}),
});

const videoToAttachment = (v: Td.video, hasSpoiler?: boolean): Attachment => ({
  type: 'video',
  width: v.width,
  height: v.height,
  duration: v.duration,
  fileName: v.file_name || undefined,
  mimeType: v.mime_type || undefined,
  fileSize: v.video.size,
  ...(hasSpoiler ? { hasSpoiler: true } : {}),
});

const videoNoteToAttachment = (vn: Td.videoNote): Attachment => ({
  type: 'video_note',
  width: vn.length,
  height: vn.length,
  duration: vn.duration,
  fileSize: vn.video.size,
});

const voiceToAttachment = (v: Td.voiceNote): Attachment => ({
  type: 'voice',
  duration: v.duration,
  mimeType: v.mime_type || undefined,
  fileSize: v.voice.size,
});

const audioToAttachment = (a: Td.audio): Attachment => ({
  type: 'audio',
  duration: a.duration,
  fileName: a.file_name || undefined,
  mimeType: a.mime_type || undefined,
  fileSize: a.audio.size,
});

const documentToAttachment = (d: Td.document): Attachment => ({
  type: 'document',
  fileName: d.file_name || undefined,
  mimeType: d.mime_type || undefined,
  fileSize: d.document.size,
});

interface ContentResult {
  text: string;
  entities?: MessageEntity[];
  attachments?: Attachment[];
}

const convertContent = (content: Td.MessageContent): ContentResult | null => {
  switch (content._) {
  case 'messageText':
    return { text: content.text.text, entities: convertEntities(content.text.entities) };
  case 'messagePhoto': {
    const att = photoToAttachment(content.photo, content.has_spoiler);
    return {
      text: content.caption.text,
      entities: convertEntities(content.caption.entities),
      ...(att ? { attachments: [att] } : {}),
    };
  }
  case 'messageSticker':
    return { text: '', attachments: [stickerToAttachment(content.sticker)] };
  case 'messageAnimation':
    return {
      text: content.caption.text,
      entities: convertEntities(content.caption.entities),
      attachments: [animationToAttachment(content.animation, content.has_spoiler)],
    };
  case 'messageVideo':
    return {
      text: content.caption.text,
      entities: convertEntities(content.caption.entities),
      attachments: [videoToAttachment(content.video, content.has_spoiler)],
    };
  case 'messageVideoNote':
    return { text: '', attachments: [videoNoteToAttachment(content.video_note)] };
  case 'messageVoiceNote':
    return {
      text: content.caption.text,
      entities: convertEntities(content.caption.entities),
      attachments: [voiceToAttachment(content.voice_note)],
    };
  case 'messageAudio':
    return {
      text: content.caption.text,
      entities: convertEntities(content.caption.entities),
      attachments: [audioToAttachment(content.audio)],
    };
  case 'messageDocument':
    return {
      text: content.caption.text,
      entities: convertEntities(content.caption.entities),
      attachments: [documentToAttachment(content.document)],
    };
  case 'messageAnimatedEmoji':
    // Telegram's animated emoji (single emoji rendered as sticker). Render as plain emoji.
    return { text: content.emoji };
  case 'messageRichMessage':
    return { text: flattenRichMessage(content.message) };
  case 'messageUnsupported':
    return { text: '' };
  default:
    return null;
  }
};

// --- rich message flattening: render the structured tree as markdown-ish text
// so the IC sees something meaningful. Math expressions get the standard
// `$inline$` / `$$block$$` markers so the LLM can re-emit them faithfully if
// the message is forwarded or quoted. Entity preservation (bold, italic, links)
// is intentionally deferred — the rich tree's nesting is richer than what our
// TelegramMessage.entities array can express, and flattening to plain text
// keeps the IC representation honest.

const flattenRichText = (rt: Td.RichText): string => {
  switch (rt._) {
  case 'richTextPlain':
    return rt.text;
  case 'richTextFixed':
    return flattenRichText(rt.text);
  case 'richTextBold':
  case 'richTextItalic':
  case 'richTextUnderline':
  case 'richTextStrikethrough':
  case 'richTextSpoiler':
  case 'richTextSubscript':
  case 'richTextSuperscript':
  case 'richTextMarked':
    return flattenRichText(rt.text);
  case 'richTextUrl':
  case 'richTextEmailAddress':
  case 'richTextPhoneNumber':
  case 'richTextBankCardNumber':
  case 'richTextMention':
  case 'richTextHashtag':
  case 'richTextCashtag':
  case 'richTextBotCommand':
    return flattenRichText(rt.text);
  case 'richTextMentionName':
    return flattenRichText(rt.text);
  case 'richTextDateTime':
    return flattenRichText(rt.text);
  case 'richTextCustomEmoji':
    return rt.alternative_text;
  case 'richTextIcon':
    return '';
  case 'richTextMathematicalExpression':
    return `$${rt.expression}$`;
  case 'richTextReference':
    return flattenRichText(rt.text);
  case 'richTextReferenceLink':
    return flattenRichText(rt.text);
  case 'richTextAnchor':
    return '';
  case 'richTextAnchorLink':
    return flattenRichText(rt.text);
  case 'richTexts':
    return rt.texts.map(flattenRichText).join('');
  }
};

const flattenPageBlock = (block: Td.PageBlock): string => {
  switch (block._) {
  case 'pageBlockTitle':
    return `# ${flattenRichText(block.title)}\n\n`;
  case 'pageBlockSubtitle':
    return `## ${flattenRichText(block.subtitle)}\n\n`;
  case 'pageBlockHeader':
    return `# ${flattenRichText(block.header)}\n\n`;
  case 'pageBlockSubheader':
    return `## ${flattenRichText(block.subheader)}\n\n`;
  case 'pageBlockSectionHeading':
    return `${'#'.repeat(Math.min(Math.max(block.size, 1), 6))} ${flattenRichText(block.text)}\n\n`;
  case 'pageBlockKicker':
    return `${flattenRichText(block.kicker)}\n\n`;
  case 'pageBlockParagraph':
    return `${flattenRichText(block.text)}\n\n`;
  case 'pageBlockPreformatted':
    return `\`\`\`\n${flattenRichText(block.text)}\n\`\`\`\n\n`;
  case 'pageBlockFooter':
    return `${flattenRichText(block.footer)}\n\n`;
  case 'pageBlockDivider':
    return '---\n\n';
  case 'pageBlockMathematicalExpression':
    return `$$${block.expression}$$\n\n`;
  case 'pageBlockAnchor':
    return '';
  case 'pageBlockList':
    return block.items.map((item, i) => {
      const marker = item.label || `${i + 1}.`;
      const body = item.blocks.map(flattenPageBlock).join('').trim();
      return `${marker} ${body}\n`;
    }).join('') + '\n';
  case 'pageBlockBlockQuote': {
    const text = block.blocks.map(flattenPageBlock).join('').trim();
    return text.split('\n').map((line: string) => `> ${line}`).join('\n') + '\n\n';
  }
  case 'pageBlockPullQuote': {
    const text = flattenRichText(block.text);
    return text.split('\n').map((line: string) => `> ${line}`).join('\n') + '\n\n';
  }
  case 'pageBlockAnimation':
  case 'pageBlockAudio':
  case 'pageBlockPhoto':
  case 'pageBlockVideo':
  case 'pageBlockVoiceNote':
    return `[${block._.slice('pageBlock'.length).toLowerCase()}]\n\n`;
  case 'pageBlockTable': {
    const rows = block.cells.map(row => row.map(cell => {
      const inner = cell.text ? flattenRichText(cell.text) : '';
      return inner.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    }).join(' | '));
    if (rows.length === 0) return '';
    const header = rows[0]!;
    const separator = header.split('|').map(() => '---').join('|');
    return [header, separator, ...rows.slice(1)].map(r => `| ${r} |`).join('\n') + '\n\n';
  }
  case 'pageBlockDetails':
    return block.blocks.map(flattenPageBlock).join('');
  case 'pageBlockThinking':
    return ''; // streaming "thinking" indicator — skip
  default:
    return '';
  }
};

const flattenRichMessage = (msg: Td.richMessage): string =>
  msg.blocks.map(flattenPageBlock).join('').replace(/\n{3,}/g, '\n\n').trim();

// --- forward info ---

const convertForwardInfo = (cache: EntityCache, fwd: Td.messageForwardInfo | undefined): ForwardInfo | undefined => {
  if (!fwd) return undefined;
  const info: ForwardInfo = { date: fwd.date };
  const origin = fwd.origin;
  switch (origin._) {
  case 'messageOriginUser':
    info.fromUserId = String(origin.sender_user_id);
    info.sender = cache.resolveUser(origin.sender_user_id);
    break;
  case 'messageOriginChat':
    info.fromChatId = String(origin.sender_chat_id);
    info.sender = cache.resolveChatAsUser(origin.sender_chat_id);
    break;
  case 'messageOriginChannel':
    info.fromChatId = String(origin.chat_id);
    info.sender = cache.resolveChatAsUser(origin.chat_id);
    if (origin.message_id) info.fromMessageId = origin.message_id;
    break;
  case 'messageOriginHiddenUser':
    info.senderName = origin.sender_name;
    break;
  }
  // forward_info.source captures the most recent re-forward path; only use it
  // to fill in fromChatId/fromMessageId when origin didn't already supply them.
  if (fwd.source && info.fromChatId === undefined && fwd.source.chat_id) {
    info.fromChatId = String(fwd.source.chat_id);
    if (fwd.source.message_id) info.fromMessageId = fwd.source.message_id;
  }
  return info;
};

// --- service messages ---

const convertServiceContent = (
  cache: EntityCache,
  base: Omit<TelegramMessage, 'source'>,
  content: Td.MessageContent,
): TelegramMessage | null => {
  switch (content._) {
  case 'messageChatAddMembers': {
    const members = content.member_user_ids.flatMap(uid => {
      const user = cache.resolveUser(uid);
      return user ? [user] : [{ id: String(uid), firstName: '', isBot: false, isPremium: false }];
    });
    if (members.length === 0) return null;
    return { ...base, source: 'userbot', newChatMembers: members };
  }
  case 'messageChatJoinByLink':
  case 'messageChatJoinByRequest': {
    if (!base.sender) return null;
    return { ...base, source: 'userbot', newChatMembers: [base.sender] };
  }
  case 'messageChatDeleteMember': {
    const left = cache.resolveUser(content.user_id) ?? { id: String(content.user_id), firstName: '', isBot: false, isPremium: false };
    return { ...base, source: 'userbot', leftChatMember: left };
  }
  case 'messageChatChangeTitle':
    return { ...base, source: 'userbot', newChatTitle: content.title };
  case 'messageChatChangePhoto':
    return { ...base, source: 'userbot', newChatPhoto: true };
  case 'messageChatDeletePhoto':
    return { ...base, source: 'userbot', deleteChatPhoto: true };
  case 'messagePinMessage':
    return { ...base, source: 'userbot', pinnedMessage: { messageId: content.message_id } };
  default:
    return null;
  }
};

const SERVICE_CONTENT_TYPES = new Set([
  'messageChatAddMembers',
  'messageChatJoinByLink',
  'messageChatJoinByRequest',
  'messageChatDeleteMember',
  'messageChatChangeTitle',
  'messageChatChangePhoto',
  'messageChatDeletePhoto',
  'messagePinMessage',
]);

// --- public API ---

export const fromTdMessage = (cache: EntityCache, msg: Td.message): TelegramMessage | null => {
  const replyTo = msg.reply_to?._ === 'messageReplyToMessage' ? msg.reply_to : undefined;
  const base: Omit<TelegramMessage, 'source'> = {
    messageId: msg.id,
    chatId: chatIdToString(msg.chat_id),
    sender: senderToUser(cache, msg.sender_id),
    date: msg.date,
    editDate: msg.edit_date || undefined,
    text: '',
    replyToMessageId: replyTo?.message_id || undefined,
    forwardInfo: convertForwardInfo(cache, msg.forward_info),
    mediaGroupId: msg.media_album_id && msg.media_album_id !== '0' ? msg.media_album_id : undefined,
    viaBotId: msg.via_bot_user_id ? String(msg.via_bot_user_id) : undefined,
  };

  if (SERVICE_CONTENT_TYPES.has(msg.content._)) {
    return convertServiceContent(cache, base, msg.content);
  }

  const result = convertContent(msg.content);
  if (!result) return null;
  return {
    ...base,
    text: result.text,
    entities: result.entities,
    attachments: result.attachments,
    source: 'userbot',
  };
};

export const fromTdMessageEdited = (cache: EntityCache, msg: Td.message): TelegramMessageEdit | null => {
  const result = convertContent(msg.content);
  if (!result) return null;
  return {
    messageId: msg.id,
    chatId: chatIdToString(msg.chat_id),
    sender: senderToUser(cache, msg.sender_id),
    date: msg.date,
    editDate: msg.edit_date || msg.date,
    text: result.text,
    entities: result.entities,
    attachments: result.attachments,
  };
};

export const fromTdDeletedMessages = (chatId: string | number, messageIds: ReadonlyArray<number>): TelegramMessageDelete => ({
  messageIds: [...messageIds],
  chatId: String(chatId),
});

// --- entity-type-aware HTML escaping (utility for markdown→HTML pipeline; we still
// rely on tdlib's own HTML parser via parseTextEntities) ---
