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
  fromGramjsAnyMessage,
  fromGramjsDeletedMessage,
  fromGramjsEditedMessage,
  fromGramjsMessage,
  fromGramjsServiceMessage,
  resolveGramjsChatId,
  resolveGramjsSender,
} from './gramjs';
