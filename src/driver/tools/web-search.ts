import { createTool } from './create-tool';
import type { CahciuaTool } from './types';
import type { WebSearcher } from '../web-search/types';

export const createWebSearchTool = (searcher: WebSearcher): CahciuaTool => createTool({
  name: 'web_search',
  description: 'Search the web. Returns up to 5 results with title, URL, and a relevant snippet/passage.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
    },
    required: ['query'],
  },
  execute: async input => {
    const { query } = input as { query: string };
    const result = await searcher.search(query);
    return {
      content: JSON.stringify({
        results: result.results.map(item => ({
          title: item.title,
          url: item.url,
          snippet: item.snippet,
          ...(item.pageAge ? { page_age: item.pageAge } : {}),
        })),
      }),
      requiresFollowUp: true,
    };
  },
});
