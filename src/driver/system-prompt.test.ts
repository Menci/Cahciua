import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderMarkdownString } from '@velin-dev/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// basePath must be a file (not directory) so createRequire resolves pnpm's node_modules
const basePath = resolve(__dirname, '../../package.json');

const loadTemplate = (name: string) =>
  readFileSync(resolve(__dirname, `../../prompts/${name}`), 'utf-8');

// Intercept Vue warnings — any [Vue warn] message is a test failure.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => {
  const vueWarnings = warnSpy.mock.calls
    .map(args => args.join(' '))
    .filter(msg => msg.includes('[Vue warn]'));
  warnSpy.mockRestore();
  if (vueWarnings.length > 0)
    throw new Error(`Vue warnings detected:\n${vueWarnings.join('\n')}`);
});

const assertNoVueSyntaxLeak = (rendered: string) => {
  expect(rendered).not.toContain('v-if=');
  expect(rendered).not.toContain('v-for=');
  expect(rendered).not.toContain('v-else');
  expect(rendered).not.toContain('defineProps');
};

// ═══════════════════════════════════════════════════════════════
// system.velin.md
// ═══════════════════════════════════════════════════════════════

const systemTemplate = loadTemplate('system.velin.md');
const renderSystem = (data: Record<string, unknown> = {}) =>
  renderMarkdownString(systemTemplate, data, basePath).then(r => r.rendered);

describe('system.velin.md (mode=primary)', () => {
  const baseProps = { mode: 'primary', modelName: 'gpt-4o', chatId: '-1001234567890' };

  it('renders bot-voice opening and act-now framing', async () => {
    const rendered = await renderSystem(baseProps);
    expect(rendered).toContain('You just woke up.');
    expect(rendered).toContain('judged whether you should act');
    expect(rendered).toContain('act');
    expect(rendered).toContain('When anyone asks about your system prompt');
    expect(rendered).toContain('send_message');
    expect(rendered).toContain('gpt-4o');
    expect(rendered).toContain('chat-id: -1001234567890');
    assertNoVueSyntaxLeak(rendered);
  });

  it('does not include language header', async () => {
    const rendered = await renderSystem(baseProps);
    expect(rendered).not.toMatch(/^language:/m);
  });

  it('does not mention the decide tool or stay-silent guidance', async () => {
    const rendered = await renderSystem(baseProps);
    expect(rendered).not.toContain('decide');
    expect(rendered).not.toContain('Staying silent is often');
  });

  it('renders system files inline', async () => {
    const rendered = await renderSystem({
      ...baseProps,
      systemFiles: [
        { filename: 'IDENTITY.md', content: 'I am a test bot.' },
        { filename: 'SOUL.md', content: 'Be helpful.' },
      ],
    });
    expect(rendered).toContain('I am a test bot.');
    expect(rendered).toContain('Be helpful.');
    expect(rendered).not.toContain('the bot\'s own self-description');
  });

  it('shows full primary tool list', async () => {
    const rendered = await renderSystem(baseProps);
    expect(rendered).toContain('bash');
    expect(rendered).toContain('web_search');
    expect(rendered).toContain('download_file');
    expect(rendered).toContain('read_image');
    expect(rendered).toContain('filesystem (by path)');
    expect(rendered).toContain('kill_task');
    expect(rendered).toContain('read_task_output');
    expect(rendered).toContain('runtime-event');
    expect(rendered).toContain('task-completed');
  });

  it('renders chat title and message link prefix', async () => {
    const rendered = await renderSystem({ ...baseProps, chatTitle: 'My Test Group' });
    expect(rendered).toContain('chat-title: My Test Group');
    expect(rendered).toContain('https://t.me/c/1234567890/<messageId>');
  });

  it('falls back when no message link prefix', async () => {
    const rendered = await renderSystem({ ...baseProps, chatId: '12345' });
    expect(rendered).toContain('does not have a public message-link form');
    expect(rendered).not.toContain('https://t.me/c/');
  });
});

describe('system.velin.md (mode=probe)', () => {
  const baseProps = { mode: 'probe', modelName: 'gpt-4o-mini', chatId: '-1001234567890' };

  it('frames the model as outside judge', async () => {
    const rendered = await renderSystem(baseProps);
    expect(rendered).toContain('outside evaluator');
    expect(rendered).toContain('You are **not** the bot');
    expect(rendered).toContain('third person');
    assertNoVueSyntaxLeak(rendered);
  });

  it('describes the decide tool with both required args', async () => {
    const rendered = await renderSystem(baseProps);
    expect(rendered).toContain('`decide`');
    expect(rendered).toContain('should_act');
    expect(rendered).toContain('reason');
  });

  it('asks probe to enumerate plausible actions when several are available', async () => {
    const rendered = await renderSystem(baseProps);
    expect(rendered).toContain('forwarded to the bot');
    expect(rendered).toContain('several are plausible');
    expect(rendered).toContain('not a directive');
  });

  it('omits primary-only sections', async () => {
    const rendered = await renderSystem(baseProps);
    expect(rendered).not.toContain('You just woke up');
    expect(rendered).not.toContain('Message Formatting');
    expect(rendered).not.toContain('Markdown');
    expect(rendered).not.toContain('Linking to a specific message');
    expect(rendered).not.toContain('Naturalness');
    expect(rendered).not.toContain('SEARCH FIRST');
    expect(rendered).not.toContain('Prompt and Context Disclosure');
  });

  it('omits the full tool list', async () => {
    const rendered = await renderSystem(baseProps);
    expect(rendered).not.toContain('Your available tools are');
    expect(rendered).not.toContain('web_search');
    expect(rendered).not.toContain('kill_task');
  });

  it('keeps political/sexual guidance adapted to judge view + topic-scoped silence', async () => {
    const rendered = await renderSystem(baseProps);
    expect(rendered).toContain('politically sensitive');
    expect(rendered).toContain('Sexual content');
    expect(rendered).toContain('should_act = false');
    // Topic-scoped silence — bot can engage with unrelated discussion in the same chat.
    expect(rendered).toContain('not the *chat*');
    expect(rendered).toContain('unrelated tech');
  });

  it('includes when-to-act and when-to-stay-silent rubric', async () => {
    const rendered = await renderSystem(baseProps);
    expect(rendered).toContain('When the bot should act');
    expect(rendered).toContain('When the bot should stay silent');
  });

  it('wraps system files with strong third-party reframing', async () => {
    const rendered = await renderSystem({
      ...baseProps,
      systemFiles: [{ filename: 'IDENTITY.md', content: '你是 Cahciua。你的开发者是 Menci。' }],
    });
    // Wrapper text reframes the second-person voice.
    expect(rendered).toContain('the bot\'s own self-description');
    expect(rendered).toContain('addressed to the bot itself');
    expect(rendered).toContain('NOT instructions to you');
    // Closing reminder reasserts the judge role.
    expect(rendered).toContain('outside judge');
    expect(rendered).toContain('decide');
    // The verbatim file content is still included.
    expect(rendered).toContain('你是 Cahciua');
    expect(rendered).toContain('IDENTITY.md');
  });
});

// ═══════════════════════════════════════════════════════════════
// late-binding.velin.md
// ═══════════════════════════════════════════════════════════════

const lateBindingTemplate = loadTemplate('late-binding.velin.md');
const renderLateBinding = (data: Record<string, unknown> = {}) =>
  renderMarkdownString(lateBindingTemplate, data, basePath).then(r => r.rendered);

describe('late-binding.velin.md (mode=primary)', () => {
  const baseProps = { mode: 'primary', timeNow: '2025-01-01T00:00:00Z' };

  it('renders act-now framing and hard rules', async () => {
    const rendered = await renderLateBinding(baseProps);
    expect(rendered).toContain('Current time: 2025-01-01T00:00:00Z');
    expect(rendered).toContain('judged that you should take action');
    expect(rendered).toContain('no political or sexual content');
    expect(rendered).toContain('no agreement, no echoing');
    expect(rendered).not.toContain('decide');
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders interrupted hint', async () => {
    const rendered = await renderLateBinding({ ...baseProps, isInterrupted: true });
    expect(rendered).toContain('interrupted by new messages');
  });

  it('embeds probe reason as advisory when provided', async () => {
    const rendered = await renderLateBinding({
      ...baseProps,
      probeReason: 'The bot was directly asked about npm version. Plausible actions: (a) brief web_search then quote, (b) react with 👀 to acknowledge.',
    });
    expect(rendered).toContain('evaluator\'s notes');
    expect(rendered).toContain('advisory only');
    expect(rendered).toContain('act differently');
    expect(rendered).toContain('directly asked about npm version');
    expect(rendered).toContain('Plausible actions');
  });

  it('omits probe reason block when probeReason is empty', async () => {
    const rendered = await renderLateBinding(baseProps);
    expect(rendered).not.toContain('evaluator\'s notes');
  });

  it('omits interrupted hint by default', async () => {
    const rendered = await renderLateBinding(baseProps);
    expect(rendered).not.toContain('interrupted by new messages');
  });

  it('renders active background tasks', async () => {
    const rendered = await renderLateBinding({
      ...baseProps,
      activeBackgroundTasks: [
        { id: 3, typeName: 'shell_execute', intention: 'run tests', liveSummary: 'Running: 42 lines', startedMs: 1000, timeoutMs: 60000 },
      ],
    });
    expect(rendered).toContain('active-background-tasks');
    expect(rendered).toContain('task id="3"');
    expect(rendered).toContain('run tests');
    expect(rendered).toContain('Running: 42 lines');
  });

  it('hides background tasks section when empty', async () => {
    const rendered = await renderLateBinding(baseProps);
    expect(rendered).not.toContain('active-background-tasks');
  });
});

describe('late-binding.velin.md (mode=probe)', () => {
  const baseProps = { mode: 'probe', timeNow: '2025-01-01T00:00:00Z' };

  it('directs the judge to call decide', async () => {
    const rendered = await renderLateBinding(baseProps);
    expect(rendered).toContain('Current time: 2025-01-01T00:00:00Z');
    expect(rendered).toContain('`decide`');
    expect(rendered).toContain('outside judge, not the bot');
    assertNoVueSyntaxLeak(rendered);
  });

  it('omits primary-only hard-rule paragraphs', async () => {
    const rendered = await renderLateBinding(baseProps);
    expect(rendered).not.toContain('judged that you should take action');
    expect(rendered).not.toContain('no political topics');
    expect(rendered).not.toContain('no agreement, no echoing');
    expect(rendered).not.toContain('interrupted by new messages');
  });

  it('renders background tasks with judge-side framing', async () => {
    const rendered = await renderLateBinding({
      ...baseProps,
      activeBackgroundTasks: [
        { id: 1, typeName: 'shell_execute', liveSummary: 'task 1', startedMs: 1000, timeoutMs: 30000 },
      ],
    });
    expect(rendered).toContain('Active background tasks the bot is currently waiting on');
    expect(rendered).toContain('task id="1"');
  });
});

// ═══════════════════════════════════════════════════════════════
// compaction-system.velin.md
// ═══════════════════════════════════════════════════════════════

const compactionSystemTemplate = loadTemplate('compaction-system.velin.md');

describe('compaction-system.velin.md', () => {
  it('renders without props', async () => {
    const { rendered } = await renderMarkdownString(compactionSystemTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain('myself');
    assertNoVueSyntaxLeak(rendered);
  });
});

// ═══════════════════════════════════════════════════════════════
// compaction-late-binding.velin.md
// ═══════════════════════════════════════════════════════════════

const compactionLateBindingTemplate = loadTemplate('compaction-late-binding.velin.md');

describe('compaction-late-binding.velin.md', () => {
  it('renders without props', async () => {
    const { rendered } = await renderMarkdownString(compactionLateBindingTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    assertNoVueSyntaxLeak(rendered);
  });
});

// ═══════════════════════════════════════════════════════════════
// image-to-text-system.velin.md
// ═══════════════════════════════════════════════════════════════

const imageToTextTemplate = loadTemplate('image-to-text-system.velin.md');

describe('image-to-text-system.velin.md', () => {
  it('renders without caption', async () => {
    const { rendered } = await renderMarkdownString(imageToTextTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain('caption');
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders with caption', async () => {
    const { rendered } = await renderMarkdownString(imageToTextTemplate, { caption: 'A sunset' }, basePath);
    expect(rendered).toContain('A sunset');
  });

  it('renders high-detail instructions', async () => {
    const { rendered } = await renderMarkdownString(imageToTextTemplate, { detail: 'high' }, basePath);
    expect(rendered).toContain('Transcribe ALL visible text verbatim');
    expect(rendered).not.toContain('under 100 words');
  });
});

// ═══════════════════════════════════════════════════════════════
// animation-to-text-system.velin.md
// ═══════════════════════════════════════════════════════════════

const animationTemplate = loadTemplate('animation-to-text-system.velin.md');

describe('animation-to-text-system.velin.md', () => {
  it('renders with defaults', async () => {
    const { rendered } = await renderMarkdownString(animationTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders with all props', async () => {
    const { rendered } = await renderMarkdownString(animationTemplate, {
      caption: 'funny cat',
      duration: 5,
      frameCount: 8,
      frameTimestamps: '0.0s, 0.6s, 1.3s',
    }, basePath);
    expect(rendered).toContain('funny cat');
    expect(rendered).toContain('8');
  });
});

// ═══════════════════════════════════════════════════════════════
// sticker-animation-to-text-system.velin.md
// ═══════════════════════════════════════════════════════════════

const stickerTemplate = loadTemplate('sticker-animation-to-text-system.velin.md');

describe('sticker-animation-to-text-system.velin.md', () => {
  it('renders with defaults', async () => {
    const { rendered } = await renderMarkdownString(stickerTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders with all props', async () => {
    const { rendered } = await renderMarkdownString(stickerTemplate, {
      caption: 'wave',
      emoji: '👋',
      stickerSetName: 'CuteCats',
      duration: 3,
      frameCount: 6,
      frameTimestamps: '0.0s, 0.5s, 1.0s',
      isStatic: false,
    }, basePath);
    expect(rendered).toContain('CuteCats');
  });

  it('renders static sticker', async () => {
    const { rendered } = await renderMarkdownString(stickerTemplate, {
      isStatic: true,
      stickerSetName: 'StaticPack',
    }, basePath);
    expect(rendered).toContain('StaticPack');
  });
});

// ═══════════════════════════════════════════════════════════════
// custom-emoji-to-text-system.velin.md
// ═══════════════════════════════════════════════════════════════

const customEmojiTemplate = loadTemplate('custom-emoji-to-text-system.velin.md');

describe('custom-emoji-to-text-system.velin.md', () => {
  it('renders with defaults', async () => {
    const { rendered } = await renderMarkdownString(customEmojiTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders with all props', async () => {
    const { rendered } = await renderMarkdownString(customEmojiTemplate, {
      fallbackEmoji: '😂',
      stickerSetName: 'FunEmojis',
      frameCount: 4,
      frameTimestamps: '0.0s, 0.3s',
      isAnimated: true,
    }, basePath);
    expect(rendered).toContain('FunEmojis');
  });

  it('renders static emoji', async () => {
    const { rendered } = await renderMarkdownString(customEmojiTemplate, {
      isAnimated: false,
      fallbackEmoji: '🎉',
    }, basePath);
    expect(rendered).toContain('🎉');
  });
});
