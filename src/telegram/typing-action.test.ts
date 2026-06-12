import type * as Td from 'tdlib-types';
import { describe, expect, it } from 'vitest';

import { isTypingLikeAction } from './typing-action';

const action = (kind: string): Td.ChatAction => ({ _: kind } as unknown as Td.ChatAction);

describe('isTypingLikeAction', () => {
  it('accepts plain typing actions', () => {
    expect(isTypingLikeAction(action('chatActionTyping'))).toBe(true);
  });

  it('rejects cancel actions', () => {
    expect(isTypingLikeAction(action('chatActionCancel'))).toBe(false);
  });

  it('accepts upload and recording actions as active composition', () => {
    expect(isTypingLikeAction(action('chatActionUploadingPhoto'))).toBe(true);
    expect(isTypingLikeAction(action('chatActionUploadingDocument'))).toBe(true);
    expect(isTypingLikeAction(action('chatActionRecordingVoiceNote'))).toBe(true);
    expect(isTypingLikeAction(action('chatActionRecordingVideo'))).toBe(true);
    expect(isTypingLikeAction(action('chatActionChoosingSticker'))).toBe(true);
  });
});
