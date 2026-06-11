import { Api } from 'telegram';
import { describe, expect, it } from 'vitest';

import { isTypingLikeAction } from './typing-action';

describe('isTypingLikeAction', () => {
  it('accepts plain typing actions', () => {
    expect(isTypingLikeAction(new Api.SendMessageTypingAction())).toBe(true);
  });

  it('rejects cancel actions', () => {
    expect(isTypingLikeAction(new Api.SendMessageCancelAction())).toBe(false);
  });

  it('accepts upload and recording actions as active composition', () => {
    expect(isTypingLikeAction(new Api.SendMessageUploadPhotoAction({ progress: 50 }))).toBe(true);
    expect(isTypingLikeAction(new Api.SendMessageUploadDocumentAction({ progress: 50 }))).toBe(true);
    expect(isTypingLikeAction(new Api.SendMessageRecordAudioAction())).toBe(true);
    expect(isTypingLikeAction(new Api.SendMessageRecordVideoAction())).toBe(true);
    expect(isTypingLikeAction(new Api.SendMessageChooseStickerAction())).toBe(true);
  });
});
