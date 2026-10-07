import sharp from 'sharp';

import type { RenderParams, RenderedContentPiece, RenderedRecord, RenderedMessageRecord, RenderedMessageMetadata, RenderedAttachmentMetadata, BaseRenderedContext, RenderWindow } from './types';
import type { CanonicalAttachment, CanonicalUser, ContentNode } from '../adaptation/types';
import type { ICMessage, ICNode, ICRuntimeEvent, ICSystemEvent, IntermediateContext } from '../projection/types';

export type { RenderParams, RenderedContentPiece, RenderedRecord, BaseRenderedContext, RenderWindow } from './types';

// --- Helpers ---

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const formatSender = (user: CanonicalUser, contactNames?: Map<string, string>): string => {
  const contactName = contactNames?.get(user.id);
  const displayName = contactName ?? (user.displayName !== '' ? user.displayName : (user.username ?? user.id));
  if (user.username && user.username !== displayName) return `${displayName} (@${user.username})`;
  return displayName;
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

const formatTimestamp = (epochSec: number, utcOffsetMin: number): string => {
  // Shift to local time by adding offset, then read UTC accessors
  const d = new Date((epochSec + utcOffsetMin * 60) * 1000);
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;

  const sign = utcOffsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(utcOffsetMin);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;

  return `${date}T${time}${offset}`;
};

// --- ContentNode → XML ---

const renderContentNode = (node: ContentNode): string => {
  switch (node.type) {
  case 'text': return escapeXml(node.text);
  case 'code': return `<code>${escapeXml(node.text)}</code>`;
  case 'pre': return node.language
    ? `<pre lang="${escapeXml(node.language)}">${escapeXml(node.text)}</pre>`
    : `<pre>${escapeXml(node.text)}</pre>`;
  case 'bold': return `<b>${renderContent(node.children)}</b>`;
  case 'italic': return `<i>${renderContent(node.children)}</i>`;
  case 'underline': return `<u>${renderContent(node.children)}</u>`;
  case 'strikethrough': return `<s>${renderContent(node.children)}</s>`;
  case 'spoiler': return `<spoiler>${renderContent(node.children)}</spoiler>`;
  case 'blockquote': return `<blockquote>${renderContent(node.children)}</blockquote>`;
  case 'link': return `<a href="${escapeXml(node.url)}">${renderContent(node.children)}</a>`;
  case 'mention': return node.userId
    ? `<mention uid="${escapeXml(node.userId)}">${renderContent(node.children)}</mention>`
    : `<mention>${renderContent(node.children)}</mention>`;
  case 'custom_emoji':
    if (node.altText) {
      const packAttr = node.stickerSetName ? ` pack="${escapeXml(node.stickerSetName)}"` : '';
      return `<custom-emoji${packAttr}>${escapeXml(node.altText)}</custom-emoji>`;
    }
    if (node.altTextError)
      return `<custom-emoji error="${escapeXml(node.altTextError)}"/>`;
    return renderContent(node.children);
  }
};

const renderContent = (nodes: ContentNode[]): string =>
  nodes.map(renderContentNode).join('');

const REPLY_PREVIEW_MAX_CHARS = 100;

/** Truncate rendered XML without breaking tags. */
const truncateXml = (xml: string, maxLen: number): string => {
  if (xml.length <= maxLen) return xml;
  let cutAt = maxLen;
  const lastClose = xml.lastIndexOf('>', cutAt);
  const lastOpen = xml.lastIndexOf('<', cutAt);
  // If we're inside a tag, truncate before the opening '<'
  if (lastOpen > lastClose) cutAt = lastOpen;
  if (cutAt <= 0) return '';
  // Don't split a surrogate pair — step back if the char before cutAt is a high surrogate.
  if ((xml.charCodeAt(cutAt - 1) & 0xFC00) === 0xD800) cutAt--;
  return `${xml.slice(0, cutAt)}…`;
};

// --- Attachment → XML ---

const renderAttachment = (att: CanonicalAttachment, messageId: string, index: number): string => {
  const attrs: string[] = [`type="${att.type}"`];
  if (att.mimeType) attrs.push(`mime="${escapeXml(att.mimeType)}"`);
  if (att.fileName) attrs.push(`name="${escapeXml(att.fileName)}"`);
  if (att.width != null && att.height != null) attrs.push(`size="${att.width}x${att.height}"`);
  if (att.duration != null) attrs.push(`duration="${att.duration}"`);
  if (att.stickerSetName) attrs.push(`pack="${escapeXml(att.stickerSetName)}"`);
  attrs.push(`file-id="${escapeXml(messageId)}:${index}"`);
  if (att.altText) {
    const tag = att.type === 'sticker' ? 'sticker' : (att.animationHash ? 'animation' : 'image');
    return `<${tag} ${attrs.join(' ')}>${escapeXml(att.altText)}</${tag}>`;
  }
  return `<attachment ${attrs.join(' ')}/>`;
};

// --- Mention detection ---

const hasMention = (nodes: ContentNode[], userId: string): boolean =>
  nodes.some(n =>
    (n.type === 'mention' && n.userId === userId)
    || ('children' in n && hasMention(n.children, userId)));

// --- ICNode → content pieces ---

const renderMessage = (msg: ICMessage, params: RenderParams): Pick<RenderedMessageRecord, 'presentation' | 'activation'> => {
  const isMyself = !!(params.botUserId && msg.sender?.id === params.botUserId);

  const mentionsMe = !!(params.botUserId && hasMention(msg.content, params.botUserId));
  const repliesToMe = !!(params.botUserId && msg.replyToSender?.id === params.botUserId);
  const activation = Object.freeze({ isMyself, mentionsMe, repliesToMe });
  const attrs: string[] = [
    `id="${escapeXml(msg.messageId)}"`,
  ];
  if (msg.sender) attrs.push(`sender="${escapeXml(formatSender(msg.sender, params.contactNames))}"`);
  if (isMyself) attrs.push('myself="true"');
  attrs.push(`t="${formatTimestamp(msg.timestampSec, msg.utcOffsetMin)}"`);

  if (msg.editedAtSec != null)
    attrs.push(`edited="${formatTimestamp(msg.editedAtSec, msg.editUtcOffsetMin ?? msg.utcOffsetMin)}"`);

  if (msg.forwardInfo) {
    const from = (msg.forwardInfo.sender ? formatSender(msg.forwardInfo.sender, params.contactNames) : undefined)
      ?? msg.forwardInfo.senderName
      ?? (msg.forwardInfo.fromUserId ? `user:${msg.forwardInfo.fromUserId}` : undefined)
      ?? (msg.forwardInfo.fromChatId ? `chat:${msg.forwardInfo.fromChatId}` : undefined)
      ?? 'unknown';
    attrs.push(`forwarded_from="${escapeXml(from)}"`);
  }

  const blocked: readonly RenderedContentPiece[] = Object.freeze([{ type: 'text', text: `<message ${attrs.join(' ')} blocked="true"/>` }]);

  if (msg.deleted) {
    attrs.push('deleted="true"');
    return { presentation: Object.freeze({ blocked, body: Object.freeze([{ type: 'text' as const, text: `<message ${attrs.join(' ')}/>` }]) }), activation };
  }

  const parts: string[] = [];

  if (msg.replyToMessageId) {
    const replyAttrs = [`id="${escapeXml(msg.replyToMessageId)}"`];
    if (msg.replyToSender) replyAttrs.push(`sender="${escapeXml(formatSender(msg.replyToSender, params.contactNames))}"`);
    let inner: string;
    if (msg.replyQuoteContent) {
      replyAttrs.push('quoted');
      inner = truncateXml(renderContent(msg.replyQuoteContent), REPLY_PREVIEW_MAX_CHARS);
    } else if (msg.replyToContent) {
      inner = truncateXml(renderContent(msg.replyToContent), REPLY_PREVIEW_MAX_CHARS);
    } else {
      inner = msg.replyToPreview ? escapeXml(msg.replyToPreview) : '';
    }
    parts.push(`<in-reply-to ${replyAttrs.join(' ')}>${inner}</in-reply-to>`);
  }

  const body = renderContent(msg.content);
  if (body) parts.push(body);

  for (let i = 0; i < msg.attachments.length; i++)
    parts.push(renderAttachment(msg.attachments[i]!, msg.messageId, i));

  const pieces: RenderedContentPiece[] = [
    { type: 'text', text: `<message ${attrs.join(' ')}>\n${parts.join('\n')}\n</message>` },
  ];

  // Append thumbnail images as separate content pieces (Driver converts to provider format)
  for (const att of msg.attachments) {
    if (!att.altText && att.thumbnailWebp)
      pieces.push({ type: 'image', image: sharp(Buffer.from(att.thumbnailWebp, 'base64')) });
  }

  return { presentation: Object.freeze({ body: Object.freeze(pieces), blocked }), activation };
};

const renderSystemEvent = (event: ICSystemEvent, contactNames?: Map<string, string>): string => {
  const t = formatTimestamp(event.timestampSec, event.utcOffsetMin);
  const actorAttr = 'actor' in event && event.actor ? ` actor="${escapeXml(formatSender(event.actor, contactNames))}"` : '';

  switch (event.kind) {
  case 'user_renamed':
    return `<event type="name_change" t="${t}" from_name="${escapeXml(formatSender(event.oldUser, contactNames))}" to_name="${escapeXml(formatSender(event.newUser, contactNames))}"/>`;

  case 'members_joined': {
    const members = event.members.map(m => formatSender(m, contactNames)).join(', ');
    return `<event type="members_joined" t="${t}"${actorAttr} members="${escapeXml(members)}"/>`;
  }

  case 'member_left':
    return `<event type="member_left" t="${t}"${actorAttr} member="${escapeXml(formatSender(event.member, contactNames))}"/>`;

  case 'chat_renamed': {
    const fromAttr = event.oldTitle != null ? ` from="${escapeXml(event.oldTitle)}"` : '';
    return `<event type="chat_renamed" t="${t}"${actorAttr}${fromAttr} to="${escapeXml(event.newTitle)}"/>`;
  }

  case 'chat_photo_changed':
    return `<event type="chat_photo_changed" t="${t}"${actorAttr}/>`;

  case 'chat_photo_deleted':
    return `<event type="chat_photo_deleted" t="${t}"${actorAttr}/>`;

  case 'message_pinned': {
    const preview = event.preview ? escapeXml(event.preview) : '';
    if (preview)
      return `<event type="message_pinned" t="${t}"${actorAttr} message_id="${escapeXml(event.messageId)}">${preview}</event>`;
    return `<event type="message_pinned" t="${t}"${actorAttr} message_id="${escapeXml(event.messageId)}"/>`;
  }

  default: {
    event satisfies never;
    return '';
  }
  }
};

// --- RuntimeEvent → XML ---

const renderRuntimeEvent = (event: ICRuntimeEvent): string => {
  const t = formatTimestamp(event.timestampSec, event.utcOffsetMin);
  const attrs = [
    `type="${event.kind}"`,
    `task-id="${event.taskId}"`,
    `task-type="${escapeXml(event.taskType)}"`,
    `t="${t}"`,
  ];

  const parts: string[] = [];
  if (event.intention)
    parts.push(`<intention>${escapeXml(event.intention)}</intention>`);
  parts.push(`<final-summary>\n${escapeXml(event.finalSummary)}\n</final-summary>`);
  if (event.hasFullOutput)
    parts.push('<note>Full output available. Use read_task_output tool to view.</note>');

  return `<runtime-event ${attrs.join(' ')}>\n${parts.join('\n')}\n</runtime-event>`;
};

// --- Public API ---

const snapshotUser = (user: CanonicalUser | undefined): Readonly<CanonicalUser> | undefined =>
  user && Object.freeze({ id: user.id, displayName: user.displayName, username: user.username, isBot: user.isBot });

const snapshotAttachment = (attachment: CanonicalAttachment): RenderedAttachmentMetadata => Object.freeze({
  type: attachment.type,
  mimeType: attachment.mimeType,
  fileName: attachment.fileName,
  width: attachment.width,
  height: attachment.height,
  duration: attachment.duration,
  animationHash: attachment.animationHash,
  stickerSetId: attachment.stickerSetId,
  stickerSetName: attachment.stickerSetName,
  format: attachment.format,
  altText: attachment.altText,
});

const messageMetadata = (chatId: string, message: ICMessage): RenderedMessageMetadata => Object.freeze({
  chatId,
  receivedAtMs: message.receivedAtMs,
  timestampSec: message.timestampSec,
  utcOffsetMin: message.utcOffsetMin,
  messageId: message.messageId,
  sender: snapshotUser(message.sender),
  replyTo: message.replyToMessageId ? Object.freeze({
    messageId: message.replyToMessageId,
    sender: snapshotUser(message.replyToSender),
    preview: message.replyToPreview,
    quoted: !!message.replyQuoteContent,
  }) : undefined,
  forwardInfo: message.forwardInfo ? Object.freeze({
    fromUserId: message.forwardInfo.fromUserId,
    fromChatId: message.forwardInfo.fromChatId,
    sender: snapshotUser(message.forwardInfo.sender),
    senderName: message.forwardInfo.senderName,
    date: message.forwardInfo.date,
  }) : undefined,
  attachments: Object.freeze(message.attachments.map(snapshotAttachment)),
  editedAtSec: message.editedAtSec,
  editUtcOffsetMin: message.editUtcOffsetMin,
  deleted: !!message.deleted,
  isSelfSent: !!message.isSelfSent,
});

const renderNode = (chatId: string, node: ICNode, params: RenderParams): RenderedRecord => {
  if (node.type === 'message')
    return Object.freeze({ kind: 'message', metadata: messageMetadata(chatId, node), ...renderMessage(node, params) });

  const metadata = { chatId, receivedAtMs: node.receivedAtMs, timestampSec: node.timestampSec, utcOffsetMin: node.utcOffsetMin };
  if (node.type === 'runtime_event') {
    return Object.freeze({
      kind: 'runtime',
      metadata: Object.freeze({ ...metadata, taskId: node.taskId, taskType: node.taskType }),
      presentation: Object.freeze({ body: Object.freeze([{ type: 'text' as const, text: renderRuntimeEvent(node) }]) }),
    });
  }
  return Object.freeze({
    kind: 'system', metadata: Object.freeze(metadata),
    presentation: Object.freeze({ body: Object.freeze([{ type: 'text' as const, text: renderSystemEvent(node, params.contactNames) }]) }),
  });
};

export const isInRenderWindow = (receivedAtMs: number, window: RenderWindow): boolean =>
  (window.fromReceivedAtMs == null || receivedAtMs >= window.fromReceivedAtMs)
  && (window.untilReceivedAtMs == null || receivedAtMs < window.untilReceivedAtMs);

// Selection precedes formatting, metadata copying, revision comparison and Sharp.
// IC is supplied by the consumer and may contain dependencies outside the range.
const selectNodes = (ic: IntermediateContext, window: RenderWindow): ICNode[] =>
  ic.nodes.filter(node => isInRenderWindow(node.receivedAtMs, window));

export const render = (ic: IntermediateContext, params: RenderParams = {}, window: RenderWindow = {}): BaseRenderedContext =>
  Object.freeze(selectNodes(ic, window).map(node => renderNode(ic.sessionId, node, params)));

export const contentToXml = (pieces: readonly RenderedContentPiece[]): string =>
  pieces.map(piece => piece.type === 'text' ? piece.text : '[thumbnail]').join('\n');

export const renderedRecordsToXml = (records: BaseRenderedContext): string =>
  records.map(record => contentToXml(record.presentation.body)).join('\n');

/** One cache per consumer/chat. Immutable IC nodes are revisions; formatting is
 * snapshotted by value so mutating a contact map cannot reuse stale XML. */
export const createRenderer = () => {
  type CachedNode = { revision: string; record: RenderedRecord };
  let cache = new Map<ICNode, CachedNode>();
  let formatKey: string | undefined;
  return {
    render(ic: IntermediateContext, params: RenderParams, window: RenderWindow = {}): BaseRenderedContext {
      const nextFormatKey = JSON.stringify([ic.sessionId, params.botUserId, [...(params.contactNames ?? [])]]);
      if (nextFormatKey !== formatKey) cache.clear();
      formatKey = nextFormatKey;
      const previousRevisions = new Map([...cache.values()].map(entry => [entry.revision, entry.record]));
      const nextCache = new Map<ICNode, CachedNode>();
      const nodes = selectNodes(ic, window).map(node => {
        let entry = cache.get(node);
        if (!entry) {
          // Replay creates new immutable nodes even when their data is unchanged.
          // Compare every source field, including media, quotes and echo state.
          const revision = JSON.stringify(node);
          entry = { revision, record: previousRevisions.get(revision) ?? renderNode(ic.sessionId, node, params) };
        }
        nextCache.set(node, entry);
        return entry.record;
      });
      cache = nextCache;
      return Object.freeze(nodes);
    },
    retainWindow(window: RenderWindow): void {
      for (const node of cache.keys())
        if (!isInRenderWindow(node.receivedAtMs, window)) cache.delete(node);
    },
  };
};
