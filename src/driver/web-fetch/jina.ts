import type { WebFetcher, WebFetchResult } from './types';
import { HttpError } from '../../http';

// Server-side page-load budget; our own abort gives extra margin for Jina
// processing + network round-trip on top of this.
const JINA_PAGE_TIMEOUT_SEC = 15;
const JINA_REQUEST_TIMEOUT_MS = 30_000;

interface JinaJsonResponse {
  code: number;
  status?: number;
  name?: string;
  message?: string;
  data?: {
    title?: string;
    url?: string;
    content?: string;
  } | null;
}

/**
 * Jina Reader (https://r.jina.ai). Engine, caching and link/image retention
 * are fixed here, never exposed to the agent:
 * - `X-Engine: auto` — Jina internally falls back to a headless browser for
 *   JS-rendered pages, so the agent never has to choose an engine.
 * - default cache (~3600s) left on — cheaper/faster for a low-frequency bot.
 * - default `retain` (all) keeps inline `[text](url)` / `![alt](url)` so the
 *   agent can read and follow links without a separate summary appendix.
 * Auth (and its higher rate limit / proxy pool) is unlocked by an optional key.
 */
export const createJinaFetcher = (opts: { apiKey: string }): WebFetcher => ({
  fetch: async (url: string): Promise<WebFetchResult> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Engine': 'auto',
      'X-Timeout': String(JINA_PAGE_TIMEOUT_SEC),
    };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

    const endpoint = `https://r.jina.ai/${url}`;
    const resp = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(JINA_REQUEST_TIMEOUT_MS),
    });

    const body = await resp.json().catch(() => null) as JinaJsonResponse | null;

    if (!resp.ok || body?.code !== 200 || !body.data) {
      const detail = body?.message ?? body?.name ?? (await resp.text().catch(() => '')) ?? '';
      if (!resp.ok && !detail) throw new HttpError(resp.status, endpoint);
      throw new Error(`Jina Reader failed (${resp.status})${detail ? `: ${detail}` : ''}`);
    }

    return {
      url: body.data.url ?? url,
      content: body.data.content ?? '',
      ...(body.data.title ? { title: body.data.title } : {}),
    };
  },
});
