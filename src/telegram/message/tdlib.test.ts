import type * as Td from 'tdlib-types';
import { describe, expect, it } from 'vitest';

import { fromTdMessage } from './tdlib';
import { createEntityCache } from '../entity-cache';

describe('rich message adaptation', () => {
  it('retains inline button labels and current replacement text', () => {
    const text: Td.RichText = {
      _: 'richTexts',
      texts: [
        {
          _: 'richTextButton', button: {
            _: 'inlineButton',
            text: { _: 'richTextPlain', text: 'Open' },
            style: { _: 'buttonStyleDefault' },
            type: { _: 'inlineKeyboardButtonTypeUrl', url: 'https://example.com' },
          },
        },
        { _: 'richTextDiff', text: { _: 'richTextBold', text: { _: 'richTextPlain', text: ' current' } }, old_text: { _: 'richTextPlain', text: ' obsolete' } },
      ],
    };
    const message = {
      _: 'message', id: 1048576, chat_id: -100123, date: 123,
      sender_id: { _: 'messageSenderUser', user_id: 1 },
      content: {
        _: 'messageRichMessage', message: {
          _: 'richMessage', is_rtl: false, is_full: true,
          blocks: [{ _: 'pageBlockParagraph', text }],
        },
      },
    } as unknown as Td.message;
    expect(fromTdMessage(createEntityCache(), message, 'userbot')?.text).toBe('Open current');
  });
});
