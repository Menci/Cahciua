import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderMarkdownString } from '@velin-dev/core';
import { describe, expect, it } from 'vitest';

const template = readFileSync(resolve(__dirname, '../../docs/system-prompt.velin.md'), 'utf-8');
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
    expect(rendered).toContain('only available tool');

    // Defaults applied
    expect(rendered).toContain('telegram');
    expect(rendered).toContain('1440');

    // Dynamic time rendered
    expect(rendered).toContain('2025-03-13T12:00:00Z');

    // No raw Vue syntax leaked
    expect(rendered).not.toContain('v-if=');
    expect(rendered).not.toContain('v-for=');
    expect(rendered).not.toContain('defineProps');

    // Removed features should not appear
    expect(rendered).not.toContain('Inbox');
    expect(rendered).not.toContain('Heartbeat');
    expect(rendered).not.toContain('Schedule');
    expect(rendered).not.toContain('Subagent');
    expect(rendered).not.toContain('use_skill');
    expect(rendered).not.toContain('search_memory');
    expect(rendered).not.toContain('get_contacts');
    expect(rendered).not.toContain('read_media');
    expect(rendered).not.toContain('`read`');
    expect(rendered).not.toContain('`write`');
    expect(rendered).not.toContain('`exec`');
  });

  it('renders language header', async () => {
    const rendered = await renderPrompt({ language: 'zh', timeNow: '2025-01-01T00:00:00Z' });
    expect(rendered).toContain('language: zh');
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

  it('renders dynamic context footer', async () => {
    const rendered = await renderPrompt({
      currentChannel: 'discord',
      maxContextLoadTime: 720,
      timeNow: '2025-06-15T08:30:00Z',
    });

    expect(rendered).toContain('discord');
    expect(rendered).toContain('720');
    expect(rendered).toContain('12.00');
    expect(rendered).toContain('2025-06-15T08:30:00Z');
  });

  it('contains send_message instructions, not direct-reply', async () => {
    const rendered = await renderPrompt({ timeNow: '2025-01-01T00:00:00Z' });

    expect(rendered).toContain('send_message');
    expect(rendered).toContain('internal thinking');
    expect(rendered).toContain('Choosing when to respond');
    expect(rendered).toContain('Stay silent when');
    expect(rendered).not.toContain('Your text output IS your reply');
  });
});
