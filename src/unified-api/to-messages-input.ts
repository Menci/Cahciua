import type {
  MessagesAssistantContentBlock,
  MessagesImageBlock,
  MessagesMessage,
  MessagesTextBlock,
  MessagesToolResultBlock,
  MessagesToolUseBlock,
  MessagesUserContentBlock,
} from './anthropic-types';
import { flattenResponsesSummary, messageReasoningText } from './reasoning';
import { applyExtra, assertSystemTextOnly, sharpToEncoded } from './shared';
import type {
  ConversationEntry,
  ImagePart,
  InputPart,
  MessageReasoning,
  OutputMessage,
  OutputPart,
  ReasoningPart,
  ToolResult,
} from './types';

/** Runtime request builder for Anthropic Messages. `system` is top-level. */
export const toMessagesInput = async (
  entries: ConversationEntry[],
): Promise<{ system: string | undefined; messages: MessagesMessage[] }> => {
  const systemParts: string[] = [];
  const messages: MessagesMessage[] = [];
  const idRemap = buildToolIdRemap(entries);

  for (const entry of entries) {
    if (entry.kind === 'toolResult') {
      appendToUser(messages, [await toolResultToBlock(entry, idRemap)]);
    } else if (entry.role === 'system') {
      assertSystemTextOnly(entry);
      for (const p of entry.parts) if (p.kind === 'text') systemParts.push(p.text);
    } else if (entry.role === 'user') {
      appendToUser(messages, await Promise.all(entry.parts.map(inputPartToUserBlock)));
    } else if (entry.role === 'assistant') {
      appendToAssistant(messages, await assistantMessageToBlocks(entry, idRemap));
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages,
  };
};

// Anthropic tool_use.id / tool_result.tool_use_id must match /^[a-zA-Z0-9_-]+$/.
// Other providers (OpenAI) allow richer formats like `send_message:103` that
// round-trip through our IR. Walk entries once, collect every tool_use id,
// replace disallowed chars with '_', and dedupe collisions with a numeric
// suffix. Both sides (call + result) share the same remap so pairing holds.
const buildToolIdRemap = (entries: ConversationEntry[]): Map<string, string> => {
  const remap = new Map<string, string>();
  const used = new Set<string>();
  const assign = (id: string): void => {
    if (remap.has(id)) return;
    const base = id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'id';
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) candidate = `${base}_${n++}`;
    remap.set(id, candidate);
    used.add(candidate);
  };
  for (const entry of entries) {
    if (entry.kind === 'toolResult') assign(entry.callId);
    else if (entry.role === 'assistant') {
      for (const p of entry.parts) if (p.kind === 'toolCall') assign(p.callId);
    }
  }
  return remap;
};

const remapId = (remap: Map<string, string>, id: string): string => remap.get(id) ?? id;

const assistantMessageToBlocks = async (msg: OutputMessage, idRemap: Map<string, string>): Promise<MessagesAssistantContentBlock[]> => {
  const blocks = msg.parts.flatMap(p => partToAssistantBlocks(p, idRemap));

  if (msg.reasoning !== undefined && !msg.parts.some(p => p.kind === 'reasoning')) {
    const thinkingBlock = messageReasoningToThinkingBlock(msg.reasoning);
    if (thinkingBlock !== undefined) blocks.unshift(thinkingBlock);
  }

  // Anthropic requires at least one content block.
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });

  return blocks;
};

const parseToolArgs = (raw: string): Record<string, unknown> => {
  // Anthropic `input` must be an object; IR carries raw wire strings.
  // On invalid JSON or non-object shape we fall back to `{}` — not ideal,
  // but Anthropic's schema leaves no room to pass the raw string through.
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* fall through */ }
  return {};
};

const partToAssistantBlocks = (part: OutputPart, idRemap: Map<string, string>): MessagesAssistantContentBlock[] => {
  if (part.kind === 'text') {
    const block: MessagesTextBlock = applyExtra(part.extra, 'anthropicMessages', {
      higher: { type: 'text' as const, text: part.text },
    });
    return [block];
  }
  if (part.kind === 'textGroup') {
    return part.content.map((tp): MessagesTextBlock =>
      applyExtra(tp.extra, 'anthropicMessages', {
        higher: { type: 'text' as const, text: tp.text },
      }));
  }
  if (part.kind === 'toolCall') {
    const block: MessagesToolUseBlock = applyExtra(part.extra, 'anthropicMessages', {
      higher: {
        type: 'tool_use' as const,
        id: remapId(idRemap, part.callId),
        name: part.name,
        input: parseToolArgs(part.args),
      },
    });
    return [block];
  }
  if (part.kind === 'reasoning') {
    const block = reasoningToBlock(part);
    return block !== undefined ? [block] : [];
  }
  throw new Error(`Unknown OutputPart kind: ${(part as { kind: string }).kind}`);
};

const reasoningToBlock = (part: ReasoningPart): MessagesAssistantContentBlock | undefined => {
  const data = part.data;
  const build = <T extends MessagesAssistantContentBlock>(higher: T): MessagesAssistantContentBlock =>
    applyExtra(part.extra, 'anthropicMessages', { higher });
  if (data.source === 'openaiResponses') {
    const { summary, encrypted_content } = data.data;
    const text = flattenResponsesSummary(summary);
    // Empty reasoning → drop (no wire concept in Anthropic). Match
    // to-chat-input.ts so cross-format conversion is symmetric.
    if (text.length === 0 && encrypted_content === undefined) return undefined;
    // Normalize: empty text + opaque signature → redacted_thinking (Responses
    // rows with only encrypted_content round-trip as redacted elsewhere).
    if (text.length === 0 && encrypted_content !== undefined) {
      return build({ type: 'redacted_thinking', data: encrypted_content });
    }
    return build({ type: 'thinking', thinking: text, signature: encrypted_content });
  }
  if (data.data.type === 'thinking') {
    return build({ type: 'thinking', thinking: data.data.thinking, signature: data.data.signature });
  }
  return build({ type: 'redacted_thinking', data: data.data.data });
};

const messageReasoningToThinkingBlock = (r: MessageReasoning): MessagesAssistantContentBlock | undefined => {
  const text = messageReasoningText(r);
  const opaque = typeof r.reasoning_opaque === 'string' ? r.reasoning_opaque : undefined;
  if (text !== undefined) return { type: 'thinking', thinking: text, signature: opaque };
  if (opaque !== undefined) return { type: 'redacted_thinking', data: opaque };
  return undefined;
};

const inputPartToUserBlock = async (part: InputPart): Promise<MessagesUserContentBlock> =>
  part.kind === 'text' ? { type: 'text', text: part.text } : await imagePartToBlock(part);

const toolResultToBlock = async (tr: ToolResult, idRemap: Map<string, string>): Promise<MessagesToolResultBlock> => {
  const block: MessagesToolResultBlock = { type: 'tool_result', tool_use_id: remapId(idRemap, tr.callId) };
  if (typeof tr.payload === 'string') {
    block.content = tr.payload;
  } else if (tr.payload.length > 0) {
    block.content = await Promise.all(tr.payload.map(async (part): Promise<MessagesTextBlock | MessagesImageBlock> =>
      part.kind === 'text' ? { type: 'text', text: part.text } : await imagePartToBlock(part)));
  }
  return block;
};

const imagePartToBlock = async (part: ImagePart): Promise<MessagesImageBlock> => {
  const { buf, format } = await sharpToEncoded(part);
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: `image/${format}`,
      data: buf.toString('base64'),
    },
  };
};

const appendToUser = (messages: MessagesMessage[], blocks: MessagesUserContentBlock[]): void => {
  if (blocks.length === 0) return;
  const last = messages[messages.length - 1];
  if (last?.role === 'user') {
    last.content = [...normalizeExisting(last.content), ...blocks];
  } else {
    messages.push({ role: 'user', content: blocks });
  }
};

const appendToAssistant = (messages: MessagesMessage[], blocks: MessagesAssistantContentBlock[]): void => {
  if (blocks.length === 0) return;
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    last.content = [...normalizeExisting(last.content), ...blocks];
  } else {
    messages.push({ role: 'assistant', content: blocks });
  }
};

const normalizeExisting = <T extends MessagesUserContentBlock | MessagesAssistantContentBlock>(
  content: string | T[],
): T[] => Array.isArray(content) ? content : [{ type: 'text', text: content } as T];
