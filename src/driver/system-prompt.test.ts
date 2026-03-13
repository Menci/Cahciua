import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderMarkdownString } from '@velin-dev/core';
import { describe, expect, it } from 'vitest';

const template = readFileSync(resolve(__dirname, '../../docs/system-prompt.md'), 'utf-8');
// basePath must be a file (not directory) so createRequire resolves pnpm's node_modules
const basePath = resolve(__dirname, '../../package.json');

const renderPrompt = (data: Record<string, unknown> = {}) =>
  renderMarkdownString(template, data, basePath).then(r => r.rendered);

describe('system prompt (velin)', () => {
  it('renders with minimal props', async () => {
    const rendered = await renderPrompt({ timeNow: '2025-03-13T12:00:00Z' });

    // Static content present
    expect(rendered).toContain('You just woke up.');
    expect(rendered).toContain('send_message');
    expect(rendered).toContain('Chat Context Format');
    expect(rendered).toContain('IDENTITY.md');

    // Defaults applied
    expect(rendered).toContain('/data');
    expect(rendered).toContain('telegram');
    expect(rendered).toContain('1440');

    // Dynamic time rendered
    expect(rendered).toContain('2025-03-13T12:00:00Z');

    // No raw Vue syntax leaked
    expect(rendered).not.toContain('v-if=');
    expect(rendered).not.toContain('v-for=');
    expect(rendered).not.toContain('defineProps');
  });

  it('renders language header', async () => {
    const rendered = await renderPrompt({ language: 'zh', timeNow: '2025-01-01T00:00:00Z' });
    expect(rendered).toContain('language: zh');
  });

  it('conditionally includes read_media', async () => {
    const withMedia = await renderPrompt({ supportsImageInput: true, timeNow: '2025-01-01T00:00:00Z' });
    expect(withMedia).toContain('read_media');

    const withoutMedia = await renderPrompt({ supportsImageInput: false, timeNow: '2025-01-01T00:00:00Z' });
    expect(withoutMedia).not.toContain('read_media');
  });

  it('renders system files', async () => {
    const rendered = await renderPrompt({
      timeNow: '2025-01-01T00:00:00Z',
      systemFiles: [
        { filename: 'IDENTITY.md', content: 'I am a test bot.' },
        { filename: 'SOUL.md', content: 'Be helpful.' },
      ],
    });

    expect(rendered).toContain('I am a test bot.');
    expect(rendered).toContain('Be helpful.');
  });

  it('renders skills list', async () => {
    const rendered = await renderPrompt({
      timeNow: '2025-01-01T00:00:00Z',
      skills: [
        { name: 'search', description: 'Search the web' },
        { name: 'calculator', description: 'Do math' },
      ],
    });

    expect(rendered).toContain('2 skills available');
    expect(rendered).toContain('search');
    expect(rendered).toContain('calculator');
  });

  it('renders enabled skill content', async () => {
    const rendered = await renderPrompt({
      timeNow: '2025-01-01T00:00:00Z',
      skills: [],
      enabledSkills: [
        { name: 'web_search', description: 'Search the web', content: 'Use this tool to search.' },
      ],
    });

    expect(rendered).toContain('Use this tool to search.');
  });

  it('renders inbox when present', async () => {
    const rendered = await renderPrompt({
      timeNow: '2025-01-01T00:00:00Z',
      inbox: [
        { id: '1', source: 'discord', header: 'New msg', content: 'Hello from Discord', createdAt: '2025-01-01T00:00:00Z' },
      ],
    });

    expect(rendered).toContain('Inbox (1 unread)');
    expect(rendered).toContain('Hello from Discord');
  });

  it('omits inbox section when empty', async () => {
    const rendered = await renderPrompt({ timeNow: '2025-01-01T00:00:00Z', inbox: [] });
    expect(rendered).not.toContain('Inbox (0 unread)');
  });

  it('renders dynamic context footer', async () => {
    const rendered = await renderPrompt({
      channels: ['telegram', 'discord'],
      currentChannel: 'discord',
      maxContextLoadTime: 720,
      timeNow: '2025-06-15T08:30:00Z',
    });

    expect(rendered).toContain('telegram,discord');
    expect(rendered).toContain('discord');
    expect(rendered).toContain('720');
    expect(rendered).toContain('12.00');
    expect(rendered).toContain('2025-06-15T08:30:00Z');
  });

  it('contains send_message instructions, not direct-reply', async () => {
    const rendered = await renderPrompt({ timeNow: '2025-01-01T00:00:00Z' });

    expect(rendered).toContain('send_message');
    expect(rendered).toContain('internal reasoning only');
    expect(rendered).toContain('Choosing when to respond');
    expect(rendered).toContain('Stay silent when');
    expect(rendered).not.toContain('Your text output IS your reply');
  });
});
