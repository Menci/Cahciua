import type { Message, UserMessage } from 'xsai';

import type { TurnResponse } from './types';
import type { RenderedContext, RenderedContentPiece } from '../rendering/types';

const contentPieceToMessagePart = (piece: RenderedContentPiece) =>
  piece.type === 'text'
    ? { type: 'text' as const, text: piece.text }
    : { type: 'image_url' as const, image_url: { url: piece.url, detail: 'low' as const } };

// Merge RC segments and TRs into an xsai Message[] array.
//
// Each entry is assigned a sort key: RC segments use receivedAtMs,
// TR entries use (requestedAtMs, step) where step is the array index
// within the TR's data. This provides a unified timeline without
// special-case anchoring logic.
//
// Tiebreaker: RC before TR on equal timestamp (Anthropic role alternation).
// Consecutive RC segments between non-RC entries merge into one user message.
export const mergeContext = (rc: RenderedContext, trs: TurnResponse[]): Message[] => {
  type Entry =
    | { kind: 'rc'; time: number; step: -1; content: RenderedContentPiece[] }
    | { kind: 'tr'; time: number; step: number; message: unknown };

  const entries: Entry[] = [];

  for (const seg of rc)
    entries.push({ kind: 'rc', time: seg.receivedAtMs, step: -1, content: seg.content });

  for (const t of trs)
    for (let i = 0; i < t.data.length; i++)
      entries.push({ kind: 'tr', time: t.requestedAtMs, step: i, message: t.data[i] });

  entries.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    // RC before TR on equal timestamp
    if (a.kind !== b.kind) return a.kind === 'rc' ? -1 : 1;
    return a.step - b.step;
  });

  // Build messages: consecutive RC entries merge into one user message.
  const messages: Message[] = [];
  let pendingParts: ReturnType<typeof contentPieceToMessagePart>[] = [];

  const flushRC = () => {
    if (pendingParts.length > 0) {
      messages.push({ role: 'user', content: pendingParts } as UserMessage);
      pendingParts = [];
    }
  };

  for (const entry of entries) {
    if (entry.kind === 'rc') {
      pendingParts.push(...entry.content.map(contentPieceToMessagePart));
    } else {
      flushRC();
      messages.push(entry.message as Message);
    }
  }
  flushRC();

  return messages;
};
