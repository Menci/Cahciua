import { describe, expect, it } from 'vitest';

import { reduce } from './reduce';
import type { ICMessage, ICUserRenamedEvent } from './types';
import { createEmptyIC } from './types';
import type {
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalMessageEvent,
  CanonicalServiceEvent,
  CanonicalUser,
  ContentNode,
} from '../adaptation/types';

const alice: CanonicalUser = { id: '1', displayName: 'Alice', username: 'alice', isBot: false };
const bob: CanonicalUser = { id: '2', displayName: 'Bob', isBot: false };
const content: ContentNode[] = [{ type: 'text', text: 'hello' }];

const msg = (overrides: Partial<CanonicalMessageEvent> = {}): CanonicalMessageEvent => ({
  type: 'message',
  chatId: 'chat1',
  messageId: '1',
  sender: alice,
  receivedAtMs: 1000,
  timestampSec: 1,
  utcOffsetMin: 480,
  content,
  attachments: [],
  ...overrides,
});

const edit = (overrides: Partial<CanonicalEditEvent> = {}): CanonicalEditEvent => ({
  type: 'edit',
  chatId: 'chat1',
  messageId: '1',
  sender: alice,
  receivedAtMs: 2000,
  timestampSec: 2,
  utcOffsetMin: 480,
  content: [{ type: 'text', text: 'edited' }],
  attachments: [],
  ...overrides,
});

const del = (overrides: Partial<CanonicalDeleteEvent> = {}): CanonicalDeleteEvent => ({
  type: 'delete',
  chatId: 'chat1',
  messageIds: ['1'],
  receivedAtMs: 3000,
  timestampSec: 3,
  utcOffsetMin: 480,
  ...overrides,
});

describe('reduce', () => {
  describe('message events', () => {
    it('appends ICMessage and initializes user state', () => {
      const ic = reduce(createEmptyIC('chat1'), msg());

      expect(ic.nodes).toHaveLength(1);
      const node = ic.nodes[0] as ICMessage;
      expect(node.type).toBe('message');
      expect(node.messageId).toBe('1');
      expect(node.sender).toEqual(alice);
      expect(node.content).toEqual(content);
      expect(node.utcOffsetMin).toBe(480);

      const userState = ic.users.get('1');
      expect(userState).toBeDefined();
      expect(userState!.user).toEqual(alice);
      expect(userState!.firstSeenAtMs).toBe(1000);
      expect(userState!.lastSeenAtMs).toBe(1000);
      expect(userState!.messageCount).toBe(1);
    });

    it('updates lastSeenAtMs and messageCount on repeated messages', () => {
      let ic = reduce(createEmptyIC('chat1'), msg());
      ic = reduce(ic, msg({ messageId: '2', receivedAtMs: 2000, timestampSec: 2 }));

      expect(ic.nodes).toHaveLength(2);
      const userState = ic.users.get('1')!;
      expect(userState.firstSeenAtMs).toBe(1000);
      expect(userState.lastSeenAtMs).toBe(2000);
      expect(userState.messageCount).toBe(2);
    });

    it('sets replyToMessageId and forwardInfo when present', () => {
      const ic = reduce(createEmptyIC('chat1'), msg({
        replyToMessageId: '99',
        forwardInfo: { senderName: 'Someone', date: 100 },
      }));

      const node = ic.nodes[0] as ICMessage;
      expect(node.replyToMessageId).toBe('99');
      expect(node.forwardInfo).toEqual({ senderName: 'Someone', date: 100 });
    });

    it('snapshots reply target sender and preview', () => {
      let ic = reduce(createEmptyIC('chat1'), msg());
      ic = reduce(ic, msg({
        messageId: '2',
        sender: bob,
        receivedAtMs: 2000,
        timestampSec: 2,
        replyToMessageId: '1',
      }));

      const reply = ic.nodes[1] as ICMessage;
      expect(reply.replyToMessageId).toBe('1');
      expect(reply.replyToSender).toEqual(alice);
      expect(reply.replyToPreview).toBe('hello');
    });

    it('omits replyToSender/Preview when target not found', () => {
      const ic = reduce(createEmptyIC('chat1'), msg({
        replyToMessageId: '999',
      }));

      const node = ic.nodes[0] as ICMessage;
      expect(node.replyToMessageId).toBe('999');
      expect(node.replyToSender).toBeUndefined();
      expect(node.replyToPreview).toBeUndefined();
    });

    it('truncates long reply preview', () => {
      const longText = 'a'.repeat(200);
      let ic = reduce(createEmptyIC('chat1'), msg({
        content: [{ type: 'text', text: longText }],
      }));
      ic = reduce(ic, msg({
        messageId: '2',
        sender: bob,
        receivedAtMs: 2000,
        timestampSec: 2,
        replyToMessageId: '1',
      }));

      const reply = ic.nodes[1] as ICMessage;
      expect(reply.replyToPreview).toHaveLength(101); // 100 chars + "…"
      expect(reply.replyToPreview!.endsWith('…')).toBe(true);
    });

    it('keeps messages without sender (e.g. channel posts)', () => {
      const ic = reduce(createEmptyIC('chat1'), msg({ sender: undefined }));
      expect(ic.nodes).toHaveLength(1);
      expect((ic.nodes[0] as ICMessage).sender).toBeUndefined();
      expect(ic.users.size).toBe(0);
    });
  });

  describe('MetaReducer — user rename detection', () => {
    it('inserts ICUserRenamedEvent when displayName changes', () => {
      const renamedAlice: CanonicalUser = { id: '1', displayName: 'Alice New', username: 'alice', isBot: false };
      let ic = reduce(createEmptyIC('chat1'), msg());
      ic = reduce(ic, msg({ messageId: '2', receivedAtMs: 2000, timestampSec: 2, sender: renamedAlice }));

      expect(ic.nodes).toHaveLength(3);
      expect(ic.nodes[0]!.type).toBe('message');
      expect(ic.nodes[1]!.type).toBe('system_event');
      if (ic.nodes[1]!.type !== 'system_event') throw new Error('expected system_event');
      expect((ic.nodes[1] as ICUserRenamedEvent).utcOffsetMin).toBe(480);
      expect(ic.nodes[2]!.type).toBe('message');

      const sysEvent = ic.nodes[1]!;
      if (sysEvent.type !== 'system_event') throw new Error('expected system_event');
      expect(sysEvent.kind).toBe('user_renamed');
      if (sysEvent.kind !== 'user_renamed') throw new Error('expected user_renamed');
      expect(sysEvent.oldUser).toEqual(alice);
      expect(sysEvent.newUser).toEqual(renamedAlice);
    });

    it('inserts ICUserRenamedEvent when username changes', () => {
      const renamedAlice: CanonicalUser = { id: '1', displayName: 'Alice', username: 'alice_new', isBot: false };
      let ic = reduce(createEmptyIC('chat1'), msg());
      ic = reduce(ic, msg({ messageId: '2', receivedAtMs: 2000, timestampSec: 2, sender: renamedAlice }));

      expect(ic.nodes).toHaveLength(3);
      expect(ic.nodes[1]!.type).toBe('system_event');
    });

    it('does not emit system event when user info unchanged', () => {
      let ic = reduce(createEmptyIC('chat1'), msg());
      ic = reduce(ic, msg({ messageId: '2', receivedAtMs: 2000, timestampSec: 2 }));

      expect(ic.nodes).toHaveLength(2);
      expect(ic.nodes.every(n => n.type === 'message')).toBe(true);
    });

    it('treats undefined and null username as equivalent', () => {
      const noUsername: CanonicalUser = { id: '1', displayName: 'Alice', isBot: false };
      const nullUsername: CanonicalUser = { id: '1', displayName: 'Alice', username: undefined, isBot: false };
      let ic = reduce(createEmptyIC('chat1'), msg({ sender: noUsername }));
      ic = reduce(ic, msg({ messageId: '2', receivedAtMs: 2000, timestampSec: 2, sender: nullUsername }));

      expect(ic.nodes).toHaveLength(2);
      expect(ic.nodes.every(n => n.type === 'message')).toBe(true);
    });
  });

  describe('edit events', () => {
    it('updates content, attachments, and sets editedAtSec on existing message', () => {
      let ic = reduce(createEmptyIC('chat1'), msg());
      ic = reduce(ic, edit());

      expect(ic.nodes).toHaveLength(1);
      const node = ic.nodes[0] as ICMessage;
      expect(node.content).toEqual([{ type: 'text', text: 'edited' }]);
      expect(node.editedAtSec).toBe(2);
      expect(node.editUtcOffsetMin).toBe(480);
    });

    it('is a no-op when target message not found', () => {
      const ic = reduce(createEmptyIC('chat1'), edit({ messageId: '999' }));
      expect(ic.nodes).toHaveLength(0);
    });
  });

  describe('delete events', () => {
    it('sets deleted flag on existing message', () => {
      let ic = reduce(createEmptyIC('chat1'), msg());
      ic = reduce(ic, del());

      const node = ic.nodes[0] as ICMessage;
      expect(node.deleted).toBe(true);
    });

    it('handles multiple messageIds', () => {
      let ic = reduce(createEmptyIC('chat1'), msg());
      ic = reduce(ic, msg({ messageId: '2', sender: bob, receivedAtMs: 2000, timestampSec: 2 }));
      ic = reduce(ic, del({ messageIds: ['1', '2'] }));

      expect((ic.nodes[0] as ICMessage).deleted).toBe(true);
      expect((ic.nodes[1] as ICMessage).deleted).toBe(true);
    });

    it('is a no-op when target message not found', () => {
      const ic = reduce(createEmptyIC('chat1'), del({ messageIds: ['999'] }));
      expect(ic.nodes).toHaveLength(0);
    });
  });

  describe('immutability', () => {
    it('does not mutate the original IC', () => {
      const original = createEmptyIC('chat1');
      const after = reduce(original, msg());

      expect(original.nodes).toHaveLength(0);
      expect(original.users.size).toBe(0);
      expect(after.nodes).toHaveLength(1);
      expect(after.users.size).toBe(1);
    });
  });

  describe('service events', () => {
    const service = (overrides: Partial<CanonicalServiceEvent>): CanonicalServiceEvent => ({
      type: 'service',
      chatId: 'chat1',
      receivedAtMs: 5000,
      timestampSec: 5,
      utcOffsetMin: 480,
      actor: alice,
      ...overrides,
      action: (overrides as any).action ?? { action: 'chat_photo_changed' },
    });

    it('pushes ICMembersJoinedEvent', () => {
      const ic = reduce(createEmptyIC('chat1'), service({
        action: { action: 'members_joined', members: [alice, bob] },
      }));
      expect(ic.nodes).toHaveLength(1);
      const node = ic.nodes[0]!;
      expect(node.type).toBe('system_event');
      if (node.type === 'system_event') {
        expect(node.kind).toBe('members_joined');
        if (node.kind === 'members_joined') {
          expect(node.members).toEqual([alice, bob]);
          expect(node.actor).toEqual(alice);
        }
      }
    });

    it('pushes ICMemberLeftEvent', () => {
      const ic = reduce(createEmptyIC('chat1'), service({
        action: { action: 'member_left', member: bob },
      }));
      const node = ic.nodes[0]!;
      if (node.type === 'system_event' && node.kind === 'member_left')
        expect(node.member).toEqual(bob);
    });

    it('pushes ICChatRenamedEvent with oldTitle tracking', () => {
      let ic = reduce(createEmptyIC('chat1'), service({
        action: { action: 'chat_renamed', newTitle: 'First Name' },
        receivedAtMs: 1000,
      }));

      // First rename: oldTitle should be null
      const firstNode = ic.nodes[0]!;
      if (firstNode.type === 'system_event' && firstNode.kind === 'chat_renamed') {
        expect(firstNode.oldTitle).toBeNull();
        expect(firstNode.newTitle).toBe('First Name');
      }
      expect(ic.chatTitle).toBe('First Name');

      // Second rename: oldTitle should be "First Name"
      ic = reduce(ic, service({
        action: { action: 'chat_renamed', newTitle: 'Second Name' },
        receivedAtMs: 2000,
      }));
      const secondNode = ic.nodes[1]!;
      if (secondNode.type === 'system_event' && secondNode.kind === 'chat_renamed') {
        expect(secondNode.oldTitle).toBe('First Name');
        expect(secondNode.newTitle).toBe('Second Name');
      }
      expect(ic.chatTitle).toBe('Second Name');
    });

    it('pushes ICChatPhotoChangedEvent', () => {
      const ic = reduce(createEmptyIC('chat1'), service({
        action: { action: 'chat_photo_changed' },
      }));
      const node = ic.nodes[0]!;
      expect(node.type).toBe('system_event');
      if (node.type === 'system_event')
        expect(node.kind).toBe('chat_photo_changed');
    });

    it('pushes ICChatPhotoDeletedEvent', () => {
      const ic = reduce(createEmptyIC('chat1'), service({
        action: { action: 'chat_photo_deleted' },
      }));
      const node = ic.nodes[0]!;
      if (node.type === 'system_event')
        expect(node.kind).toBe('chat_photo_deleted');
    });

    it('pushes ICMessagePinnedEvent with preview snapshot', () => {
      let ic = reduce(createEmptyIC('chat1'), msg());
      ic = reduce(ic, service({
        action: { action: 'message_pinned', messageId: '1' },
      }));

      const node = ic.nodes[1]!;
      if (node.type === 'system_event' && node.kind === 'message_pinned') {
        expect(node.messageId).toBe('1');
        expect(node.preview).toBe('hello');
      }
    });

    it('pushes ICMessagePinnedEvent without preview when target not found', () => {
      const ic = reduce(createEmptyIC('chat1'), service({
        action: { action: 'message_pinned', messageId: '999' },
      }));
      const node = ic.nodes[0]!;
      if (node.type === 'system_event' && node.kind === 'message_pinned') {
        expect(node.messageId).toBe('999');
        expect(node.preview).toBeUndefined();
      }
    });

  });
});
