import { execFile } from 'node:child_process';

import { Validator } from '@cfworker/json-schema';
import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import type { RuntimeConfig } from '../config/config';
import type { Attachment } from '../telegram/message/types';
import type {
  ConversationEntry,
  InputPart,
  ToolCallPart,
  ToolResult as IRToolResult,
} from '../unified-api/types';

export interface ToolResult {
  content: string | InputPart[];
  requiresFollowUp: boolean;
}

export const isToolResult = (v: unknown): v is ToolResult =>
  typeof v === 'object' && v !== null && 'requiresFollowUp' in v;

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
  validate: (input: unknown) => { valid: boolean; errors: string[] };
  execute: (input: unknown, options: CahciuaToolExecuteOptions) => Promise<ToolResult> | ToolResult;
}

export const createTool = (def: {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  execute: CahciuaTool['execute'];
}): CahciuaTool => {
  const validator = new Validator(def.parameters as object);
  return {
    type: 'function',
    function: {
      name: def.name,
      parameters: def.parameters,
      ...(def.description ? { description: def.description } : {}),
      ...(def.strict != null ? { strict: def.strict } : {}),
    },
    validate: (input: unknown) => {
      const result = validator.validate(input);
      return {
        valid: result.valid,
        errors: result.errors.map(e => `${e.instanceLocation}: ${e.error}`),
      };
    },
    execute: def.execute,
  };
};

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

  return createTool({
    name: 'send_message',
    description: enableAttachments
      ? 'Send a message in the current conversation, optionally with media attachments.'
      : 'Send a message in the current conversation.',
    parameters: {
      type: 'object',
      properties,
      required: ['text'],
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
        content: JSON.stringify({ ok: true, message_id: result.messageId }),
        requiresFollowUp: await_response ?? false,
      };
    },
  });
};

const BASH_MAX_OUTPUT = 4096;
const BASH_TIMEOUT_MS = 30_000;

export const createBashTool = (runtime: RuntimeConfig, backgroundTask?: {
  startTask: (typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => number;
  sessionId: string;
  backgroundThresholdSec: number;
}): CahciuaTool => createTool({
  name: 'bash',
  description:
    'Execute a shell command. Output (stdout+stderr combined) is truncated to 4 KB. ' +
    `For large outputs, redirect to a file and read specific ranges. ${
      backgroundTask
        ? `Set timeout_seconds > ${backgroundTask.backgroundThresholdSec} for long-running commands — they run as background tasks and return immediately with a task ID.`
        : ''}`,
  parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        ...(backgroundTask ? {
          timeout_seconds: {
            type: 'number',
            description: `Timeout in seconds. Commands with timeout > ${backgroundTask.backgroundThresholdSec}s run as background tasks and return immediately with a task ID. Short commands (e.g. ls, cat) typically need 5-10s; builds or tests may need 60-300s.`,
          },
          intention: { type: 'string', description: 'Brief description of what this command does (shown in background task status).' },
        } : {}),
      },
      required: backgroundTask ? ['command', 'timeout_seconds'] : ['command'],
    },
  execute: async input => {
    const { command, timeout_seconds, intention } = input as { command: string; timeout_seconds?: number; intention?: string };
    const timeoutSec = timeout_seconds ?? 30; // fallback for non-background-task mode

    // Background task path
    if (backgroundTask && timeoutSec > backgroundTask.backgroundThresholdSec) {
      const taskId = backgroundTask.startTask(
        'shell_execute',
        backgroundTask.sessionId,
        { command, shell: runtime.shell },
        intention,
        timeoutSec * 1000,
      );
      return {
        content: JSON.stringify({ background_task_id: taskId, message: `Background task started (id: ${taskId}). You will be notified when it completes. Use kill_task to cancel or read_task_output to view results.` }),
        requiresFollowUp: true,
      };
    }

    // Synchronous execution path
    return await new Promise<ToolResult>(resolve => {
      const child = execFile(
        runtime.shell[0]!,
        [...runtime.shell.slice(1), command],
        { timeout: Math.min(timeoutSec * 1000, BASH_TIMEOUT_MS), maxBuffer: BASH_MAX_OUTPUT * 2 },
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
            content: JSON.stringify({ exit_code: exitCode, output, truncated }),
            requiresFollowUp: true,
          });
        },
      );
    });
  },
});

const WEB_SEARCH_TIMEOUT_MS = 15_000;

export const createWebSearchTool = (tavilyKey: string): CahciuaTool => createTool({
  name: 'web_search',
  description: 'Search the web using Tavily. Returns an answer and up to 5 results.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
    },
    required: ['query'],
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
        content: JSON.stringify({ error: `Tavily API error: ${resp.status}`, detail: text }),
        requiresFollowUp: true,
      };
    }
    const data = await resp.json() as { answer?: string; results?: { title: string; url: string; content: string }[] };
    return {
      content: JSON.stringify({
        answer: data.answer ?? null,
        results: (data.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: r.content })),
      }),
      requiresFollowUp: true,
    };
  },
});

const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Shared file_id → Buffer logic used by download_file and read_image tools. */
export const createAttachmentDownloader = (deps: {
  chatId: string;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  downloadFile: (fileId: string) => Promise<Buffer>;
  downloadMessageMedia?: (chatId: string, messageId: number) => Promise<Buffer | undefined>;
}): (fileId: string) => Promise<Buffer> =>
  async (fileId: string): Promise<Buffer> => {
    const colonIdx = fileId.lastIndexOf(':');
    if (colonIdx < 0) throw new Error('Invalid file_id format. Expected "messageId:index".');

    const messageId = parseInt(fileId.slice(0, colonIdx), 10);
    const attachmentIndex = parseInt(fileId.slice(colonIdx + 1), 10);
    if (isNaN(messageId) || isNaN(attachmentIndex) || attachmentIndex < 0)
      throw new Error('Invalid file_id: messageId or index is not a valid number.');

    const attachments = deps.loadMessageAttachments(deps.chatId, messageId);
    if (!attachments || attachments.length === 0)
      throw new Error(`No attachments found for message ${messageId}.`);
    if (attachmentIndex >= attachments.length)
      throw new Error(`Attachment index ${attachmentIndex} out of range (message has ${attachments.length} attachments).`);

    const att = attachments[attachmentIndex]!;

    let buffer: Buffer | undefined;
    if (att.fileId) {
      try { buffer = await deps.downloadFile(att.fileId); } catch { /* fall through to userbot */ }
    }
    if (!buffer && deps.downloadMessageMedia)
      buffer = await deps.downloadMessageMedia(deps.chatId, messageId);
    if (!buffer)
      throw new Error('Failed to download file from Telegram.');

    return buffer;
  };

export const createDownloadFileTool = (deps: {
  downloadAttachment: (fileId: string) => Promise<Buffer>;
  runtime: RuntimeConfig;
}): CahciuaTool => createTool({
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
  execute: async input => {
    const { file_id, path } = input as { file_id: string; path: string };

    let buffer: Buffer;
    try {
      buffer = await deps.downloadAttachment(file_id);
    } catch (err) {
      return { content: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), requiresFollowUp: true };
    }

    if (buffer.length > deps.runtime.writeFileSizeLimit) {
      return {
        content: JSON.stringify({ error: `File too large: ${buffer.length} bytes exceeds limit of ${deps.runtime.writeFileSizeLimit} bytes.` }),
        requiresFollowUp: true,
      };
    }

    const writeCmd = deps.runtime.writeFile!;
    return await new Promise<ToolResult>(resolve => {
      const child = execFile(
        writeCmd[0]!,
        [...writeCmd.slice(1), path],
        { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 1024 },
        (error, _stdout, stderr) => {
          if (error) {
            resolve({
              content: JSON.stringify({ error: `Failed to write file: ${stderr || error.message}` }),
              requiresFollowUp: true,
            });
          } else {
            resolve({
              content: JSON.stringify({ ok: true, path, size: buffer!.length }),
              requiresFollowUp: true,
            });
          }
        },
      );
      child.stdin?.end(buffer);
    });
  },
});

export const createKillTaskTool = (
  kill: (taskId: number) => { ok: boolean; error?: string },
): CahciuaTool => createTool({
  name: 'kill_task',
  description: 'Kill a running background task by its ID.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number', description: 'The background task ID to kill.' },
    },
    required: ['task_id'],
  },
  execute: input => {
    const { task_id } = input as { task_id: number };
    const result = kill(task_id);
    return { content: JSON.stringify(result), requiresFollowUp: true };
  },
});

export const createReadTaskOutputTool = (
  read: (taskId: number, offset?: number, limit?: number) => Promise<{ content: string; totalLines: number; truncated: boolean } | { error: string }>,
): CahciuaTool => createTool({
  name: 'read_task_output',
  description:
    'Read the full output of a completed background task. Supports pagination for large outputs. ' +
    'Use offset and limit to read specific ranges (line-based).',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number', description: 'The background task ID.' },
      offset: { type: 'number', description: 'Starting line number (0-based). Default: 0.' },
      limit: { type: 'number', description: 'Number of lines to read. Default: 200.' },
    },
    required: ['task_id'],
  },
  execute: async input => {
    const { task_id, offset, limit } = input as { task_id: number; offset?: number; limit?: number };
    const result = await read(task_id, offset, limit);
    return { content: JSON.stringify(result), requiresFollowUp: true };
  },
});

// ── read_image tool ──

const prepareImage = async (buffer: Buffer, detail: 'low' | 'high'): Promise<Buffer> => {
  const maxEdge = detail === 'high' ? 1024 : 512;
  return await sharp(buffer)
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
};

export const createReadImageTool = (deps: {
  downloadAttachment: (fileId: string) => Promise<Buffer>;
  readFile?: (path: string) => Promise<Buffer>;
  resolveImageToText?: (buffer: Buffer, detail: 'low' | 'high') => Promise<string>;
}): CahciuaTool => createTool({
  name: 'read_image',
  description: deps.readFile
    ? 'Read and analyze an image from a chat attachment or the filesystem.'
    : 'Read and analyze an image from a chat attachment in the current conversation.',
  parameters: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        description: 'The file-id from an attachment element (format: messageId:index).',
      },
      ...(deps.readFile ? {
        path: {
          type: 'string',
          description: 'Filesystem path to an image file.',
        },
      } : {}),
      detail: {
        type: 'string',
        enum: ['low', 'high'],
        description: 'Resolution level. Use "high" to read fine details or text in the image. Default: low.',
      },
    },
  },
  execute: async input => {
    const { file_id, path, detail: rawDetail } = input as { file_id?: string; path?: string; detail?: string };
    const detail: 'low' | 'high' = rawDetail === 'high' ? 'high' : 'low';

    if (!deps.readFile) {
      if (!file_id || path)
        return { content: JSON.stringify({ error: 'This chat only supports read_image by file_id from the current conversation.' }), requiresFollowUp: true };
    } else if ((!file_id && !path) || (file_id && path)) {
      return { content: JSON.stringify({ error: 'Provide exactly one of file_id or path.' }), requiresFollowUp: true };
    }

    // 1. Acquire buffer
    let buffer: Buffer;
    try {
      buffer = file_id
        ? await deps.downloadAttachment(file_id)
        : await deps.readFile!(path!);
    } catch (err) {
      return { content: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), requiresFollowUp: true };
    }

    // 2. Validate image via sharp
    try {
      await sharp(buffer).metadata();
    } catch {
      return { content: JSON.stringify({ error: 'File is not a valid image.' }), requiresFollowUp: true };
    }

    // 3. Prepare image
    const resizedBuffer = await prepareImage(buffer, detail);

    // 4. Return
    if (deps.resolveImageToText) {
      const description = await deps.resolveImageToText(resizedBuffer, detail);
      return { content: JSON.stringify({ ok: true, description }), requiresFollowUp: true };
    }

    return {
      content: [{ kind: 'image', image: sharp(resizedBuffer), detail }] satisfies InputPart[],
      requiresFollowUp: true,
    };
  },
});

/** Extract ToolCallParts from assistant OutputMessage entries. */
export const extractToolCalls = (entries: ConversationEntry[]): ToolCallPart[] => {
  const calls: ToolCallPart[] = [];
  for (const e of entries) {
    if (e.kind === 'message' && e.role === 'assistant') {
      for (const p of e.parts) if (p.kind === 'toolCall') calls.push(p);
    }
  }
  return calls;
};

const toolError = (id: string, message: string): IRToolResult => ({
  kind: 'toolResult',
  callId: id,
  payload: JSON.stringify({ error: message }),
  requiresFollowUp: true,
});

/** Execute a tool call against the tools list, returning an IR ToolResult. */
export const executeToolCall = async (
  id: string, name: string, args: string,
  tools: CahciuaTool[], log: Logger,
): Promise<IRToolResult> => {
  const tool = tools.find(t => t.function.name === name);
  if (!tool) return toolError(id, `Unknown tool: ${name}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    log.withFields({ tool: name, args }).error('Tool call has invalid JSON args');
    return toolError(id, `Invalid JSON in tool arguments: ${args.slice(0, 200)}`);
  }

  const { valid, errors } = tool.validate(parsed);
  if (!valid) {
    log.withFields({ tool: name, errors }).error('Tool call args failed schema validation');
    return toolError(id, `Arguments do not match schema: ${errors.join('; ')}`);
  }

  try {
    const rawResult = await tool.execute(parsed, { toolCallId: id });
    const { content, requiresFollowUp } = isToolResult(rawResult)
      ? rawResult
      : { content: JSON.stringify(rawResult), requiresFollowUp: true };
    return {
      kind: 'toolResult',
      callId: id,
      payload: content as string | InputPart[],
      requiresFollowUp,
    };
  } catch (err) {
    log.withError(err).error(`Tool ${name} failed`);
    return toolError(id, String(err));
  }
};
