import type * as Td from 'tdlib-types';

// TDLib resolves sendMessage as soon as the message exists locally with a
// per-dialog yet-unsent id; the file upload and server confirmation happen
// later. Two things must wait for that confirmation, so both hang off the
// same terminal update:
//
// - the bot's temp-file workDir must outlive the invoke, because FileUploader
//   opens the local path lazily and deletes nothing itself — removing the
//   directory early makes the upload fail ("Can't resend local file");
// - the synthetic self-event needs the final server message id. The yet-unsent
//   id converts to it only in updateMessageSendSucceeded, whose old_message_id
//   matches the id returned by the invoke.
//
// There is deliberately no timeout: large uploads and FLOOD_WAIT retries keep
// the message pending far longer than any fixed bound while it is still making
// progress, and a timeout that fires then deletes the temp file and resurrects
// the original bug. Terminal states arrive on real failure or success; only a
// client shutdown has no update to deliver, and abort() covers that case.
//
// Bots receive both terminal updates for their own outgoing messages (no
// is_bot gate in MessagesManager; TDLib a17f87c4), and never receive
// updateNewMessage for them, so settling cannot race the bot's own ingress.
export interface SendTracker {
  track: (sent: Td.message) => Promise<Td.message>;
  settle: (update: Td.updateMessageSendSucceeded | Td.updateMessageSendFailed) => void;
  abort: (reason: string) => void;
}

export const createSendTracker = (): SendTracker => {
  const pending = new Map<string, {
    resolve: (message: Td.message) => void;
    reject: (error: Error) => void;
  }>();

  const key = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

  const settle = (update: Td.updateMessageSendSucceeded | Td.updateMessageSendFailed): void => {
    const entry = pending.get(key(update.message.chat_id, update.old_message_id));
    if (!entry) return;
    pending.delete(key(update.message.chat_id, update.old_message_id));
    if (update._ === 'updateMessageSendSucceeded') {
      entry.resolve(update.message);
    } else {
      entry.reject(new Error(`Telegram send failed (${update.error.code}): ${update.error.message}`));
    }
  };

  return {
    track: sent => new Promise<Td.message>((resolve, reject) => {
      pending.set(key(sent.chat_id, sent.id), { resolve, reject });
    }),
    settle,
    abort: reason => {
      for (const entry of pending.values()) {
        entry.reject(new Error(`Telegram send abandoned: ${reason}`));
      }
      pending.clear();
    },
  };
};
