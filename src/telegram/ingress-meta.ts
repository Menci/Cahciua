import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit } from './message/types';

export interface IngressMetadata {
  receivedAtMs: number;
  utcOffsetMin: number;
}

export type IngressTelegramMessage = TelegramMessage & IngressMetadata;
export type IngressTelegramMessageEdit = TelegramMessageEdit & IngressMetadata;
export type IngressTelegramMessageDelete = TelegramMessageDelete & IngressMetadata & { chatId: string };

export const captureIngressMetadata = <T>(value: T): T & IngressMetadata => ({
  ...value,
  receivedAtMs: (value as T & Partial<IngressMetadata>).receivedAtMs ?? Date.now(),
  utcOffsetMin: (value as T & Partial<IngressMetadata>).utcOffsetMin ?? -new Date().getTimezoneOffset(),
});
