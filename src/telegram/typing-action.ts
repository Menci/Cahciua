import type * as Td from 'tdlib-types';

const TYPING_LIKE_ACTIONS = new Set<string>([
  'chatActionTyping',
  'chatActionRecordingVideo',
  'chatActionUploadingVideo',
  'chatActionRecordingVoiceNote',
  'chatActionUploadingVoiceNote',
  'chatActionUploadingPhoto',
  'chatActionUploadingDocument',
  'chatActionRecordingVideoNote',
  'chatActionUploadingVideoNote',
  'chatActionChoosingSticker',
]);

export const isTypingLikeAction = (action: Td.ChatAction): boolean =>
  TYPING_LIKE_ACTIONS.has(action._);
