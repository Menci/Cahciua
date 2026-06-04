import { createJinaFetcher } from './jina';
import type { WebFetchConfig, WebFetcher } from './types';

export type { WebFetcher, WebFetchConfig, WebFetchProvider, WebFetchResult } from './types';

/** Select a web-fetch backend by provider. Backend choice is transparent to the tool/agent. */
export const createWebFetcher = (config: WebFetchConfig): WebFetcher => {
  switch (config.provider) {
  case 'jina':
    return createJinaFetcher({ apiKey: config.jina.apiKey });
  }
};
