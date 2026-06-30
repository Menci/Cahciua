import type { Logger } from '@guiiai/logg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrimaryTools } from './primary-tools';
import type { PrimaryToolsDependencies } from './primary-tools';
import type { CahciuaTool } from './tools';
import { createWebFetcher } from './web-fetch';
import { createWebSearcher } from './web-search';
import { renderImageToTextSystemPrompt } from '../media/image-to-text-prompt';
import { callDescriptionLlm } from '../media/llm-description';

vi.mock('./web-fetch', () => ({ createWebFetcher: vi.fn() }));
vi.mock('./web-search', () => ({ createWebSearcher: vi.fn() }));
vi.mock('../media/image-to-text-prompt', () => ({ renderImageToTextSystemPrompt: vi.fn() }));
vi.mock('../media/llm-description', () => ({ callDescriptionLlm: vi.fn() }));

const findTool = (tools: CahciuaTool[], name: string): CahciuaTool => {
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
};

const createTinyPng = async (): Promise<Buffer> => {
  const { default: sharp } = await import('sharp');
  return await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).png().toBuffer();
};

const createFixture = () => {
  const logger = {
    withFields: vi.fn(),
    log: vi.fn(),
  };
  logger.withFields.mockImplementation(() => logger);

  const endpoint = {
    apiBaseUrl: 'https://llm.example.test',
    apiKey: 'secret',
    model: 'vision-model',
    apiFormat: 'anthropic-messages' as const,
    maxImagesAllowed: 3,
  };
  const deps: PrimaryToolsDependencies = {
    chatId: 'chat-1',
    chatConfig: {
      imageToText: { enabled: false },
      tools: {
        bash: { backgroundThresholdSec: 10 },
      },
    },
    runtimeConfig: {
      shell: [process.execPath, '-e'],
      writeFile: [process.execPath, '-e', 'process.stdin.resume()'],
      readFile: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(0))'],
      writeFileSizeLimit: 1024 * 1024,
      readFileSizeLimit: 1024 * 1024,
    },
    sendMessage: vi.fn(async () => ({ messageId: 77 })),
    setMessageReaction: vi.fn(async () => {}),
    loadMessageAttachments: vi.fn(() => [{ type: 'photo' as const }]),
    messageExists: vi.fn(() => true),
    downloadMessageMedia: vi.fn(async () => undefined),
    resolveModel: vi.fn(() => endpoint),
    backgroundTask: {
      startTask: vi.fn(() => 9),
      killTask: vi.fn(() => ({ ok: true })),
      readTaskOutput: vi.fn(async () => ({ content: 'done', totalLines: 1, truncated: false })),
    },
    log: logger as unknown as Logger,
  };

  return { deps, endpoint, logger };
};

beforeEach(() => {
  vi.mocked(createWebFetcher).mockReset();
  vi.mocked(createWebSearcher).mockReset();
  vi.mocked(renderImageToTextSystemPrompt).mockReset();
  vi.mocked(callDescriptionLlm).mockReset();
});

describe('createPrimaryTools', () => {
  it('preserves tool order and inserts configured web providers in place', async () => {
    const { deps } = createFixture();
    const search = vi.fn(async () => ({ results: [] }));
    const fetch = vi.fn(async (url: string) => ({ url, content: 'page' }));
    vi.mocked(createWebSearcher).mockReturnValue({ search });
    vi.mocked(createWebFetcher).mockReturnValue({ fetch });

    expect(createPrimaryTools(deps).map(tool => tool.name)).toEqual([
      'send_message',
      'react',
      'bash',
      'download_file',
      'read_image',
      'kill_task',
      'read_task_output',
      'sleep',
      'end_turn',
    ]);

    const webSearch = { provider: 'exa' as const, apiKey: 'exa-key' };
    const webFetch = { provider: 'jina' as const, jina: { apiKey: 'jina-key' } };
    deps.chatConfig.tools.webSearch = webSearch;
    deps.chatConfig.tools.webFetch = webFetch;
    const tools = createPrimaryTools(deps);

    expect(tools.map(tool => tool.name)).toEqual([
      'send_message',
      'react',
      'bash',
      'web_search',
      'web_fetch',
      'download_file',
      'read_image',
      'kill_task',
      'read_task_output',
      'sleep',
      'end_turn',
    ]);
    expect(createWebSearcher).toHaveBeenCalledWith(webSearch);
    expect(createWebFetcher).toHaveBeenCalledWith(webFetch);

    await findTool(tools, 'web_search').execute({ query: 'query' });
    await findTool(tools, 'web_fetch').execute({ url: 'https://example.test' });
    expect(search).toHaveBeenCalledWith('query');
    expect(fetch).toHaveBeenCalledWith('https://example.test');
  });

  it('keeps send_message semantics and checks Telegram message ids before I/O', async () => {
    const { deps, logger } = createFixture();
    vi.mocked(deps.messageExists).mockImplementation((_chatId, messageId) => messageId === 42);
    const tools = createPrimaryTools(deps);
    const sendMessage = findTool(tools, 'send_message');
    const react = findTool(tools, 'react');

    expect(sendMessage.parameters).toMatchObject({
      properties: { still_working: { type: 'boolean' } },
      required: ['text'],
    });
    await expect(sendMessage.execute(
      { text: 'invalid reply', reply_to: '404' },
    )).resolves.toMatchObject({ requiresFollowUp: true });
    await expect(react.execute(
      { message_id: '404', emoji: '\u{1F44D}' },
    )).resolves.toMatchObject({ requiresFollowUp: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.setMessageReaction).not.toHaveBeenCalled();

    const text = 'x'.repeat(101);
    const attachments = [{ type: 'photo' as const, path: 'image.png' }];
    await expect(sendMessage.execute(
      { text, reply_to: '42', still_working: true, attachments },
    )).resolves.toEqual({
      content: JSON.stringify({ ok: true, message_id: '77' }),
      requiresFollowUp: true,
    });
    await expect(sendMessage.execute(
      { text: 'done' },
    )).resolves.toMatchObject({ requiresFollowUp: false });
    await react.execute(
      { message_id: '42', emoji: '\u{1F44D}' },
    );

    expect(deps.sendMessage).toHaveBeenCalledWith('chat-1', text, 42, attachments);
    expect(deps.setMessageReaction).toHaveBeenCalledWith('chat-1', 42, '\u{1F44D}');
    expect(logger.withFields).toHaveBeenCalledWith({
      chatId: 'chat-1',
      text: `${'x'.repeat(100)}...`,
      replyTo: '42',
      attachments: 1,
    });
    expect(logger.log).toHaveBeenCalledWith('send_message tool called');
  });

  it('wires background task start, kill, and output reads to the current chat', async () => {
    const { deps } = createFixture();
    const tools = createPrimaryTools(deps);

    await findTool(tools, 'bash').execute({
      command: 'long-command',
      timeout_seconds: 11,
      intention: 'wait for output',
    });
    await findTool(tools, 'kill_task').execute({ task_id: 9 });
    await findTool(tools, 'read_task_output').execute({
      task_id: 9,
      offset: 10,
      limit: 20,
    });

    expect(deps.backgroundTask.startTask).toHaveBeenCalledWith(
      'shell_execute',
      'chat-1',
      { command: 'long-command', shell: deps.runtimeConfig.shell },
      'wait for output',
      11_000,
    );
    expect(deps.backgroundTask.killTask).toHaveBeenCalledWith(9);
    expect(deps.backgroundTask.readTaskOutput).toHaveBeenCalledWith(9, 10, 20);
  });

  it('shares the Telegram attachment downloader with download_file', async () => {
    const { deps } = createFixture();
    vi.mocked(deps.downloadMessageMedia).mockResolvedValue(Buffer.from('file'));
    const result = await findTool(createPrimaryTools(deps), 'download_file').execute({
      file_id: '123:0',
      path: 'downloaded.bin',
    });

    expect(deps.loadMessageAttachments).toHaveBeenCalledWith('chat-1', 123);
    expect(deps.downloadMessageMedia).toHaveBeenCalledWith('chat-1', 123);
    expect(result).toEqual({
      content: JSON.stringify({ ok: true, path: 'downloaded.bin', size: 4 }),
      requiresFollowUp: true,
    });
  });

  it('uses the configured model through the media description call for read_image', async () => {
    const { deps, endpoint } = createFixture();
    const image = await createTinyPng();
    deps.chatConfig.imageToText = { enabled: true, model: 'vision' };
    vi.mocked(deps.downloadMessageMedia).mockResolvedValue(image);
    vi.mocked(renderImageToTextSystemPrompt).mockResolvedValue('image system');
    vi.mocked(callDescriptionLlm).mockResolvedValue({ text: '  described image  ', outputTokens: 5 });

    const result = await findTool(createPrimaryTools(deps), 'read_image').execute({
      file_id: '123:0',
      detail: 'high',
    });

    expect(deps.resolveModel).toHaveBeenCalledWith('vision');
    expect(renderImageToTextSystemPrompt).toHaveBeenCalledWith({ caption: '', detail: 'high' });
    expect(callDescriptionLlm).toHaveBeenCalledOnce();
    const params = vi.mocked(callDescriptionLlm).mock.calls[0]![0];
    expect(params).toMatchObject({
      model: endpoint,
      system: 'image system',
      userText: 'Describe this image.',
      log: deps.log,
      label: 'read-image',
    });
    expect(params.images).toHaveLength(1);
    expect(Buffer.isBuffer(params.images[0])).toBe(true);
    expect(result).toEqual({
      content: JSON.stringify({ ok: true, description: 'described image' }),
      requiresFollowUp: true,
    });
  });
});
