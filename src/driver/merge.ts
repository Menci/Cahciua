import type { RenderedContext, RenderedContentPiece } from '../rendering/types';
import type { ConversationEntry, InputMessage, InputPart } from '../unified-api/types';

const pieceToPart = (piece: RenderedContentPiece): InputPart =>
  piece.type === 'text'
    ? { kind: 'text', text: piece.text }
    : { kind: 'image', image: piece.image, detail: 'low' };

const rcUserMessage = (pieces: RenderedContentPiece[]): InputMessage => ({
  kind: 'message',
  role: 'user',
  parts: pieces.map(pieceToPart),
});

// Merge RC segments and TR entries into a unified ConversationEntry[] timeline.
//
// RC segments are interleaved with TR entries by timestamp. Each TR's entries
// share the TR's requestedAtMs as their primary sort key; within a TR, original
// array order is preserved via a secondary index. Consecutive RC segments
// (with no TR entries between them) collapse into one user InputMessage.
//
// Tiebreaker on equal timestamps: RC sorts before TR (so user messages precede
// the assistant turn they triggered — Anthropic role alternation stays valid).
export const mergeContext = (rc: RenderedContext, trs: { requestedAtMs: number; entries: ConversationEntry[] }[]): ConversationEntry[] => {
  type Slot =
    | { kind: 'rc'; time: number; step: -1; content: RenderedContentPiece[] }
    | { kind: 'tr'; time: number; step: number; entry: ConversationEntry };

  const slots: Slot[] = [];
  for (const seg of rc)
    slots.push({ kind: 'rc', time: seg.receivedAtMs, step: -1, content: seg.content });
  for (const tr of trs) {
    for (let i = 0; i < tr.entries.length; i++)
      slots.push({ kind: 'tr', time: tr.requestedAtMs, step: i, entry: tr.entries[i]! });
  }

  slots.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.kind !== b.kind) return a.kind === 'rc' ? -1 : 1;
    return a.step - b.step;
  });

  const out: ConversationEntry[] = [];
  let pending: RenderedContentPiece[] = [];
  const flushPending = () => {
    if (pending.length === 0) return;
    out.push(rcUserMessage(pending));
    pending = [];
  };
  for (const slot of slots) {
    if (slot.kind === 'rc') {
      pending.push(...slot.content);
    } else {
      flushPending();
      out.push(slot.entry);
    }
  }
  flushPending();
  return out;
};
