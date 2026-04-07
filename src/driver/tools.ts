import { execFile } from 'node:child_process';

import type { ToolExecuteResult } from 'xsai';

export interface ToolResult {
  content: unknown;
  requiresFollowUp: boolean;
}

export const isToolResult = (v: unknown): v is ToolResult =>
  typeof v === 'object' && v !== null && 'requiresFollowUp' in v;

// Our tool execute interface — only toolCallId, no messages context.
export interface CahciuaToolExecuteOptions {
  toolCallId: string;
}

export interface CahciuaTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
  execute: (input: unknown, options: CahciuaToolExecuteOptions) => Promise<ToolExecuteResult> | ToolExecuteResult;
}

export const createSendMessageTool = (
  send: (text: string, replyTo?: string) => Promise<{ messageId: string }>,
): CahciuaTool => ({
  type: 'function',
  function: {
    name: 'send_message',
    description: 'Send a message in the current conversation.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send.' },
        reply_to: { type: 'string', description: 'A message id to reply to.' },
        await_response: {
          type: 'boolean',
          description: 'Set to true if you need to perform additional actions after this message (e.g., send another message, use another tool). Defaults to false.',
        },
      },
      required: ['text'],
    },
  },
  execute: async input => {
    const { text, reply_to, await_response } = input as { text: string; reply_to?: string; await_response?: boolean };
    const result = await send(text, reply_to);
    return {
      content: { ok: true, message_id: result.messageId },
      requiresFollowUp: await_response ?? false,
    };
  },
});

const BASH_MAX_OUTPUT = 4096;
const BASH_TIMEOUT_MS = 30_000;

export const createBashTool = (shell: string[]): CahciuaTool => ({
  type: 'function',
  function: {
    name: 'bash',
    description:
      'Execute a shell command. Output (stdout+stderr combined) is truncated to 4 KB. ' +
      'For large outputs, redirect to a file and read specific ranges.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
      },
      required: ['command'],
    },
  },
  execute: async input => {
    const { command } = input as { command: string };
    return await new Promise<ToolExecuteResult>(resolve => {
      const child = execFile(
        shell[0]!,
        [...shell.slice(1), command],
        { timeout: BASH_TIMEOUT_MS, maxBuffer: BASH_MAX_OUTPUT * 2 },
        (error, stdout, stderr) => {
          let output = stdout + stderr;
          let truncated = false;
          if (output.length > BASH_MAX_OUTPUT) {
            output = output.slice(0, BASH_MAX_OUTPUT);
            truncated = true;
          }
          const exitCode = error ? (error as NodeJS.ErrnoException & { code?: string | number }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'truncated'
            : (child.exitCode ?? 1)
            : 0;
          resolve({
            content: { exit_code: exitCode, output, truncated },
            requiresFollowUp: true,
          });
        },
      );
    });
  },
});

const WEB_SEARCH_TIMEOUT_MS = 15_000;

export const createWebSearchTool = (tavilyKey: string): CahciuaTool => ({
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web using Tavily. Returns an answer and up to 5 results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
  },
  execute: async input => {
    const { query } = input as { query: string };
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        search_depth: 'basic',
        include_answer: true,
        max_results: 5,
      }),
      signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return {
        content: { error: `Tavily API error: ${resp.status}`, detail: text },
        requiresFollowUp: true,
      };
    }
    const data = await resp.json() as { answer?: string; results?: { title: string; url: string; content: string }[] };
    return {
      content: {
        answer: data.answer ?? null,
        results: (data.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: r.content })),
      },
      requiresFollowUp: true,
    };
  },
});
