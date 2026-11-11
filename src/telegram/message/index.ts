export type {
  Attachment,
  ForwardInfo,
  MessageEntity,
  TelegramMessage,
  TelegramMessageDelete,
  TelegramMessageEdit,
  TelegramUser,
} from './types';

export {
  chatIdToString,
  convertEntities,
  fromTeleprotoDelete,
  fromTeleprotoEdit,
  fromTeleprotoMessage,
  resolveSender,
} from './teleproto';
