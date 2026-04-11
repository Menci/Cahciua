import { describe, expect, it } from 'vitest';

import { rcToXml, render } from './index';
import type { CanonicalUser, ContentNode } from '../adaptation/types';
import type { ICMessage, ICSystemEvent, IntermediateContext } from '../projection/types';

// --- helpers ---

const alice: CanonicalUser = { id: '1', displayName: 'Alice', username: 'alice', isBot: false };
const bob: CanonicalUser = { id: '2', displayName: 'Bob', isBot: false };

const ic = (nodes: IntermediateContext['nodes']): IntermediateContext => ({
  sessionId: 'chat1',
  nodes,
  users: new Map(),
});

const message = (overrides?: Partial<ICMessage>): ICMessage => ({
  type: 'message',
  messageId: '42',
  sender: alice,
  receivedAtMs: 1000,
  timestampSec: 1741761000, // 2025-03-12T14:30:00 at +08:00
  utcOffsetMin: 480,
  content: [{ type: 'text', text: 'hello' }],
  attachments: [],
  ...overrides,
});

const xml = (segments: ReturnType<typeof render>): string => rcToXml(segments);

// --- render ---

describe('render', () => {
  describe('basic message', () => {
    it('renders a simple message with sender and timestamp', () => {
      const result = xml(render(ic([message()])));
      expect(result).toContain('id="42"');
      expect(result).toContain('sender="Alice (@alice)"');
      expect(result).toContain('t="2025-03-12T14:30:00+08:00"');
      expect(result).toContain('hello');
      expect(result).toContain('<message');
      expect(result).toContain('</message>');
    });

    it('formats sender without username', () => {
      const result = xml(render(ic([message({ sender: bob })])));
      expect(result).toContain('sender="Bob"');
    });

    it('produces one segment per ICNode', () => {
      const rc = render(ic([
        message(),
        message({ messageId: '43', receivedAtMs: 2000, timestampSec: 1741761060 }),
      ]));
      expect(rc).toHaveLength(2);
      expect(rc[0]!.receivedAtMs).toBe(1000);
      expect(rc[1]!.receivedAtMs).toBe(2000);
    });

    it('returns empty for empty IC', () => {
      expect(render(ic([]))).toEqual([]);
    });
  });

  describe('timestamp formatting', () => {
    it('formats positive UTC offset', () => {
      const result = xml(render(ic([message({ utcOffsetMin: 480 })])));
      expect(result).toContain('+08:00');
    });

    it('formats negative UTC offset', () => {
      // 1741776600 at -05:00 → 2025-03-12T01:30:00-05:00
      const result = xml(render(ic([message({ utcOffsetMin: -300 })])));
      expect(result).toContain('-05:00');
      expect(result).toContain('T01:30:00');
    });

    it('formats zero UTC offset', () => {
      const result = xml(render(ic([message({ utcOffsetMin: 0 })])));
      expect(result).toContain('+00:00');
    });

    it('formats offset with non-zero minutes', () => {
      const result = xml(render(ic([message({ utcOffsetMin: 345 })])));
      expect(result).toContain('+05:45');
    });
  });

  describe('rich text content', () => {
    it('renders bold', () => {
      const content: ContentNode[] = [{ type: 'bold', children: [{ type: 'text', text: 'strong' }] }];
      expect(xml(render(ic([message({ content })])))).toContain('<b>strong</b>');
    });

    it('renders italic', () => {
      const content: ContentNode[] = [{ type: 'italic', children: [{ type: 'text', text: 'em' }] }];
      expect(xml(render(ic([message({ content })])))).toContain('<i>em</i>');
    });

    it('renders code', () => {
      const content: ContentNode[] = [{ type: 'code', text: 'foo()' }];
      expect(xml(render(ic([message({ content })])))).toContain('<code>foo()</code>');
    });

    it('renders pre with language', () => {
      const content: ContentNode[] = [{ type: 'pre', text: 'x = 1', language: 'py' }];
      expect(xml(render(ic([message({ content })])))).toContain('<pre lang="py">x = 1</pre>');
    });

    it('renders pre without language', () => {
      const content: ContentNode[] = [{ type: 'pre', text: 'x = 1' }];
      expect(xml(render(ic([message({ content })])))).toContain('<pre>x = 1</pre>');
    });

    it('renders link', () => {
      const content: ContentNode[] = [{ type: 'link', url: 'https://example.com', children: [{ type: 'text', text: 'click' }] }];
      expect(xml(render(ic([message({ content })])))).toContain('<a href="https://example.com">click</a>');
    });

    it('renders mention with userId', () => {
      const content: ContentNode[] = [{ type: 'mention', userId: '99', children: [{ type: 'text', text: '@bob' }] }];
      expect(xml(render(ic([message({ content })])))).toContain('<mention uid="99">@bob</mention>');
    });

    it('renders mention without userId', () => {
      const content: ContentNode[] = [{ type: 'mention', children: [{ type: 'text', text: '@bob' }] }];
      const result = xml(render(ic([message({ content })])));
      expect(result).toContain('<mention>@bob</mention>');
      expect(result).not.toContain('uid=');
    });

    it('renders custom_emoji as children only', () => {
      const content: ContentNode[] = [{ type: 'custom_emoji', customEmojiId: '999', children: [{ type: 'text', text: '🎉' }] }];
      const result = xml(render(ic([message({ content })])));
      expect(result).toContain('🎉');
      expect(result).not.toContain('custom_emoji');
    });

    it('renders nested content', () => {
      const content: ContentNode[] = [
        {
          type: 'bold', children: [
            { type: 'text', text: 'say ' },
            { type: 'italic', children: [{ type: 'text', text: 'hi' }] },
          ],
        },
      ];
      expect(xml(render(ic([message({ content })])))).toContain('<b>say <i>hi</i></b>');
    });

    it('renders strikethrough, underline, spoiler, blockquote', () => {
      const content: ContentNode[] = [
        { type: 'strikethrough', children: [{ type: 'text', text: 'a' }] },
        { type: 'underline', children: [{ type: 'text', text: 'b' }] },
        { type: 'spoiler', children: [{ type: 'text', text: 'c' }] },
        { type: 'blockquote', children: [{ type: 'text', text: 'd' }] },
      ];
      const result = xml(render(ic([message({ content })])));
      expect(result).toContain('<s>a</s>');
      expect(result).toContain('<u>b</u>');
      expect(result).toContain('<spoiler>c</spoiler>');
      expect(result).toContain('<blockquote>d</blockquote>');
    });
  });

  describe('XML escaping', () => {
    it('escapes text content', () => {
      const content: ContentNode[] = [{ type: 'text', text: '<script>alert("xss")</script>' }];
      const result = xml(render(ic([message({ content })])));
      expect(result).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      expect(result).not.toContain('<script>');
    });

    it('escapes sender displayName in attributes', () => {
      const sender: CanonicalUser = { id: '3', displayName: 'A "B" <C>', isBot: false };
      const result = xml(render(ic([message({ sender })])));
      expect(result).toContain('sender="A &quot;B&quot; &lt;C&gt;"');
    });

    it('escapes code content', () => {
      const content: ContentNode[] = [{ type: 'code', text: 'x < y && z > w' }];
      const result = xml(render(ic([message({ content })])));
      expect(result).toContain('<code>x &lt; y &amp;&amp; z &gt; w</code>');
    });
  });

  describe('deleted message', () => {
    it('renders self-closing tag with deleted="true"', () => {
      const result = xml(render(ic([message({ deleted: true })])));
      expect(result).toContain('deleted="true"');
      expect(result).toContain('/>');
      expect(result).not.toContain('</message>');
      expect(result).not.toContain('hello');
    });
  });

  describe('edited message', () => {
    it('includes edited timestamp attribute', () => {
      const result = xml(render(ic([message({
        editedAtSec: 1741761120,
        editUtcOffsetMin: 480,
      })])));
      expect(result).toContain('edited="2025-03-12T14:32:00+08:00"');
    });

    it('uses message utcOffset when editUtcOffsetMin is absent', () => {
      const result = xml(render(ic([message({
        editedAtSec: 1741761120,
      })])));
      expect(result).toContain('edited=');
      expect(result).toContain('+08:00');
    });
  });

  describe('reply', () => {
    it('renders in-reply-to with sender and preview', () => {
      const result = xml(render(ic([message({
        replyToMessageId: '99',
        replyToSender: bob,
        replyToPreview: 'previous message',
      })])));
      expect(result).toContain('<in-reply-to id="99" sender="Bob">previous message</in-reply-to>');
    });

    it('renders in-reply-to without sender when not available', () => {
      const result = xml(render(ic([message({
        replyToMessageId: '99',
      })])));
      expect(result).toContain('<in-reply-to id="99">');
      expect(result).not.toContain('<in-reply-to id="99" sender=');
    });
  });

  describe('forward', () => {
    it('renders forwarded_from with sender using formatSender', () => {
      const result = xml(render(ic([message({
        forwardInfo: { sender: { id: '555', displayName: 'Alice', username: 'alice', isBot: false } },
      })])));
      expect(result).toContain('forwarded_from="Alice (@alice)"');
    });

    it('renders forwarded_from with sender without username', () => {
      const result = xml(render(ic([message({
        forwardInfo: { sender: { id: '555', displayName: 'Alice', isBot: false } },
      })])));
      expect(result).toContain('forwarded_from="Alice"');
    });

    it('falls back to senderName for hidden forwards', () => {
      const result = xml(render(ic([message({
        forwardInfo: { senderName: 'Someone' },
      })])));
      expect(result).toContain('forwarded_from="Someone"');
    });

    it('falls back to userId for forwarded_from', () => {
      const result = xml(render(ic([message({
        forwardInfo: { fromUserId: '555' },
      })])));
      expect(result).toContain('forwarded_from="user:555"');
    });

    it('falls back to chatId for forwarded_from', () => {
      const result = xml(render(ic([message({
        forwardInfo: { fromChatId: '-100999' },
      })])));
      expect(result).toContain('forwarded_from="chat:-100999"');
    });
  });

  describe('attachments', () => {
    it('renders attachment tag', () => {
      const result = xml(render(ic([message({
        attachments: [{ type: 'photo', width: 800, height: 600 }],
      })])));
      expect(result).toContain('<attachment type="photo" size="800x600" file-id="42:0"/>');
    });

    it('renders attachment with mime and name', () => {
      const result = xml(render(ic([message({
        attachments: [{ type: 'document', mimeType: 'application/pdf', fileName: 'test.pdf' }],
      })])));
      expect(result).toContain('type="document"');
      expect(result).toContain('mime="application/pdf"');
      expect(result).toContain('name="test.pdf"');
    });

    it('renders attachment with duration', () => {
      const result = xml(render(ic([message({
        attachments: [{ type: 'voice', duration: 5 }],
      })])));
      expect(result).toContain('duration="5"');
    });

    it('includes thumbnail as image content piece', () => {
      const rc = render(ic([message({
        attachments: [{ type: 'photo', width: 800, height: 600, thumbnailWebp: 'AAAA' }],
      })]));
      expect(rc).toHaveLength(1);
      const pieces = rc[0]!.content;
      expect(pieces).toHaveLength(2);
      expect(pieces[0]!.type).toBe('text');
      expect(pieces[1]).toEqual({ type: 'image', url: 'data:image/webp;base64,AAAA' });
    });

    it('renders inline image alt text and omits image content piece', () => {
      const rc = render(ic([message({
        attachments: [{
          type: 'photo',
          width: 800,
          height: 600,
          thumbnailWebp: 'AAAA',
          altText: 'a cat sleeping on a windowsill',
        }],
      })]));
      expect(rc[0]!.content).toHaveLength(1);
      expect(rc[0]!.content[0]).toEqual({
        type: 'text',
        text: '<message id="42" sender="Alice (@alice)" t="2025-03-12T14:30:00+08:00">\nhello\n<image type="photo" size="800x600" file-id="42:0">a cat sleeping on a windowsill</image>\n</message>',
      });
    });

    it('shows [thumbnail] placeholder in rcToXml', () => {
      const rc = render(ic([message({
        attachments: [{ type: 'photo', width: 800, height: 600, thumbnailWebp: 'AAAA' }],
      })]));
      const text = xml(rc);
      expect(text).toContain('[thumbnail]');
      expect(text).not.toContain('AAAA');
    });

    it('includes multiple thumbnails for album', () => {
      const rc = render(ic([message({
        attachments: [
          { type: 'photo', width: 800, height: 600, thumbnailWebp: 'AAA' },
          { type: 'photo', width: 1920, height: 1080, thumbnailWebp: 'BBB' },
        ],
      })]));
      const pieces = rc[0]!.content;
      expect(pieces).toHaveLength(3); // 1 text + 2 images
      expect(pieces[1]).toEqual({ type: 'image', url: 'data:image/webp;base64,AAA' });
      expect(pieces[2]).toEqual({ type: 'image', url: 'data:image/webp;base64,BBB' });
    });

    it('skips image piece when no thumbnail', () => {
      const rc = render(ic([message({
        attachments: [{ type: 'document', mimeType: 'application/pdf', fileName: 'test.pdf' }],
      })]));
      expect(rc[0]!.content).toHaveLength(1); // text only
    });
  });

  describe('system event', () => {
    it('renders user rename event', () => {
      const event: ICSystemEvent = {
        type: 'system_event',
        kind: 'user_renamed',
        receivedAtMs: 1000,
        timestampSec: 1741761000,
        utcOffsetMin: 480,
        userId: '1',
        oldUser: alice,
        newUser: { id: '1', displayName: 'Alice New', username: 'alice_new', isBot: false },
      };
      const result = xml(render(ic([event])));
      expect(result).toContain('type="name_change"');
      expect(result).toContain('from_name="Alice (@alice)"');
      expect(result).toContain('to_name="Alice New (@alice_new)"');
      expect(result).toContain('t="2025-03-12T14:30:00+08:00"');
      expect(result).toContain('/>');
    });

    it('renders members_joined event', () => {
      const event: ICSystemEvent = {
        type: 'system_event',
        kind: 'members_joined',
        receivedAtMs: 1000,
        timestampSec: 1741761000,
        utcOffsetMin: 480,
        actor: alice,
        members: [alice, bob],
      };
      const result = xml(render(ic([event])));
      expect(result).toContain('type="members_joined"');
      expect(result).toContain('actor="Alice (@alice)"');
      expect(result).toContain('members="Alice (@alice), Bob"');
      expect(result).toContain('/>');
    });

    it('renders member_left event', () => {
      const event: ICSystemEvent = {
        type: 'system_event',
        kind: 'member_left',
        receivedAtMs: 1000,
        timestampSec: 1741761000,
        utcOffsetMin: 480,
        actor: bob,
        member: bob,
      };
      const result = xml(render(ic([event])));
      expect(result).toContain('type="member_left"');
      expect(result).toContain('actor="Bob"');
      expect(result).toContain('member="Bob"');
    });

    it('renders chat_renamed event with from and to', () => {
      const event: ICSystemEvent = {
        type: 'system_event',
        kind: 'chat_renamed',
        receivedAtMs: 1000,
        timestampSec: 1741761000,
        utcOffsetMin: 480,
        actor: alice,
        oldTitle: 'Old Group',
        newTitle: 'New Group',
      };
      const result = xml(render(ic([event])));
      expect(result).toContain('type="chat_renamed"');
      expect(result).toContain('from="Old Group"');
      expect(result).toContain('to="New Group"');
    });

    it('renders chat_renamed event without from when oldTitle is null', () => {
      const event: ICSystemEvent = {
        type: 'system_event',
        kind: 'chat_renamed',
        receivedAtMs: 1000,
        timestampSec: 1741761000,
        utcOffsetMin: 480,
        actor: alice,
        oldTitle: null,
        newTitle: 'New Group',
      };
      const result = xml(render(ic([event])));
      expect(result).toContain('type="chat_renamed"');
      expect(result).not.toContain('from=');
      expect(result).toContain('to="New Group"');
    });

    it('renders chat_photo_changed event', () => {
      const event: ICSystemEvent = {
        type: 'system_event',
        kind: 'chat_photo_changed',
        receivedAtMs: 1000,
        timestampSec: 1741761000,
        utcOffsetMin: 480,
        actor: alice,
      };
      const result = xml(render(ic([event])));
      expect(result).toContain('type="chat_photo_changed"');
      expect(result).toContain('actor="Alice (@alice)"');
      expect(result).toContain('/>');
    });

    it('renders chat_photo_deleted event', () => {
      const event: ICSystemEvent = {
        type: 'system_event',
        kind: 'chat_photo_deleted',
        receivedAtMs: 1000,
        timestampSec: 1741761000,
        utcOffsetMin: 480,
      };
      const result = xml(render(ic([event])));
      expect(result).toContain('type="chat_photo_deleted"');
      expect(result).not.toContain('actor=');
    });

    it('renders message_pinned event with preview', () => {
      const event: ICSystemEvent = {
        type: 'system_event',
        kind: 'message_pinned',
        receivedAtMs: 1000,
        timestampSec: 1741761000,
        utcOffsetMin: 480,
        actor: alice,
        messageId: '42',
        preview: 'pinned content',
      };
      const result = xml(render(ic([event])));
      expect(result).toContain('type="message_pinned"');
      expect(result).toContain('message_id="42"');
      expect(result).toContain('>pinned content</event>');
    });

    it('renders message_pinned event without preview as self-closing', () => {
      const event: ICSystemEvent = {
        type: 'system_event',
        kind: 'message_pinned',
        receivedAtMs: 1000,
        timestampSec: 1741761000,
        utcOffsetMin: 480,
        actor: alice,
        messageId: '42',
      };
      const result = xml(render(ic([event])));
      expect(result).toContain('message_id="42"/>');
      expect(result).not.toContain('</event>');
    });

  });

  describe('viewport filtering', () => {
    it('skips nodes before compactCursorMs', () => {
      const rc = render(
        ic([
          message({ receivedAtMs: 1000 }),
          message({ messageId: '43', receivedAtMs: 3000, timestampSec: 1741776660 }),
        ]),
        { compactCursorMs: 2000 },
      );
      expect(rc).toHaveLength(1);
      expect(rc[0]!.receivedAtMs).toBe(3000);
    });

    it('includes nodes at exactly compactCursorMs', () => {
      const rc = render(
        ic([message({ receivedAtMs: 2000 })]),
        { compactCursorMs: 2000 },
      );
      expect(rc).toHaveLength(1);
    });
  });
});
