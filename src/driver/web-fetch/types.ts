export interface WebFetchResult {
  /** Page title, if the backend resolved one. */
  title?: string;
  /** Final resolved URL (after redirects), echoed back by the backend. */
  url: string;
  /** Page body as LLM-readable markdown. Inline links/images are preserved. */
  content: string;
}

/**
 * A pluggable web-fetch backend: turn a URL into LLM-readable markdown.
 * Implementations own all backend-specific concerns (engine choice, caching,
 * auth) — none of it leaks to the tool schema, which only ever exposes `url`.
 * Errors propagate; the tool layer turns them into a plain-text result.
 */
export interface WebFetcher {
  fetch: (url: string) => Promise<WebFetchResult>;
}

export type WebFetchProvider = 'jina';

export interface WebFetchConfig {
  provider: WebFetchProvider;
  jina: { apiKey: string };
}
