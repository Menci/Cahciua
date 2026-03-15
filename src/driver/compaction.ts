import { writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';

import { composeContext } from './context';
import { streamingChat } from './streaming';
import type { CompactionSessionMeta, FeatureFlags, TurnResponse } from './types';
import type { RenderedContext } from '../rendering/types';

export interface CompactionParams {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  chatId: string;
  rcWindow: RenderedContext;
  trsWindow: TurnResponse[];
  existingSummary?: string;
  oldCursorMs: number;
  newCursorMs: number;
  reasoningSignatureCompat?: string;
  featureFlags?: FeatureFlags;
  log: Logger;
}

// System prompt: role identity + guidelines only. Output format lives in the
// user message so it's close to the generation point and won't be ignored.
const COMPACT_SYSTEM_PROMPT = `You are a conversation context compressor. You will receive a group chat conversation (formatted as XML messages) and must produce a structured plain-text summary.

Identity: the conversation contains messages from a bot marked with myself="true". You ARE this bot — summarize your own messages and actions with particular care.

Rules:
- Output ONLY plain text. No XML tags, no JSON, no code fences, no markdown bold/italic. Just plain structured text.
- LANGUAGE: You MUST write the entire summary in the dominant language of the conversation. If the chat is primarily in Chinese, write in Chinese. If in English, write in English. Match the language the participants actually use.
- Be thorough — detail and specifics are more valuable than brevity
- QUOTING: Quote participants' original words verbatim whenever possible. Only paraphrase when the original text is too long (>50 chars) or contains formatting that doesn't fit plain text. Prefer quoting over paraphrasing.
- REFERENCES: Each message has an id attribute (e.g. <message id="12345">). You MUST add (ref: msg#ID) wherever you mention, quote, or describe content from the conversation — in summaries, key points, tool call activity, everywhere. Not just in key points. Every claim should be traceable.
- INCREMENTAL COMPACTION: If a previous summary is provided, you MUST merge it with the new messages into a single unified summary. Carry forward topics from the previous summary — add timestamps to each topic so readers can judge recency. You may condense old topics (shrink their detail). If the total number of topics exceeds 10, drop the oldest ones to keep only the 10 most recent.`;

const COMPACT_USER_INSTRUCTION = `Summarize the conversation above. Write in the SAME LANGUAGE the participants used (e.g. Chinese conversation → Chinese summary). Use EXACTLY this plain text structure — no XML, no JSON, no code fences:

## Topics

For each distinct topic, write a section (newest first). If a previous summary was provided, carry forward its topics — merge overlapping ones, condense stale ones. If the total exceeds 10 topics, drop the oldest to keep only 10. Short or miscellaneous exchanges that don't form a full topic may be grouped into a "Miscellaneous" section — each item must still include a timestamp (YYYY-MM-DD HH:MM) and be dropped when stale.

### [One-sentence title: who did what] (YYYY-MM-DD HH:MM)

Keywords: word1, word2, word3
Participants: @username (display name), ...

Summary:
[100-300 words for recent topics, 50-100 words for older ones. Narrate faithfully — who said what, how it developed, what was decided or left open. Quote original words verbatim (unless too long or inconvenient to quote). Include what the bot said and how users reacted. Capture specific names, terms, numbers, URLs. Add (ref: msg#ID) after EVERY statement or quote that references a specific message.]

Key points:
- [Specific fact, with verbatim quote if short enough] (ref: msg#ID)
- [Specific fact] (ref: msg#ID, msg#ID)

## Tool Call Activity

[For each tool call: what tool, what intent, what result, what follow-up. Include (ref: msg#ID). Write "None." if no tool calls occurred.]

## Unresolved Threads

- [Open question or pending action] (ref: msg#ID)

## Bot Self-Summary

[What the bot said/did (quote verbatim), how users reacted — corrections, praise, complaints. Note patterns in how users interact with the bot. Add (ref: msg#ID) for each.]

Remember: plain text only, no XML tags, no code fences. Write in the conversation's language. Quote original words. Add (ref: msg#ID) everywhere. Be detailed — this summary replaces the original messages. If a previous summary was provided, merge its content into your output (do not discard it). Keep at most 10 topics — drop the oldest if needed.`;

// Token budget for compaction context — generous since we're summarizing, not chatting.
const COMPACT_MAX_TOKENS = 200000;
const MAX_RETRIES = 3;

export const runCompaction = async (params: CompactionParams): Promise<CompactionSessionMeta> => {
  // Reuse composeContext for full sanitization (reasoning stripping, self-sent
  // filtering, tool result trimming) — same pipeline as normal LLM calls.
  const ctx = composeContext(
    params.rcWindow,
    params.trsWindow,
    COMPACT_MAX_TOKENS,
    params.reasoningSignatureCompat,
    params.featureFlags,
    params.existingSummary,
  );

  const messages = ctx?.messages ?? [];

  messages.push({
    role: 'user',
    content: COMPACT_USER_INSTRUCTION,
  } as any);

  const DUMP_DIR = '/tmp/cahciua';

  writeFileSync(`${DUMP_DIR}/${params.chatId}.compact-request.json`, JSON.stringify({
    model: params.model,
    system: COMPACT_SYSTEM_PROMPT,
    messages,
  }, null, 2));

  // Retry loop — extended thinking models may produce thinking-only responses
  // (content: null) when no tools are provided. Retry on empty content.
  let summary = '';
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await streamingChat({
      baseURL: params.apiBaseUrl,
      apiKey: params.apiKey,
      model: params.model,
      messages,
      system: COMPACT_SYSTEM_PROMPT,
      log: params.log,
      label: `compact:${params.chatId}`,
    });

    writeFileSync(`${DUMP_DIR}/${params.chatId}.compact-response.json`, JSON.stringify(result, null, 2));

    summary = result.choices[0]?.message?.content ?? '';
    if (summary) break;

    params.log.withFields({ chatId: params.chatId, attempt, maxRetries: MAX_RETRIES })
      .warn('Compaction LLM returned empty content, retrying');
  }

  return {
    oldCursorMs: params.oldCursorMs,
    newCursorMs: params.newCursorMs,
    summary,
  };
};
