import { Api } from 'teleproto';

const TELEGRAM_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.org', 'telegram.dog']);

const telegramPathPrefix = (chatId: string): string =>
  chatId.startsWith('-100') ? `https://t.me/c/${chatId.slice(4)}/` : '';

/**
 * Whether an outgoing URL should get a Telegram link preview. Internal message
 * deep links are the only links this bot deliberately previews; arbitrary
 * LLM-authored URLs stay inert so they cannot inject remote content.
 */
export const qualifiesForPreview = (rawUrl: string, chatId?: string): boolean => {
  if (chatId && telegramPathPrefix(chatId) !== '' && rawUrl.startsWith(telegramPathPrefix(chatId)))
    return true;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  return url.protocol === 'http:' || url.protocol === 'https:'
    ? !TELEGRAM_HOSTS.has(url.hostname.toLowerCase()) && !url.hostname.toLowerCase().endsWith('.telegram.org')
      && (url.search.length > 1 || url.pathname.split('/').filter(Boolean).length >= 2)
    : false;
};

export const decideLinkPreviewOptions = (
  text: string,
  entities: ReadonlyArray<Api.TypeMessageEntity>,
  chatId?: string,
): { linkPreview: boolean } => {
  const hasOwnDeepLink = chatId != null
    && text.includes(telegramPathPrefix(chatId));
  const hasQualifyingUrl = entities.some(entity =>
    entity instanceof Api.MessageEntityTextUrl
      ? qualifiesForPreview(entity.url, chatId)
      : entity instanceof Api.MessageEntityUrl
        ? qualifiesForPreview(text.slice(entity.offset, entity.offset + entity.length), chatId)
        : false);
  return { linkPreview: hasOwnDeepLink || hasQualifyingUrl };
};
