import { createHash } from 'node:crypto';

import type { ArchivedEvent, ArchiveRef } from '../db/history-archive';
import type { IntermediateContext } from '../projection';
import { createRenderer } from '../rendering';
import type { RenderParams } from '../rendering';
import { historyKey } from './turn-items';
import type { HistoryMessage } from './types';

export interface MessageSource {
  origin: ArchiveRef;
  changedBy: ArchiveRef;
  revision: string;
}

export const changedMessageIds = (row: ArchivedEvent): readonly string[] => {
  const event = row.event;
  return event.type === 'message' || event.type === 'edit' ? [event.messageId] : event.type === 'delete' ? event.messageIds : [];
};

export const updateMessageSource = (previous: MessageSource | undefined, row: ArchivedEvent): MessageSource | undefined => {
  if (!previous && row.event.type !== 'message') return undefined;
  return {
    origin: previous?.origin ?? row.ref,
    changedBy: row.ref,
    revision: createHash('sha256').update(JSON.stringify([previous?.revision, row.revision])).digest('hex'),
  };
};

export const buildMessageItems = (ic: IntermediateContext, sources: ReadonlyMap<string, MessageSource>, params: RenderParams = {}): HistoryMessage[] => {
  const renderer = createRenderer();
  try {
    const times = ic.nodes.map(node => node.receivedAtMs);
    const window = times.length === 0 ? { fromReceivedAtMs: 0, untilReceivedAtMs: 0 } : {
      fromReceivedAtMs: times.reduce((min, time) => Math.min(min, time)),
      untilReceivedAtMs: times.reduce((max, time) => Math.max(max, time)) + 1,
    };
    const records = renderer.render(ic, params, window);
    return records.flatMap(record => {
      if (record.kind !== 'message') return [];
      const source = sources.get(record.metadata.messageId);
      if (!source) throw new Error('Missing historical message provenance');
      return [{
        kind: 'message' as const, key: historyKey(ic.sessionId, 'message', record.metadata.messageId), chatId: ic.sessionId,
        source: source.origin, changedBy: source.changedBy, sourceRevision: source.revision,
        order: { timeMs: record.metadata.receivedAtMs, sourceOrder: 0 as const, sourceId: source.origin.id, entryIndex: -1, partIndex: -1 },
        metadata: record.metadata, transcript: record.transcript,
      }];
    });
  } finally {
    renderer.retainWindow({ fromReceivedAtMs: 0, untilReceivedAtMs: 0 });
  }
};
