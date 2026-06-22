import { describe, expect, it } from 'vitest';

import { isConfiguredChat, selectStartupReplayChatIds } from './chat-selection';

describe('startup chat selection', () => {
  it('replays only chats that are both known in the DB and configured', () => {
    expect(selectStartupReplayChatIds(
      ['configured-a', 'archived-chat', 'configured-b'],
      ['configured-b', 'configured-a', 'new-configured-chat'],
    )).toEqual(['configured-a', 'configured-b']);
  });

  it('keeps only configured chats in the in-memory pipeline', () => {
    const configured = new Set(['configured-chat']);

    expect(isConfiguredChat(configured, 'configured-chat')).toBe(true);
    expect(isConfiguredChat(configured, 'archived-chat')).toBe(false);
  });
});
