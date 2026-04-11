import { execFile } from 'node:child_process';

import type { ToolExecuteResult } from 'xsai';

import type { RuntimeConfig } from '../config/config';
import type { Attachment } from '../telegram/message/types';

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

export interface SendMessageAttachment {
  type: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'video_note';
  path: string;
  file_name?: string;
}

export const createSendMessageTool = (
  send: (text: string, replyTo?: string, attachments?: SendMessageAttachment[]) => Promise<{ messageId: string }>,
  enableAttachments: boolean,
): CahciuaTool => {
  const properties: Record<string, unknown> = {
    text: { type: 'string', description: 'The message to send. When sending attachments, this becomes the caption.' },
    reply_to: { type: 'string', description: 'A message id to reply to.' },
    await_response: {
      type: 'boolean',
      description: 'Set to true if you need to perform additional actions after this message (e.g., send another message, use another tool). Defaults to false.',
    },
  };

  if (enableAttachments) {
    properties.attachments = {
      type: 'array',
      description: 'Media attachments to send. Multiple attachments are sent as a media group (album). Telegram media groups support up to 10 items; photos and videos can be mixed, but audio and documents must be grouped separately.',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['document', 'photo', 'video', 'audio', 'voice', 'animation', 'video_note'],
            description: 'The type of media to send.',
          },
          path: { type: 'string', description: 'File path in the workspace.' },
          file_name: { type: 'string', description: 'Override filename (for document type only).' },
        },
        required: ['type', 'path'],
      },
    };
  }

  return {
    type: 'function',
    function: {
      name: 'send_message',
      description: enableAttachments
        ? 'Send a message in the current conversation, optionally with media attachments.'
        : 'Send a message in the current conversation.',
      parameters: {
        type: 'object',
        properties,
        required: ['text'],
      },
    },
    execute: async input => {
      const { text, reply_to, await_response, attachments } = input as {
        text: string;
        reply_to?: string;
        await_response?: boolean;
        attachments?: SendMessageAttachment[];
      };
      const result = await send(text, reply_to, attachments);
      return {
        content: { ok: true, message_id: result.messageId },
        requiresFollowUp: await_response ?? false,
      };
    },
  };
};

const BASH_MAX_OUTPUT = 4096;
const BASH_TIMEOUT_MS = 30_000;

export const createBashTool = (runtime: RuntimeConfig): CahciuaTool => ({
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
        runtime.shell[0]!,
        [...runtime.shell.slice(1), command],
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

const DOWNLOAD_TIMEOUT_MS = 60_000;

export const createDownloadFileTool = (deps: {
  chatId: string;
  runtime: RuntimeConfig;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  downloadFile: (fileId: string) => Promise<Buffer>;
  downloadMessageMedia?: (chatId: string, messageId: number) => Promise<Buffer | undefined>;
}): CahciuaTool => ({
  type: 'function',
  function: {
    name: 'download_file',
    description: 'Download a file attachment from the chat to a local path. Use the file-id attribute from attachment elements in the chat context.',
    parameters: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The file-id attribute from an attachment element (format: messageId:index).' },
        path: { type: 'string', description: 'Destination file path in the workspace.' },
      },
      required: ['file_id', 'path'],
    },
  },
  // TODO: introduce async background tasks for large file transfers
  execute: async input => {
    const { file_id, path } = input as { file_id: string; path: string };

    // Parse file_id → messageId:attachmentIndex
    const colonIdx = file_id.lastIndexOf(':');
    if (colonIdx < 0) {
      return { content: { error: 'Invalid file_id format. Expected "messageId:index".' }, requiresFollowUp: true };
    }
    const messageId = parseInt(file_id.slice(0, colonIdx), 10);
    const attachmentIndex = parseInt(file_id.slice(colonIdx + 1), 10);
    if (isNaN(messageId) || isNaN(attachmentIndex) || attachmentIndex < 0) {
      return { content: { error: 'Invalid file_id: messageId or index is not a valid number.' }, requiresFollowUp: true };
    }

    // Load attachments from messages table
    const attachments = deps.loadMessageAttachments(deps.chatId, messageId);
    if (!attachments || attachments.length === 0) {
      return { content: { error: `No attachments found for message ${messageId}.` }, requiresFollowUp: true };
    }
    if (attachmentIndex >= attachments.length) {
      return { content: { error: `Attachment index ${attachmentIndex} out of range (message has ${attachments.length} attachments).` }, requiresFollowUp: true };
    }
    const att = attachments[attachmentIndex]!;

    // Download media: Bot API (fileId) first, userbot fallback
    let buffer: Buffer | undefined;
    if (att.fileId) {
      try {
        buffer = await deps.downloadFile(att.fileId);
      } catch {
        // Fall through to userbot
      }
    }
    if (!buffer && deps.downloadMessageMedia) {
      buffer = await deps.downloadMessageMedia(deps.chatId, messageId);
    }
    if (!buffer) {
      return { content: { error: 'Failed to download file from Telegram.' }, requiresFollowUp: true };
    }

    // Size check
    if (buffer.length > deps.runtime.writeFileSizeLimit) {
      return {
        content: { error: `File too large: ${buffer.length} bytes exceeds limit of ${deps.runtime.writeFileSizeLimit} bytes.` },
        requiresFollowUp: true,
      };
    }

    // Write file via configured command
    const writeCmd = deps.runtime.writeFile!;
    return await new Promise<ToolExecuteResult>(resolve => {
      const child = execFile(
        writeCmd[0]!,
        [...writeCmd.slice(1), path],
        { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 1024 },
        (error, _stdout, stderr) => {
          if (error) {
            resolve({
              content: { error: `Failed to write file: ${stderr || error.message}` },
              requiresFollowUp: true,
            });
          } else {
            resolve({
              content: { ok: true, path, size: buffer!.length },
              requiresFollowUp: true,
            });
          }
        },
      );
      child.stdin?.end(buffer);
    });
  },
});
