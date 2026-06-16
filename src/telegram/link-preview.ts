import type * as Td from 'tdlib-types';

const TELEGRAM_HOSTS = new Set([
  't.me',
  'telegram.me',
  'telegram.org',
  'telegram.dog',
]);

const isTelegramHost = (hostname: string): boolean => {
  const h = hostname.toLowerCase();
  if (TELEGRAM_HOSTS.has(h)) return true;
  // subdomains of telegram.org (web.telegram.org, etc.)
  return h.endsWith('.telegram.org');
};

const hasTwoSegmentsOrQuery = (url: URL): boolean => {
  if (url.search.length > 1) return true;
  const segments = url.pathname.split('/').filter(s => s.length > 0);
  return segments.length >= 2;
};

const qualifiesForPreview = (rawUrl: string): boolean => {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (isTelegramHost(parsed.hostname)) return false;
  return hasTwoSegmentsOrQuery(parsed);
};

const entityUrlIfTextEqualsUrl = (text: string, entity: Td.textEntity$Input): string | undefined => {
  if (entity.offset == null || entity.length == null || !entity.type) return undefined;
  const displayed = text.slice(entity.offset, entity.offset + entity.length);
  if (entity.type._ === 'textEntityTypeUrl') return displayed;
  if (entity.type._ === 'textEntityTypeTextUrl' && entity.type.url === displayed) return entity.type.url;
  return undefined;
};

// Whether the message should preview a link. We enable preview only when at
// least one URL passes all three rules: its visible text equals the URL, the
// host is not a Telegram domain, and the URL carries two or more path segments
// or a query string. When multiple qualify, we pin the first one — otherwise
// TDLib would default to whichever URL appears first in the text, which might
// not be the qualifying one.
export const decideLinkPreviewOptions = (
  text: string,
  entities: ReadonlyArray<Td.textEntity$Input>,
): Td.linkPreviewOptions$Input => {
  for (const e of entities) {
    const url = entityUrlIfTextEqualsUrl(text, e);
    if (url !== undefined && qualifiesForPreview(url))
      return { _: 'linkPreviewOptions', is_disabled: false, url };
  }
  return { _: 'linkPreviewOptions', is_disabled: true };
};
