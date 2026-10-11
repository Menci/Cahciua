import { createTool } from './create-tool';
import type { CahciuaTool } from './types';

export const createHistoryQueryTool = (execute: (code: string) => Promise<unknown>): CahciuaTool => createTool({
  name: 'history_query',
  description: 'Run an async JavaScript history query in the current chat using search, thread, context and sql. See the system prompt for the complete SDK and public SQL schema. Return JSON evidence; all scope, policy and execution budgets are enforced by the host.',
  parameters: { type: 'object', properties: { code: { type: 'string', description: 'Async JavaScript function body using search/thread/context/sql; return JSON.' } }, required: ['code'], additionalProperties: false },
  execute: async input => ({ content: JSON.stringify(await execute((input as { code: string }).code)), requiresFollowUp: true }),
});
