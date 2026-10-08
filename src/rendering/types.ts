import type { Sharp } from 'sharp';

import type { CanonicalAttachment, CanonicalForwardInfo, CanonicalUser } from '../adaptation/types';

export interface RenderParams {
  botUserId?: string;
  contactNames?: Map<string, string>;
}

// Output range in one IC's chat, not an event-loading range or build progress.
// The start is inclusive, the end exclusive; omitted bounds are unbounded.
export interface RenderWindow {
  readonly fromReceivedAtMs?: number;
  readonly untilReceivedAtMs?: number;
}

export type RenderedContentPiece =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly image: Sharp };

export interface RenderedMetadata {
  readonly chatId: string;
  readonly receivedAtMs: number;
  readonly timestampSec: number;
  readonly utcOffsetMin: number;
}

export interface RenderedReplyMetadata {
  readonly messageId: string;
  readonly sender?: Readonly<CanonicalUser>;
  readonly preview?: string;
  readonly quoted: boolean;
}

export type RenderedForwardMetadata = Readonly<Omit<CanonicalForwardInfo, 'sender'>> & {
  readonly sender?: Readonly<CanonicalUser>;
};

// Archive-facing attachment metadata excludes image bytes and runtime handles.
export type RenderedAttachmentMetadata = Readonly<Pick<CanonicalAttachment,
  | 'type' | 'mimeType' | 'fileName' | 'width' | 'height' | 'duration'
  | 'animationHash' | 'stickerSetId' | 'stickerSetName' | 'format' | 'altText'
>>;

export interface RenderedMessageMetadata extends RenderedMetadata {
  readonly messageId: string;
  readonly sender?: Readonly<CanonicalUser>;
  readonly replyTo?: RenderedReplyMetadata;
  readonly forwardInfo?: RenderedForwardMetadata;
  readonly attachments: readonly RenderedAttachmentMetadata[];
  readonly editedAtSec?: number;
  readonly editUtcOffsetMin?: number;
  readonly deleted: boolean;
  readonly isSelfSent: boolean;
}

export interface RenderedMessageRecord {
  readonly kind: 'message';
  readonly metadata: RenderedMessageMetadata;
  // Host-internal full transcript, including deleted bodies and full reply snapshots.
  // Runtime presentation retains its existing preview/tombstone behavior.
  readonly transcript: {
    readonly text: string;
    readonly xml: string;
    readonly reply?: { readonly text: string; readonly xml: string };
  };
  // Rendering owns both XML forms; consumers own the visibility decision.
  readonly presentation: {
    readonly body: readonly RenderedContentPiece[];
    readonly blocked: readonly RenderedContentPiece[];
  };
  readonly activation: {
    readonly isMyself: boolean;
    readonly mentionsMe: boolean;
    readonly repliesToMe: boolean;
  };
}

export interface RenderedSystemRecord {
  readonly kind: 'system';
  readonly metadata: RenderedMetadata;
  readonly presentation: { readonly body: readonly RenderedContentPiece[] };
}

export interface RenderedRuntimeRecord {
  readonly kind: 'runtime';
  readonly metadata: RenderedMetadata & { readonly taskId: number; readonly taskType: string };
  readonly presentation: { readonly body: readonly RenderedContentPiece[] };
}

// IC nodes and cache revisions stay private to Rendering. These records have a
// distinct shape from Driver's model segments and cannot enter model consumers.
export type RenderedRecord = RenderedMessageRecord | RenderedSystemRecord | RenderedRuntimeRecord;
export type BaseRenderedContext = readonly RenderedRecord[];
