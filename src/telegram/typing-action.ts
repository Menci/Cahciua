import type { Api } from 'telegram';

const TYPING_LIKE_ACTIONS = new Set<string>([
  'SendMessageTypingAction',
  'SendMessageRecordVideoAction',
  'SendMessageUploadVideoAction',
  'SendMessageRecordAudioAction',
  'SendMessageUploadAudioAction',
  'SendMessageUploadPhotoAction',
  'SendMessageUploadDocumentAction',
  'SendMessageRecordRoundAction',
  'SendMessageUploadRoundAction',
  'SendMessageChooseStickerAction',
]);

export const isTypingLikeAction = (action: Api.TypeSendMessageAction): boolean =>
  TYPING_LIKE_ACTIONS.has(action.className);
