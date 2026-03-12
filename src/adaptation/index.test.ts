import { describe, expect, it } from 'vitest';

import { adaptDelete, adaptEdit, adaptMessage, contentToPlainText, parseContent } from './index';
import type { ContentNode } from './types';
import type { MessageEntity, TelegramMessage, TelegramMessageEdit } from '../telegram/message/types';

// --- helpers ---

const entity = (type: string, offset: number, length: number, extra?: Partial<MessageEntity>): MessageEntity => ({
  type, offset, length, ...extra,
});

const baseTelegramMessage = (overrides?: Partial<TelegramMessage>): TelegramMessage => ({
  messageId: 42,
  chatId: '-100123',
  date: 1700000000,
  text: 'hello',
  source: 'bot',
  ...overrides,
});

// --- parseContent ---

describe('parseContent', () => {
  describe('basics', () => {
    it('returns single text node for plain text', () => {
      expect(parseContent('hello')).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('returns empty array for empty text', () => {
      expect(parseContent('')).toEqual([]);
    });

    it('returns single text node when entities is undefined', () => {
      expect(parseContent('hello', undefined)).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('returns single text node when entities is empty', () => {
      expect(parseContent('hello', [])).toEqual([{ type: 'text', text: 'hello' }]);
    });
  });

  describe('leaf nodes', () => {
    it('parses code entity', () => {
      expect(parseContent('hello', [entity('code', 0, 5)])).toEqual([
        { type: 'code', text: 'hello' },
      ]);
    });

    it('parses pre entity without language', () => {
      expect(parseContent('hello', [entity('pre', 0, 5)])).toEqual([
        { type: 'pre', text: 'hello' },
      ]);
    });

    it('parses pre entity with language', () => {
      expect(parseContent('hello', [entity('pre', 0, 5, { language: 'ts' })])).toEqual([
        { type: 'pre', text: 'hello', language: 'ts' },
      ]);
    });
  });

  describe('container nodes', () => {
    it.each([
      'bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'blockquote',
    ] as const)('parses %s entity', type => {
      expect(parseContent('hello', [entity(type, 0, 5)])).toEqual([
        { type, children: [{ type: 'text', text: 'hello' }] },
      ]);
    });

    it('maps expandable_blockquote to blockquote', () => {
      expect(parseContent('hello', [entity('expandable_blockquote', 0, 5)])).toEqual([
        { type: 'blockquote', children: [{ type: 'text', text: 'hello' }] },
      ]);
    });
  });

  describe('links', () => {
    it('parses text_link with url from entity', () => {
      expect(parseContent('click', [entity('text_link', 0, 5, { url: 'https://example.com' })])).toEqual([
        { type: 'link', url: 'https://example.com', children: [{ type: 'text', text: 'click' }] },
      ]);
    });

    it('parses url entity with url from text', () => {
      const text = 'visit https://example.com today';
      const url = 'https://example.com';
      const offset = text.indexOf(url);
      expect(parseContent(text, [entity('url', offset, url.length)])).toEqual([
        { type: 'text', text: 'visit ' },
        { type: 'link', url, children: [{ type: 'text', text: url }] },
        { type: 'text', text: ' today' },
      ]);
    });
  });

  describe('mentions', () => {
    it('parses mention entity', () => {
      expect(parseContent('@alice', [entity('mention', 0, 6)])).toEqual([
        { type: 'mention', children: [{ type: 'text', text: '@alice' }] },
      ]);
    });

    it('parses text_mention with userId', () => {
      expect(parseContent('Alice', [entity('text_mention', 0, 5, { userId: '123' })])).toEqual([
        { type: 'mention', userId: '123', children: [{ type: 'text', text: 'Alice' }] },
      ]);
    });
  });

  describe('custom emoji', () => {
    it('parses custom_emoji with customEmojiId', () => {
      expect(parseContent('🎉', [entity('custom_emoji', 0, 2, { customEmojiId: '999' })])).toEqual([
        { type: 'custom_emoji', customEmojiId: '999', children: [{ type: 'text', text: '🎉' }] },
      ]);
    });
  });

  describe('unknown types', () => {
    it.each(['hashtag', 'bot_command', 'email', 'phone_number', 'cashtag'])('treats %s as plain text', type => {
      expect(parseContent('#tag', [entity(type, 0, 4)])).toEqual([
        { type: 'text', text: '#tag' },
      ]);
    });
  });

  describe('composition', () => {
    it('handles text before and after entity', () => {
      expect(parseContent('say hello world', [entity('bold', 4, 5)])).toEqual([
        { type: 'text', text: 'say ' },
        { type: 'bold', children: [{ type: 'text', text: 'hello' }] },
        { type: 'text', text: ' world' },
      ]);
    });

    it('handles multiple non-overlapping entities', () => {
      expect(parseContent('bold and italic', [
        entity('bold', 0, 4),
        entity('italic', 9, 6),
      ])).toEqual([
        { type: 'bold', children: [{ type: 'text', text: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'italic', children: [{ type: 'text', text: 'italic' }] },
      ]);
    });

    it('handles nested entities (bold containing italic)', () => {
      // "hello" where entire text is bold, and "ell" inside is italic
      expect(parseContent('hello', [
        entity('bold', 0, 5),
        entity('italic', 1, 3),
      ])).toEqual([
        {
          type: 'bold', children: [
            { type: 'text', text: 'h' },
            { type: 'italic', children: [{ type: 'text', text: 'ell' }] },
            { type: 'text', text: 'o' },
          ],
        },
      ]);
    });

    it('handles deeply nested entities (bold > italic > code)', () => {
      // "abcde" — bold covers all, italic covers "bcd", code covers "c"
      // code is a leaf node, so its inner text is rawText, not children
      expect(parseContent('abcde', [
        entity('bold', 0, 5),
        entity('italic', 1, 3),
        entity('code', 2, 1),
      ])).toEqual([
        {
          type: 'bold', children: [
            { type: 'text', text: 'a' },
            {
              type: 'italic', children: [
                { type: 'text', text: 'b' },
                { type: 'code', text: 'c' },
                { type: 'text', text: 'd' },
              ],
            },
            { type: 'text', text: 'e' },
          ],
        },
      ]);
    });

    it('sorts entities by offset asc, length desc', () => {
      // Pass entities in wrong order — parser should sort them
      expect(parseContent('hello', [
        entity('italic', 1, 3),
        entity('bold', 0, 5),
      ])).toEqual([
        {
          type: 'bold', children: [
            { type: 'text', text: 'h' },
            { type: 'italic', children: [{ type: 'text', text: 'ell' }] },
            { type: 'text', text: 'o' },
          ],
        },
      ]);
    });

    it('handles adjacent entities with no gap', () => {
      expect(parseContent('bolditalic', [
        entity('bold', 0, 4),
        entity('italic', 4, 6),
      ])).toEqual([
        { type: 'bold', children: [{ type: 'text', text: 'bold' }] },
        { type: 'italic', children: [{ type: 'text', text: 'italic' }] },
      ]);
    });
  });
});

// --- contentToPlainText ---

describe('contentToPlainText', () => {
  it('extracts text from single text node', () => {
    expect(contentToPlainText([{ type: 'text', text: 'hello' }])).toBe('hello');
  });

  it('extracts text from nested containers', () => {
    const nodes: ContentNode[] = [
      { type: 'bold', children: [{ type: 'italic', children: [{ type: 'text', text: 'deep' }] }] },
    ];
    expect(contentToPlainText(nodes)).toBe('deep');
  });

  it('concatenates text from mixed nodes', () => {
    const nodes: ContentNode[] = [
      { type: 'text', text: 'say ' },
      { type: 'bold', children: [{ type: 'text', text: 'hello' }] },
      { type: 'text', text: ' world' },
    ];
    expect(contentToPlainText(nodes)).toBe('say hello world');
  });

  it('returns empty string for empty array', () => {
    expect(contentToPlainText([])).toBe('');
  });

  it('extracts text from code and pre leaf nodes', () => {
    const nodes: ContentNode[] = [
      { type: 'code', text: 'foo()' },
      { type: 'text', text: ' and ' },
      { type: 'pre', text: 'bar()' },
    ];
    expect(contentToPlainText(nodes)).toBe('foo() and bar()');
  });
});

// --- adaptMessage ---

describe('adaptMessage', () => {
  it('maps basic fields', () => {
    const event = adaptMessage(baseTelegramMessage());
    expect(event.type).toBe('message');
    expect(event.chatId).toBe('-100123');
    expect(event.messageId).toBe('42');
    expect(event.timestampSec).toBe(1700000000);
    expect(event.receivedAtMs).toBeTypeOf('number');
    expect(event.receivedAtMs).toBeGreaterThan(0);
  });

  it('adapts sender with firstName + lastName → displayName', () => {
    const event = adaptMessage(baseTelegramMessage({
      sender: { id: '1', firstName: 'Alice', lastName: 'Smith', isBot: false, isPremium: false },
    }));
    expect(event.sender).toEqual({
      id: '1',
      displayName: 'Alice Smith',
      username: undefined,
      isBot: false,
    });
  });

  it('adapts sender with firstName only', () => {
    const event = adaptMessage(baseTelegramMessage({
      sender: { id: '1', firstName: 'Alice', isBot: false, isPremium: false },
    }));
    expect(event.sender?.displayName).toBe('Alice');
  });

  it('omits sender when not present', () => {
    const event = adaptMessage(baseTelegramMessage());
    expect(event.sender).toBeUndefined();
  });

  it('converts replyToMessageId to string', () => {
    const event = adaptMessage(baseTelegramMessage({ replyToMessageId: 99 }));
    expect(event.replyToMessageId).toBe('99');
  });

  it('omits replyToMessageId when not present', () => {
    const event = adaptMessage(baseTelegramMessage());
    expect(event.replyToMessageId).toBeUndefined();
  });

  it('adapts forwardInfo', () => {
    const event = adaptMessage(baseTelegramMessage({
      forwardInfo: { senderName: 'Someone', date: 100 },
    }));
    expect(event.forwardInfo).toEqual({ senderName: 'Someone', date: 100 });
  });

  it('omits forwardInfo when all fields are empty', () => {
    const event = adaptMessage(baseTelegramMessage({
      forwardInfo: {},
    }));
    expect(event.forwardInfo).toBeUndefined();
  });

  it('adapts attachments', () => {
    const event = adaptMessage(baseTelegramMessage({
      attachments: [{
        type: 'photo',
        width: 800,
        height: 600,
        fileId: 'abc',
        thumbnail: 'base64data',
      }],
    }));
    expect(event.attachments).toEqual([{
      type: 'photo',
      width: 800,
      height: 600,
      thumbnail: 'base64data',
    }]);
  });

  it('returns empty attachments when none present', () => {
    const event = adaptMessage(baseTelegramMessage());
    expect(event.attachments).toEqual([]);
  });

  it('parses content from text + entities', () => {
    const event = adaptMessage(baseTelegramMessage({
      text: 'hello',
      entities: [{ type: 'bold', offset: 0, length: 5 }],
    }));
    expect(event.content).toEqual([
      { type: 'bold', children: [{ type: 'text', text: 'hello' }] },
    ]);
  });
});

// --- adaptEdit ---

describe('adaptEdit', () => {
  const baseEdit: TelegramMessageEdit = {
    messageId: 42,
    chatId: '-100123',
    date: 1700000000,
    editDate: 1700000060,
    text: 'edited',
    source: 'userbot',
  } as TelegramMessageEdit;

  it('maps basic fields', () => {
    const event = adaptEdit(baseEdit);
    expect(event.type).toBe('edit');
    expect(event.chatId).toBe('-100123');
    expect(event.messageId).toBe('42');
    expect(event.timestampSec).toBe(1700000060);
  });

  it('adapts sender', () => {
    const event = adaptEdit({
      ...baseEdit,
      sender: { id: '1', firstName: 'Bob', isBot: false, isPremium: false },
    });
    expect(event.sender?.displayName).toBe('Bob');
  });
});

// --- adaptDelete ---

describe('adaptDelete', () => {
  it('converts messageIds to strings', () => {
    const event = adaptDelete({ messageIds: [1, 2, 3], chatId: '-100123' });
    expect(event.messageIds).toEqual(['1', '2', '3']);
  });

  it('derives timestampSec from receivedAtMs', () => {
    const event = adaptDelete({ messageIds: [1], chatId: '-100123' });
    expect(event.timestampSec).toBe(Math.floor(event.receivedAtMs / 1000));
  });

  it('throws when chatId is missing', () => {
    expect(() => adaptDelete({ messageIds: [1] })).toThrow('Cannot adapt delete event without chatId');
  });
});
