import type { WebSearchResult, WebSearcher } from './types';
import { HttpError } from '../../http';

const JINA_SEARCH_URL = 'https://s.jina.ai/';
const JINA_TIMEOUT_MS = 15_000;
const JINA_MAX_RESULTS = 5;

interface JinaSearchResponse {
  data?: { title?: unknown; url?: unknown; content?: unknown; date?: unknown }[];
}

/**
 * Jina `s.jina.ai` search. `X-Retain-Images: none` keeps result snippets
 * compact — image links blow up payloads without helping a textual ranker.
 */
export const createJinaSearcher = (opts: { apiKey: string }): WebSearcher => ({
  search: async (query: string): Promise<WebSearchResult> => {
    const resp = await fetch(JINA_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Retain-Images': 'none',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ q: query, count: JINA_MAX_RESULTS }),
      signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
    });
    if (!resp.ok) throw new HttpError(resp.status, JINA_SEARCH_URL);

    const data = await resp.json() as JinaSearchResponse;
    return {
      results: (data.data ?? []).flatMap(r => {
        if (typeof r.title !== 'string' || typeof r.url !== 'string') return [];
        return [{
          title: r.title,
          url: r.url,
          snippet: typeof r.content === 'string' ? r.content : '',
          ...(typeof r.date === 'string' && r.date ? { pageAge: r.date } : {}),
        }];
      }),
    };
  },
});
