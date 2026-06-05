import type { WebSearchResult, WebSearcher } from './types';
import { HttpError } from '../../http';

const EXA_URL = 'https://api.exa.ai/search';
const EXA_TIMEOUT_MS = 15_000;
const EXA_MAX_RESULTS = 5;

interface ExaResponse {
  results?: { title?: unknown; url?: unknown; text?: unknown; publishedDate?: unknown }[];
}

/**
 * Exa `/search` with `type: auto` and `contents.text: true`. `highlights`
 * adds query-relevant snippets but Exa already returns full `text`; we drop
 * highlights to keep the response shape uniform with other providers.
 */
export const createExaSearcher = (opts: { apiKey: string }): WebSearcher => ({
  search: async (query: string): Promise<WebSearchResult> => {
    const resp = await fetch(EXA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        query,
        numResults: EXA_MAX_RESULTS,
        type: 'auto',
        contents: { text: true },
      }),
      signal: AbortSignal.timeout(EXA_TIMEOUT_MS),
    });
    if (!resp.ok) throw new HttpError(resp.status, EXA_URL);

    const data = await resp.json() as ExaResponse;
    return {
      results: (data.results ?? []).flatMap(r => {
        if (typeof r.title !== 'string' || typeof r.url !== 'string') return [];
        return [{
          title: r.title,
          url: r.url,
          snippet: typeof r.text === 'string' ? r.text : '',
          ...(typeof r.publishedDate === 'string' && r.publishedDate ? { pageAge: r.publishedDate } : {}),
        }];
      }),
    };
  },
});
