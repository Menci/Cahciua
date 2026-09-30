import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderMarkdownString } from '@velin-dev/core-vue';
import { describe, expect, it } from 'vitest';

// The system prompt is meant to change dynamically. These tests therefore only
// cover two things and deliberately avoid asserting on any specific wording:
//   1. every template compiles (in both `primary` and `probe` where applicable);
//   2. custom XML prompt tags survive Markdown conversion (regression #62).
//
// Regression reference: https://github.com/moeru-ai/velin/pull/62

// basePath must be a file (not directory) so createRequire resolves pnpm's node_modules
const basePath = resolve(__dirname, '../../package.json');

const renderTemplate = async (name: string, data: Record<string, unknown> = {}) => {
  const template = readFileSync(resolve(__dirname, `../../prompts/${name}`), 'utf-8');
  const { rendered } = await renderMarkdownString(template, data, basePath);
  return rendered;
};

// A template compiles successfully when it renders non-empty text and leaves no
// Vue template syntax behind in the output.
const expectCompiled = (rendered: string) => {
  expect(rendered.trim().length).toBeGreaterThan(0);
  expect(rendered).not.toContain('v-if=');
  expect(rendered).not.toContain('v-for=');
  expect(rendered).not.toContain('v-else');
  expect(rendered).not.toContain('defineProps');
};

const MODES = ['primary', 'probe'] as const;
const SYSTEM_PROPS = { modelName: 'test-model', chatId: '-1001234567890' };

// Templates compile in both modes
describe.each(MODES)('system.velin.md (mode=%s)', mode => {
  it('compiles', async () => {
    expectCompiled(await renderTemplate('system.velin.md', { mode, ...SYSTEM_PROPS }));
  });
});

describe.each(MODES)('late-binding.velin.md (mode=%s)', mode => {
  it('compiles', async () => {
    expectCompiled(await renderTemplate('late-binding.velin.md', { mode, timeNow: '2026-09-30T00:00:00Z' }));
  });
});

// Remaining prompt templates compile
describe.each([
  'compaction-system.velin.md',
  'compaction-late-binding.velin.md',
  'image-to-text-system.velin.md',
  'animation-to-text-system.velin.md',
  'sticker-animation-to-text-system.velin.md',
  'custom-emoji-to-text-system.velin.md',
])('%s', name => {
  it('compiles', async () => {
    expectCompiled(await renderTemplate(name));
  });
});

// Custom XML prompt tags survive Markdown conversion
// Custom XML-style prompt tags used to be silently dropped during the
// HTML-to-Markdown conversion, losing their attributes and structure.
describe('custom XML prompt tags are preserved (regression #62)', () => {
  // Tags used directly in the primary template body.
  const PRIMARY_MARKERS = [
    '<example>', '</example>',
    '<suppose>', '</suppose>',
    '<bad-example>', '</bad-example>',
    '<good-example>', '</good-example>',
    '<explanation>', '</explanation>',
  ];

  // XML examples shared by both modes (the "Chatlog format" fences).
  const SHARED_MARKERS = [
    '<message id=', '</message>',
    '<in-reply-to ', '</in-reply-to>',
    '<event ',
    '<custom-emoji ', '</custom-emoji>',
    '<sticker ', '</sticker>',
    '<image ', '</image>',
    '<attachment ',
    '<runtime-event ', '</runtime-event>',
  ];

  const expectMarkers = (rendered: string, markers: string[]) => {
    for (const marker of markers)
      expect(rendered, `missing custom tag marker: ${marker}`).toContain(marker);
  };

  it('keeps tags in the primary system prompt', async () => {
    const rendered = await renderTemplate('system.velin.md', { mode: 'primary', ...SYSTEM_PROPS });
    expectMarkers(rendered, [...PRIMARY_MARKERS, ...SHARED_MARKERS]);
  });

  it('keeps shared tags in the probe system prompt', async () => {
    const rendered = await renderTemplate('system.velin.md', { mode: 'probe', ...SYSTEM_PROPS });
    expectMarkers(rendered, SHARED_MARKERS);
  });
});
