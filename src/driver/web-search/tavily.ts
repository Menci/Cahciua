import type { WebSearchResult, WebSearcher } from './types';
import { HttpError } from '../../http';

const TAVILY_URL = 'https://api.tavily.com/search';
const TAVILY_TIMEOUT_MS = 15_000;
const TAVILY_MAX_RESULTS = 5;

interface TavilyResponse {
  results?: { title: string; url: string; content: string; published_date?: string }[];
}

/**
 * Tavily's `/search` returns search-like snippets in `content` and an optional
 * synthesized `answer`. We discard `answer` to keep the cross-provider shape
 * uniform — the LLM is the synthesizer, not the search backend.
 */
export const createTavilySearcher = (opts: { apiKey: string }): WebSearcher => ({
  search: async (query: string): Promise<WebSearchResult> => {
    const resp = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: opts.apiKey,
        query,
        search_depth: 'basic',
        include_answer: false,
        max_results: TAVILY_MAX_RESULTS,
      }),
      signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
    });
    if (!resp.ok) throw new HttpError(resp.status, TAVILY_URL);

    const data = await resp.json() as TavilyResponse;
    return {
      results: (data.results ?? []).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        ...(r.published_date ? { pageAge: r.published_date } : {}),
      })),
    };
  },
});
