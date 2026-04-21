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
// primary-system.velin.md
// ═══════════════════════════════════════════════════════════════

const systemTemplate = loadTemplate('primary-system.velin.md');
const renderSystem = (data: Record<string, unknown> = {}) =>
  renderMarkdownString(systemTemplate, data, basePath).then(r => r.rendered);

describe('primary-system.velin.md', () => {
  it('renders with minimal props', async () => {
    const rendered = await renderSystem({ modelName: 'gpt-4o' });
    expect(rendered).toContain('You just woke up.');
    expect(rendered).toContain('send_message');
    expect(rendered).toContain('gpt-4o');
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders language header', async () => {
    const rendered = await renderSystem({ language: 'zh', modelName: 'gpt-4o' });
    expect(rendered).toContain('language: zh');
  });

  it('renders system files', async () => {
    const rendered = await renderSystem({
      modelName: 'gpt-4o',
      systemFiles: [
        { filename: 'IDENTITY.md', content: 'I am a test bot.' },
        { filename: 'SOUL.md', content: 'Be helpful.' },
      ],
    });
    expect(rendered).toContain('I am a test bot.');
    expect(rendered).toContain('Be helpful.');
  });

  it('shows all tools', async () => {
    const rendered = await renderSystem({ modelName: 'gpt-4o' });
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
});

// ═══════════════════════════════════════════════════════════════
// primary-late-binding.velin.md
// ═══════════════════════════════════════════════════════════════

const lateBindingTemplate = loadTemplate('primary-late-binding.velin.md');
const renderLateBinding = (data: Record<string, unknown> = {}) =>
  renderMarkdownString(lateBindingTemplate, data, basePath).then(r => r.rendered);

describe('primary-late-binding.velin.md', () => {
  it('renders static content', async () => {
    const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z' });
    expect(rendered).toContain('Current time: 2025-01-01T00:00:00Z');
    expect(rendered).toContain('send_message');
    expect(rendered).not.toContain('decided to act');
    expect(rendered).not.toContain('<human-likeness');
    expect(rendered).not.toContain('interrupted');
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders activated state', async () => {
    const rendered = await renderLateBinding({
      timeNow: '2025-01-01T00:00:00Z',
      isProbeEnabled: true, isProbing: false,
    });
    expect(rendered).toContain('decided to act');
  });

  it('renders mentioned state', async () => {
    const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z', isMentioned: true });
    expect(rendered).toContain('mentioned');
    expect(rendered).not.toContain('decided to act');
  });

  it('renders replied state', async () => {
    const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z', isReplied: true });
    expect(rendered).toContain('replied');
  });

  it('renders interrupted state', async () => {
    const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z', isInterrupted: true });
    expect(rendered).toContain('interrupted by new messages');
    expect(rendered).toContain('continue');
  });

  it('renders send_message human-likeness feedback', async () => {
    const rendered = await renderLateBinding({
      timeNow: '2025-01-01T00:00:00Z',
      recentSendMessageHumanLikenessXml: '<human-likeness checked-count="2" window-size="5">\n<feature name="newline" count="1">Used a newline. Appeared in 1 of your recent 2 send_message messages.</feature>\n<guidance>If those patterns were intentional, do not follow this rigidly. If you agree with the critique, try to sound a bit more human in your next messages.</guidance>\n</human-likeness>',
    });
    expect(rendered).toContain('<human-likeness');
    expect(rendered).toContain('<guidance>If those patterns were intentional');
  });

  it('interrupted does not suppress other states', async () => {
    const rendered = await renderLateBinding({
      timeNow: '2025-01-01T00:00:00Z',
      isInterrupted: true,
      isMentioned: true,
    });
    expect(rendered).toContain('interrupted by new messages');
    expect(rendered).toContain('mentioned');
  });

  it('renders active background tasks', async () => {
    const rendered = await renderLateBinding({
      timeNow: '2025-01-01T00:00:00Z',
      activeBackgroundTasks: [
        { id: 3, typeName: 'shell_execute', intention: 'run tests', liveSummary: 'Running: 42 lines', startedMs: 1000, timeoutMs: 60000 },
      ],
    });
    expect(rendered).toContain('active-background-tasks');
    expect(rendered).toContain('task id="3"');
    expect(rendered).toContain('shell');
    expect(rendered).toContain('run tests');
    expect(rendered).toContain('Running: 42 lines');
    expect(rendered).toContain('</task>');
    expect(rendered).toContain('</active-background-tasks>');
  });

  it('renders multiple background tasks', async () => {
    const rendered = await renderLateBinding({
      timeNow: '2025-01-01T00:00:00Z',
      activeBackgroundTasks: [
        { id: 1, typeName: 'shell_execute', liveSummary: 'task 1', startedMs: 1000, timeoutMs: 30000 },
        { id: 2, typeName: 'shell_execute', liveSummary: 'task 2', startedMs: 2000, timeoutMs: 60000 },
      ],
    });
    expect(rendered).toContain('task id="1"');
    expect(rendered).toContain('task id="2"');
  });

  it('hides background tasks section when empty', async () => {
    const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z' });
    expect(rendered).not.toContain('active-background-tasks');
  });

  it('renders task without intention', async () => {
    const rendered = await renderLateBinding({
      timeNow: '2025-01-01T00:00:00Z',
      activeBackgroundTasks: [
        { id: 5, typeName: 'shell_execute', liveSummary: 'Running', startedMs: 1000, timeoutMs: 30000 },
      ],
    });
    expect(rendered).toContain('task id="5"');
    expect(rendered).not.toContain('<intention>');
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
