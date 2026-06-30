import { describe, expect, it, vi } from 'vitest';

import { createBashTool, createReadImageTool, createSendMessageTool, executeToolCall } from './tools';
import { createTool } from './tools/create-tool';
import type { RuntimeConfig } from '../config/config';

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
  it('resolves image-to-text description via attachment file_id', async () => {
    const tinyPng = await createTinyPng();
    const downloadAttachment = vi.fn(async () => tinyPng);
    const resolveImageToText = vi.fn(async () => 'tiny image');
    const readFile = vi.fn(async () => tinyPng);
    const tool = createReadImageTool({ downloadAttachment, readFile, resolveImageToText });

    expect(tool.description).toContain('filesystem');
    expect((tool.parameters as any).properties.path).toMatchObject({ type: 'string' });

    const result = await tool.execute({ file_id: '1:0' });
    expect(downloadAttachment).toHaveBeenCalledWith('1:0');
    expect(resolveImageToText).toHaveBeenCalled();
    expect(result).toEqual({
      content: JSON.stringify({ ok: true, description: 'tiny image' }),
      requiresFollowUp: true,
    });
  });

  it('rejects when both file_id and path are provided', async () => {
    const tool = createReadImageTool({
      downloadAttachment: async () => await createTinyPng(),
      readFile: async () => await createTinyPng(),
    });

    const result = await tool.execute({ file_id: '1:0', path: '/tmp/test.png' });
    expect(result).toEqual({
      content: JSON.stringify({ error: 'Provide exactly one of file_id or path.' }),
      requiresFollowUp: true,
    });
  });

  it('reads image from filesystem path', async () => {
    const tinyPng = await createTinyPng();
    const readFile = vi.fn(async () => tinyPng);
    const tool = createReadImageTool({
      downloadAttachment: async () => { throw new Error('should not be called'); },
      readFile,
    });

    const result = await tool.execute({ path: '/tmp/test.png' });
    expect(readFile).toHaveBeenCalledWith('/tmp/test.png');
    expect(result).toMatchObject({
      requiresFollowUp: true,
      content: [{ kind: 'image', detail: 'low' }],
    });
  });
});

describe('createSendMessageTool', () => {
  it('uses still_working as the follow-up contract', async () => {
    const send = vi.fn(async () => ({ messageId: '42' }));
    const tool = createSendMessageTool(send, () => true);
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).toHaveProperty('still_working');
    expect(properties).not.toHaveProperty('await_response');
    await expect(tool.execute({ text: 'working', still_working: true }))
      .resolves.toMatchObject({ requiresFollowUp: true });
    await expect(tool.execute({ text: 'done' }))
      .resolves.toMatchObject({ requiresFollowUp: false });
  });
});

describe('createBashTool', () => {
  it('does not split a surrogate pair when truncating output', async () => {
    const runtime: RuntimeConfig = {
      shell: [process.execPath, '-e'],
      writeFile: [],
      readFile: [],
      writeFileSizeLimit: 0,
      readFileSizeLimit: 0,
    };
    const tool = createBashTool(runtime, {
      startTask: () => { throw new Error('unexpected background task'); },
      sessionId: 'test',
      backgroundThresholdSec: 10,
    });

    const result = await tool.execute({
      command: "process.stdout.write('x'.repeat(4095) + '😀')",
      timeout_seconds: 1,
    });
    const payload = JSON.parse((result as { content: string }).content) as {
      output: string;
      truncated: boolean;
    };

    expect(payload.truncated).toBe(true);
    expect(payload.output.charCodeAt(payload.output.length - 1)).not.toBeGreaterThanOrEqual(0xD800);
  });
});

describe('executeToolCall', () => {
  const log = { withFields: () => log, withError: () => log, error: () => {}, log: () => {} } as any;

  const greetTool = createTool({
    name: 'greet',
    description: 'Test tool.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: async input => {
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
      description: 'Test tool.',
      parameters: greetTool.parameters,
      execute: async () => { throw new Error('boom'); },
    });
    const result = await executeToolCall('id1', 'greet', '{"name": "x"}', [throwingTool], log);
    const payload = JSON.parse(result.payload as string);
    expect(payload.error).toContain('boom');
    expect(result.requiresFollowUp).toBe(true);
  });
});
