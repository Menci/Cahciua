export type {
  Attachment,
  ExternalReplyInfo,
  ForwardInfo,
  ReplyQuote,
  MessageEntity,
  SharedContact,
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
