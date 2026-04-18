import { describe, expect, it, vi } from 'vitest';

import { createReadImageTool, createTool, executeToolCall } from './tools';

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

describe('createReadImageTool', () => {
  it('supports file-id-only mode when readFile is unavailable', async () => {
    const tinyPng = await createTinyPng();
    const downloadAttachment = vi.fn(async () => tinyPng);
    const resolveImageToText = vi.fn(async () => 'tiny image');
    const tool = createReadImageTool({ downloadAttachment, resolveImageToText });

    expect(tool.function.description).toContain('current conversation');
    expect((tool.function.parameters as any).properties.path).toBeUndefined();

    const result = await tool.execute({ file_id: '1:0' }, { toolCallId: 'tc1' });
    expect(downloadAttachment).toHaveBeenCalledWith('1:0');
    expect(resolveImageToText).toHaveBeenCalled();
    expect(result).toEqual({
      content: JSON.stringify({ ok: true, description: 'tiny image' }),
      requiresFollowUp: true,
    });
  });

  it('rejects filesystem paths when readFile is unavailable', async () => {
    const tool = createReadImageTool({
      downloadAttachment: async () => await createTinyPng(),
    });

    const result = await tool.execute({ path: '/tmp/test.png' }, { toolCallId: 'tc1' });
    expect(result).toEqual({
      content: JSON.stringify({ error: 'This chat only supports read_image by file_id from the current conversation.' }),
      requiresFollowUp: true,
    });
  });

  it('adds filesystem path support when readFile is available', async () => {
    const tinyPng = await createTinyPng();
    const readFile = vi.fn(async () => tinyPng);
    const tool = createReadImageTool({
      downloadAttachment: async () => { throw new Error('should not be called'); },
      readFile,
    });

    expect(tool.function.description).toContain('filesystem');
    expect((tool.function.parameters as any).properties.path).toMatchObject({ type: 'string' });

    const result = await tool.execute({ path: '/tmp/test.png' }, { toolCallId: 'tc1' });
    expect(readFile).toHaveBeenCalledWith('/tmp/test.png');
    expect(result).toMatchObject({
      requiresFollowUp: true,
      content: [{ kind: 'image', detail: 'low' }],
    });
  });
});

describe('executeToolCall', () => {
  const log = { withFields: () => log, withError: () => log, error: () => {}, log: () => {} } as any;

  const greetTool = createTool({
    name: 'greet',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: async (input) => {
      const { name } = input as { name: string };
      return { content: `hello ${name}`, requiresFollowUp: false };
    },
  });

  it('returns error for unknown tool', async () => {
    const result = await executeToolCall('id1', 'nonexistent', '{}', [greetTool], log);
    const payload = JSON.parse(result.payload as string);
    expect(payload.error).toContain('Unknown tool: nonexistent');
  });

  it('returns error for invalid JSON args', async () => {
    const result = await executeToolCall('id1', 'greet', '{not json', [greetTool], log);
    const payload = JSON.parse(result.payload as string);
    expect(payload.error).toContain('Invalid JSON');
    expect(payload.error).toContain('{not json');
  });

  it('returns error when args fail schema validation', async () => {
    const result = await executeToolCall('id1', 'greet', '{"age": 5}', [greetTool], log);
    const payload = JSON.parse(result.payload as string);
    expect(payload.error).toContain('do not match schema');
    expect(payload.error).toContain('name');
  });

  it('executes successfully with valid args', async () => {
    const result = await executeToolCall('id1', 'greet', '{"name": "world"}', [greetTool], log);
    expect(result.payload).toBe('hello world');
    expect(result.requiresFollowUp).toBe(false);
  });

  it('returns error when tool.execute throws', async () => {
    const throwingTool = createTool({
      name: 'greet',
      parameters: greetTool.function.parameters,
      execute: async () => { throw new Error('boom'); },
    });
    const result = await executeToolCall('id1', 'greet', '{"name": "x"}', [throwingTool], log);
    const payload = JSON.parse(result.payload as string);
    expect(payload.error).toContain('boom');
    expect(result.requiresFollowUp).toBe(true);
  });
});
