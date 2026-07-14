import type { ConversationEntry, InputPart } from '../unified-api/types';

const countImages = (entries: ConversationEntry[]): number => {
  let count = 0;
  for (const entry of entries) {
    if (entry.kind === 'toolResult' && typeof entry.payload !== 'string')
      count += entry.payload.filter(part => part.kind === 'image').length;
    else if (entry.kind === 'message')
      count += entry.parts.filter(part => part.kind === 'image').length;
  }
  return count;
};

export const trimImages = (entries: ConversationEntry[], maxImages: number): ConversationEntry[] => {
  let toDrop = countImages(entries) - maxImages;
  if (toDrop <= 0) return entries;

  return entries.map(entry => {
    if (toDrop <= 0) return entry;

    if (entry.kind === 'message' && entry.role !== 'assistant') {
      const parts: InputPart[] = [];
      for (const part of entry.parts) {
        if (part.kind === 'image' && toDrop > 0) {
          toDrop--;
        } else {
          parts.push(part);
        }
      }
      if (parts.length === entry.parts.length) return entry;
      return {
        ...entry,
        parts: parts.length > 0 ? parts : [{ kind: 'text', text: '[image removed]' }],
      };
    }

    if (entry.kind === 'toolResult' && typeof entry.payload !== 'string') {
      const parts: InputPart[] = [];
      for (const part of entry.payload) {
        if (part.kind === 'image' && toDrop > 0) {
          toDrop--;
        } else {
          parts.push(part);
        }
      }
      if (parts.length === entry.payload.length) return entry;
      return { ...entry, payload: parts.length > 0 ? parts : '[image removed]' };
    }

    return entry;
  });
};
