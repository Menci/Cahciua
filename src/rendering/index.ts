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

const formatSender = (user: CanonicalUser): string =>
  user.username ? `${user.displayName} (@${user.username})` : user.displayName;

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

// --- ICNode → content pieces ---

const renderMessage = (msg: ICMessage): RenderedContentPiece[] => {
  const attrs: string[] = [
    `id="${escapeXml(msg.messageId)}"`,
  ];
  if (msg.sender) attrs.push(`sender="${escapeXml(formatSender(msg.sender))}"`);
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
    return [{ type: 'text', text: `<message ${attrs.join(' ')}/>` }];
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

  return pieces;
};

const renderSystemEvent = (event: ICSystemEvent): string => {
  switch (event.kind) {
  case 'user_renamed':
    return `<event type="name_change" t="${formatTimestamp(event.timestampSec, event.utcOffsetMin)}" from_name="${escapeXml(formatSender(event.oldUser))}" to_name="${escapeXml(formatSender(event.newUser))}"/>`;
  }
};

// --- Public API ---

export const render = (ic: IntermediateContext, params: RenderParams = {}): RenderedContext => {
  const segments: RenderedContextSegment[] = [];

  for (const node of ic.nodes) {
    if (params.compactCursorMs != null && node.receivedAtMs < params.compactCursorMs) continue;

    const content = node.type === 'message'
      ? renderMessage(node)
      : [{ type: 'text' as const, text: renderSystemEvent(node) }];

    segments.push({ receivedAtMs: node.receivedAtMs, content });
  }

  return segments;
};

export const rcToXml = (rc: RenderedContext): string =>
  rc.map(seg =>
    seg.content
      .map(p => p.type === 'text' ? p.text : '[thumbnail]')
      .join('\n')).join('\n');
