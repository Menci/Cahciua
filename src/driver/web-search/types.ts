export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  /** ISO8601 last-updated/crawled/published date, when the backend exposes one. */
  pageAge?: string;
}

export interface WebSearchResult {
  results: WebSearchResultItem[];
}

/**
 * A pluggable web-search backend. The tool schema only ever exposes `query`;
 * provider-specific knobs (API keys, regions, formats) stay inside the
 * implementation. Errors propagate — `executeToolCall` turns them into a
 * tool-result error string.
 */
export interface WebSearcher {
  search: (query: string) => Promise<WebSearchResult>;
}

export type WebSearchProvider = 'tavily' | 'microsoft-grounding' | 'jina' | 'exa';

export interface WebSearchConfig {
  provider: WebSearchProvider;
  apiKey: string;
}
