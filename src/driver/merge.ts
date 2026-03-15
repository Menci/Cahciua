import type { ContextChunk, ProviderFormat, TurnResponse } from './types';
import type { RenderedContext, RenderedContentPiece } from '../rendering/types';

// Merge RC segments and TRs into a ContextChunk[] array.
//
// Design: RC is intentionally a flat array of individually-timestamped segments.
// The Rendering layer produces segments without any knowledge of TRs — it only
// sees IC and RenderParams. This merge function re-groups consecutive RC segments
// (those not separated by a TR) into single rc chunks. The grouping boundary
// is determined by TR timestamps, which is Driver-layer knowledge. This keeps the
// Rendering → Driver dependency one-directional and the Rendering layer pure.
//
// Each entry is assigned a sort key: RC segments use receivedAtMs,
// TR entries use (requestedAtMs, step) where step is the array index
// within the TR's data. This provides a unified timeline without
// special-case anchoring logic.
//
// Tiebreaker: RC before TR on equal timestamp (Anthropic role alternation).
// Consecutive RC segments between non-RC entries merge into one rc chunk.
export const mergeContext = (rc: RenderedContext, trs: TurnResponse[]): ContextChunk[] => {
  type Entry =
    | { kind: 'rc'; time: number; step: -1; content: RenderedContentPiece[] }
    | { kind: 'tr'; provider: ProviderFormat; time: number; step: number; data: unknown };

  const entries: Entry[] = [];

  for (const seg of rc)
    entries.push({ kind: 'rc', time: seg.receivedAtMs, step: -1, content: seg.content });

  for (const t of trs)
    for (let i = 0; i < t.data.length; i++)
      entries.push({ kind: 'tr', provider: t.provider, time: t.requestedAtMs, step: i, data: t.data[i]! });

  entries.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    // RC before TR on equal timestamp
    if (a.kind !== b.kind) return a.kind === 'rc' ? -1 : 1;
    return a.step - b.step;
  });

  // Build chunks: consecutive RC entries merge into one rc chunk.
  const chunks: ContextChunk[] = [];
  let pendingContent: RenderedContentPiece[] = [];
  let pendingTime = 0;

  const flushRC = () => {
    if (pendingContent.length > 0) {
      chunks.push({ type: 'rc', time: pendingTime, step: -1, content: pendingContent });
      pendingContent = [];
    }
  };

  for (const entry of entries) {
    if (entry.kind === 'rc') {
      pendingContent.push(...entry.content);
      pendingTime = entry.time;
    } else {
      flushRC();
      chunks.push({ type: 'tr', provider: entry.provider, time: entry.time, step: entry.step, data: entry.data });
    }
  }
  flushRC();

  return chunks;
};
