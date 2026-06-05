import type { WebSearchResult, WebSearchResultItem, WebSearcher } from './types';
import { HttpError } from '../../http';

// Docs: https://dashboard.microsoft.ai/documentation/api-reference/web/
const MS_GROUNDING_URL = 'https://api.microsoft.ai/v3/search/web';
const MS_GROUNDING_TIMEOUT_MS = 15_000;
const MS_GROUNDING_MAX_RESULTS = 5;

interface MsWebResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  crawledAt?: unknown;
  lastUpdatedAt?: unknown;
}

interface MsWebResponse {
  webResults?: MsWebResult[];
}

const normalizeResult = (raw: MsWebResult): WebSearchResultItem | null => {
  if (typeof raw.title !== 'string' || typeof raw.url !== 'string') return null;
  const pageAge = typeof raw.lastUpdatedAt === 'string' && raw.lastUpdatedAt.trim()
    ? raw.lastUpdatedAt
    : typeof raw.crawledAt === 'string' && raw.crawledAt.trim()
      ? raw.crawledAt
      : undefined;
  return {
    title: raw.title,
    url: raw.url,
    snippet: typeof raw.content === 'string' ? raw.content : '',
    ...(pageAge ? { pageAge } : {}),
  };
};

/**
 * Microsoft Grounding `/v3/search/web`. We request `contentFormat: passage` so
 * the backend extracts query-relevant paragraphs into `content` (the web API
 * doesn't return a separate `snippet` field — see api-reference-web docs).
 */
export const createMicrosoftGroundingSearcher = (opts: { apiKey: string }): WebSearcher => ({
  search: async (query: string): Promise<WebSearchResult> => {
    const resp = await fetch(MS_GROUNDING_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-apikey': opts.apiKey,
      },
      body: JSON.stringify({
        query,
        maxResults: MS_GROUNDING_MAX_RESULTS,
        contentFormat: 'passage',
      }),
      signal: AbortSignal.timeout(MS_GROUNDING_TIMEOUT_MS),
    });
    if (!resp.ok) throw new HttpError(resp.status, MS_GROUNDING_URL);

    const data = await resp.json() as MsWebResponse;
    return {
      results: (data.webResults ?? [])
        .map(normalizeResult)
        .filter((r): r is WebSearchResultItem => r !== null),
    };
  },
});
