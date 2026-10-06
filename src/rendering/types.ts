import type { Sharp } from 'sharp';

import type { ICNode } from '../projection/types';

export interface RenderParams {
  botUserId?: string;
  contactNames?: Map<string, string>;
}

// Provider-agnostic content piece — maps to LLM API content parts.
// Driver converts to provider-specific format at the wire boundary.
export type RenderedContentPiece =
  | { type: 'text'; text: string }
  | { type: 'image'; image: Sharp };

// Rendered Context (RC) — the output of the Rendering layer.
// One segment per IC node. Carries receivedAtMs from the source event for merge ordering.
// Driver merges RC + TRs by timestamp, grouping consecutive segments between TRs
// into user messages.
export interface RenderedContextSegment {
  receivedAtMs: number;
  content: RenderedContentPiece[];
  // Sender's user id. Used by the Driver debounce to anchor the wait to the
  // "trigger sender" (only their further messages extend the window). Absent for
  // system/runtime-event segments that have no sender.
  senderId?: string;
  // Sender is this bot account (used by Driver debounce to ignore bot's own messages
  // when deciding whether new external input arrived). True for all messages from this
  // bot regardless of origin — including messages sent by other programs controlling
  // the same bot account.
  isMyself?: boolean;
  // Message originated from this bot instance's send_message tool call (used by
  // trimSelfMessagesCoveredBySendToolCalls to deduplicate — these messages already
  // exist as tool results in TRs). A message can be isMyself without isSelfSent
  // if another program sent it through the same bot account.
  isSelfSent?: boolean;
  // Content contains a <mention> node targeting this bot's userId
  mentionsMe?: boolean;
  // Reply-to target is a message sent by this bot
  repliesToMe?: boolean;
  // Segment is a runtime event (e.g. background task completion). Runtime events
  // wake scheduling but still pass through the mandatory probe gate.
  isRuntimeEvent?: boolean;
}

export type RenderedContext = RenderedContextSegment[];

// Base records precede model-view policy and retain structured source identity.
// Sharp handles remain runtime-only; consumers must choose their own storage form.
export interface RenderedNode extends RenderedContextSegment {
  chatId: string;
  source: ICNode;
  blockedContent?: RenderedContentPiece[];
}

export type RenderedNodes = RenderedNode[];
