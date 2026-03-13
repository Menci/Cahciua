import type { Message, UserMessage } from 'xsai';

import type { TurnResponse } from './types';
import type { RenderedContext, RenderedContentPiece } from '../rendering/types';

const contentPieceToMessagePart = (piece: RenderedContentPiece) =>
  piece.type === 'text'
    ? { type: 'text' as const, text: piece.text }
    : { type: 'image_url' as const, image_url: { url: piece.url } };

// Split TR data into leading tool results and the rest (assistant messages).
// Tool results anchor to the *previous* TR's position (tool_call → tool_result adjacency).
const splitLeadingTools = (data: unknown[]): [unknown[], unknown[]] => {
  let i = 0;
  while (i < data.length && (data[i] as { role?: string }).role === 'tool')
    i++;
  return [data.slice(0, i), data.slice(i)];
};

// Merge RC segments and TRs into an xsai Message[] array.
//
// Per DCP design doc §Tool Call Loop Interleaving:
// - Tool results in TR_n are anchored immediately after TR_{n-1} (preserves
//   tool_call → tool_result adjacency required by all LLM APIs)
// - RC segments between TRs become interleaved user messages
// - Tiebreaker: RC before TR on equal timestamp (Anthropic role alternation)
export const mergeContext = (rc: RenderedContext, trs: TurnResponse[]): Message[] => {
  const messages: Message[] = [];
  let rcIdx = 0;

  // Flush RC segments with receivedAtMs <= upToMs into a single user message.
  const flushRCUpTo = (upToMs: number) => {
    const pending: RenderedContentPiece[] = [];
    while (rcIdx < rc.length && rc[rcIdx]!.receivedAtMs <= upToMs) {
      pending.push(...rc[rcIdx]!.content);
      rcIdx++;
    }
    if (pending.length > 0)
      messages.push({ role: 'user', content: pending.map(contentPieceToMessagePart) } as UserMessage);
  };

  for (let i = 0; i < trs.length; i++) {
    const tr = trs[i]!;
    const [toolResults, rest] = splitLeadingTools(tr.data);

    // 1. Anchor tool results right after the previous TR, before any interleaved RC.
    //    (For the first TR there's no previous tool_call to respond to, so skip.)
    if (toolResults.length > 0 && i > 0) {
      for (const msg of toolResults)
        messages.push(msg as Message);
    }

    // 2. Flush RC segments up to this TR's timestamp (inclusive = tiebreaker).
    flushRCUpTo(tr.requestedAtMs);

    // 3. Emit the rest of this TR's data (assistant messages).
    //    For first TR with unexpected tool results, include them here.
    if (toolResults.length > 0 && i === 0) {
      for (const msg of toolResults)
        messages.push(msg as Message);
    }
    for (const msg of rest)
      messages.push(msg as Message);
  }

  // Flush any remaining RC segments after the last TR.
  flushRCUpTo(Number.MAX_SAFE_INTEGER);

  return messages;
};
