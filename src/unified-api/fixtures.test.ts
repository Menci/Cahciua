// Round-trip test using extracted fixtures. Fixtures contain wire data from
// the legacy turn_responses table (with tool-result rows); we load via
// migrations, then emit via runtime input builders.

import { describe, expect, it } from 'vitest';

import { chatFixtures, responsesFixtures } from './fixtures';
import { migrateChatEntries, migrateResponsesEntries } from './migrations';
import { toChatCompletionsInput } from './to-chat-input';
import { toResponsesInput } from './to-responses-input';

/**
 * Structural normalization for wire-vs-wire comparison. `requiresFollowUp` is
 * app-state, not a wire field — strip it. `arguments` / JSON `content` strings
 * are parsed so formatting (whitespace, key order) differences don't fail
 * equality. `content: null` from legacy rows maps to omitted in the emitted
 * form — this is intentional canonical form: we treat missing content and
 * null content identically, so round-trip drops explicit `null` wrappers.
 */
const normalize = (val: unknown): unknown => {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    const replaced = val.replace(/^(data:[^;]+;base64,).+$/, '$1<IMAGE_DATA>');
    if (replaced !== val) return replaced;
    try {
      const parsed: unknown = JSON.parse(val);
      if (typeof parsed === 'object' && parsed !== null) {
        return { __jsonString: normalize(parsed) };
      }
    } catch { /* not JSON */ }
    return val;
  }
  if (Array.isArray(val)) return val.map(normalize);
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    // Normalize content part types: input_text→text, input_image→image_url
    if (obj.type === 'input_text' || obj.type === 'output_text') {
      return normalize({ type: 'text', text: obj.text });
    }
    if (obj.type === 'input_image') {
      return normalize({
        type: 'image_url',
        image_url: { url: obj.image_url, detail: obj.detail ?? 'auto' },
      });
    }

    for (const key of Object.keys(obj).sort()) {
      if (key === 'content' && obj[key] === null) continue;
      if (key === 'requiresFollowUp') continue;
      if (key === 'status' && obj[key] === 'completed') continue;
      result[key] = normalize(obj[key]);
    }
    return result;
  }
  return val;
};

/**
 * Reverse the tool-result → user-message image hoist that toChatCompletionsInput
 * applies for Chat Completions wire compliance. Fixtures are legacy rows that
 * stored images inline in `role:'tool'` — after round-trip they come back as a
 * contiguous run of (tool w/ text-only content) messages followed by (user w/
 * "(Images from tool result <id>:)" prefix) messages, one per call. Collapse
 * each hoist user back into its matching tool by `tool_call_id` so structural
 * equality with the original fixture holds.
 */
const unhoistToolImages = (entries: unknown[]): unknown[] => {
  const out: unknown[] = [];
  let i = 0;
  while (i < entries.length) {
    const cur = entries[i] as Record<string, unknown> | null;
    if (cur?.role !== 'tool') {
      out.push(cur);
      i++;
      continue;
    }

    // Collect contiguous tool messages, then contiguous hoist-user messages.
    const toolStart = i;
    while (i < entries.length && (entries[i] as Record<string, unknown> | null)?.role === 'tool') i++;
    const toolEnd = i;
    const hoistByCallId = new Map<string, unknown[]>();
    while (i < entries.length) {
      const n = entries[i] as Record<string, unknown> | null;
      const c = Array.isArray(n?.content) ? n!.content as unknown[] : null;
      if (n?.role !== 'user' || c === null || c.length < 1) break;
      const head = (c[0] as { text?: unknown }).text;
      if (typeof head !== 'string' || !head.startsWith('(Images from tool result ')) break;
      const m = head.match(/^\(Images from tool result (.+):\)$/);
      if (!m) break;
      hoistByCallId.set(m[1]!, c.slice(1));
      i++;
    }

    for (let j = toolStart; j < toolEnd; j++) {
      const tool = entries[j] as Record<string, unknown>;
      const callId = tool.tool_call_id as string | undefined;
      const imageParts = (callId !== undefined && hoistByCallId.get(callId)) || [];
      if (imageParts.length === 0) {
        out.push(tool);
        continue;
      }
      const placeholder = callId !== undefined
        ? `[Refer to the image below for tool result ${callId}]`
        : undefined;
      const isPlaceholder = (s: string): boolean => placeholder !== undefined && s === placeholder;
      const toolContent = tool.content;
      const merged = typeof toolContent === 'string'
        ? (toolContent === '' || isPlaceholder(toolContent)
            ? imageParts
            : [{ type: 'text', text: toolContent }, ...imageParts])
        : Array.isArray(toolContent) ? [...toolContent, ...imageParts] : imageParts;
      out.push({ ...tool, content: merged });
    }
  }
  return out;
};

describe('fixture round-trip: Chat Completions', () => {
  for (const fixture of chatFixtures) {
    it(`[TR #${fixture.id}] ${fixture.signature}`, async () => {
      const unified = migrateChatEntries(fixture.data);
      const roundTripped = await toChatCompletionsInput(unified);
      expect(normalize(unhoistToolImages(roundTripped))).toEqual(normalize(fixture.data));
    });
  }
});

describe('fixture round-trip: Responses API', () => {
  for (const fixture of responsesFixtures) {
    it(`[TR #${fixture.id}] ${fixture.signature}`, async () => {
      const unified = migrateResponsesEntries(fixture.data);
      const roundTripped = await toResponsesInput(unified);
      expect(normalize(roundTripped)).toEqual(normalize(fixture.data));
    });
  }
});
