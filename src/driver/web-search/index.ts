import { createExaSearcher } from './exa';
import { createJinaSearcher } from './jina';
import { createMicrosoftGroundingSearcher } from './microsoft-grounding';
import { createTavilySearcher } from './tavily';
import type { WebSearchConfig, WebSearcher } from './types';

export type { WebSearcher, WebSearchResult, WebSearchResultItem, WebSearchConfig, WebSearchProvider } from './types';

export const createWebSearcher = (config: WebSearchConfig): WebSearcher => {
  switch (config.provider) {
  case 'tavily':
    return createTavilySearcher({ apiKey: config.apiKey });
  case 'microsoft-grounding':
    return createMicrosoftGroundingSearcher({ apiKey: config.apiKey });
  case 'jina':
    return createJinaSearcher({ apiKey: config.apiKey });
  case 'exa':
    return createExaSearcher({ apiKey: config.apiKey });
  }
};
