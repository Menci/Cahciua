import type { RenderParams, RenderedContentPiece, RenderedContext, RenderedContextSegment } from './types';
import type { CanonicalAttachment, CanonicalUser, ContentNode } from '../adaptation/types';
import type { ICMessage, ICSystemEvent, IntermediateContext } from '../projection/types';

export type { RenderParams, RenderedContentPiece, RenderedContext, RenderedContextSegment } from './types';

// --- Helpers ---

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const formatSender = (user: CanonicalUser): string => {
  const displayName = user.displayName !== '' ? user.displayName : (user.username ?? user.id);
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
  case 'custom_emoji': return renderContent(node.children);
  }
};

const renderContent = (nodes: ContentNode[]): string =>
  nodes.map(renderContentNode).join('');

// --- Attachment → XML ---

const renderAttachment = (att: CanonicalAttachment): string => {
  const attrs: string[] = [`type="${att.type}"`];
  if (att.mimeType) attrs.push(`mime="${escapeXml(att.mimeType)}"`);
  if (att.fileName) attrs.push(`name="${escapeXml(att.fileName)}"`);
  if (att.width != null && att.height != null) attrs.push(`size="${att.width}x${att.height}"`);
  if (att.duration != null) attrs.push(`duration="${att.duration}"`);
  return `<attachment ${attrs.join(' ')}/>`;
};

// --- Mention detection ---

const hasMention = (nodes: ContentNode[], userId: string): boolean =>
  nodes.some(n =>
    (n.type === 'mention' && n.userId === userId)
    || ('children' in n && hasMention(n.children, userId)));

// --- ICNode → content pieces ---

const renderMessage = (msg: ICMessage, params: RenderParams): { content: RenderedContentPiece[]; isMyself: boolean; isSelfSent: boolean; mentionsMe: boolean; repliesToMe: boolean } => {
  const isMyself = !!(params.botUserId && msg.sender?.id === params.botUserId);
  const isSelfSent = !!msg.isSelfSent;
  const mentionsMe = !!(params.botUserId && hasMention(msg.content, params.botUserId));
  const repliesToMe = !!(params.botUserId && msg.replyToSender?.id === params.botUserId);
  const attrs: string[] = [
    `id="${escapeXml(msg.messageId)}"`,
  ];
  if (msg.sender) attrs.push(`sender="${escapeXml(formatSender(msg.sender))}"`);
  if (isMyself) attrs.push('myself="true"');
  attrs.push(`t="${formatTimestamp(msg.timestampSec, msg.utcOffsetMin)}"`);

  if (msg.editedAtSec != null)
    attrs.push(`edited="${formatTimestamp(msg.editedAtSec, msg.editUtcOffsetMin ?? msg.utcOffsetMin)}"`);

  if (msg.forwardInfo) {
    const from = msg.forwardInfo.senderName
      ?? (msg.forwardInfo.fromUserId ? `user:${msg.forwardInfo.fromUserId}` : undefined)
      ?? (msg.forwardInfo.fromChatId ? `chat:${msg.forwardInfo.fromChatId}` : undefined)
      ?? 'unknown';
    attrs.push(`forwarded_from="${escapeXml(from)}"`);
  }

  if (msg.deleted) {
    attrs.push('deleted="true"');
    return { content: [{ type: 'text', text: `<message ${attrs.join(' ')}/>` }], isMyself, isSelfSent, mentionsMe, repliesToMe };
  }

  const parts: string[] = [];

  if (msg.replyToMessageId) {
    const replyAttrs = [`id="${escapeXml(msg.replyToMessageId)}"`];
    if (msg.replyToSender) replyAttrs.push(`sender="${escapeXml(formatSender(msg.replyToSender))}"`);
    const preview = msg.replyToPreview ? escapeXml(msg.replyToPreview) : '';
    parts.push(`<in-reply-to ${replyAttrs.join(' ')}>${preview}</in-reply-to>`);
  }

  const body = renderContent(msg.content);
  if (body) parts.push(body);

  for (const att of msg.attachments)
    parts.push(renderAttachment(att));

  const pieces: RenderedContentPiece[] = [
    { type: 'text', text: `<message ${attrs.join(' ')}>\n${parts.join('\n')}\n</message>` },
  ];

  // Append thumbnail images as separate content pieces (Driver converts to provider format)
  for (const att of msg.attachments) {
    if (att.thumbnailWebp)
      pieces.push({ type: 'image', url: `data:image/webp;base64,${att.thumbnailWebp}` });
  }

  return { content: pieces, isMyself, isSelfSent, mentionsMe, repliesToMe };
};

const renderSystemEvent = (event: ICSystemEvent): string => {
  const t = formatTimestamp(event.timestampSec, event.utcOffsetMin);
  const actorAttr = 'actor' in event && event.actor ? ` actor="${escapeXml(formatSender(event.actor))}"` : '';

  switch (event.kind) {
  case 'user_renamed':
    return `<event type="name_change" t="${t}" from_name="${escapeXml(formatSender(event.oldUser))}" to_name="${escapeXml(formatSender(event.newUser))}"/>`;

  case 'members_joined': {
    const members = event.members.map(m => formatSender(m)).join(', ');
    return `<event type="members_joined" t="${t}"${actorAttr} members="${escapeXml(members)}"/>`;
  }

  case 'member_left':
    return `<event type="member_left" t="${t}"${actorAttr} member="${escapeXml(formatSender(event.member))}"/>`;

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

// --- Public API ---

export const render = (ic: IntermediateContext, params: RenderParams = {}): RenderedContext => {
  const segments: RenderedContextSegment[] = [];

  for (const node of ic.nodes) {
    if (params.compactCursorMs != null && node.receivedAtMs < params.compactCursorMs) continue;

    if (node.type === 'message') {
      const { content, isMyself, isSelfSent, mentionsMe, repliesToMe } = renderMessage(node, params);
      segments.push({ receivedAtMs: node.receivedAtMs, content, ...(isMyself && { isMyself }), ...(isSelfSent && { isSelfSent }), ...(mentionsMe && { mentionsMe }), ...(repliesToMe && { repliesToMe }) });
    } else {
      const content = [{ type: 'text' as const, text: renderSystemEvent(node) }];
      segments.push({ receivedAtMs: node.receivedAtMs, content });
    }
  }

  return segments;
};

export const rcToXml = (rc: RenderedContext): string =>
  rc.map(seg =>
    seg.content
      .map(p => p.type === 'text' ? p.text : '[thumbnail]')
      .join('\n')).join('\n');
