import type { RenderedContentPiece } from '../rendering/types';

// Model-view Rendered Context (RC), derived from base rendering records.
// One segment per IC node. Carries receivedAtMs from the source event for merge ordering.
// Driver merges RC + TRs by timestamp, grouping consecutive segments between TRs
// into user messages.
export interface RenderedContextSegment {
  readonly receivedAtMs: number;
  readonly content: readonly RenderedContentPiece[];
  // Sender's user id. Used by the Driver debounce to anchor the wait to the
  // "trigger sender" (only their further messages extend the window). Absent for
  // system/runtime-event segments that have no sender.
  readonly senderId?: string;
  // Sender is this bot account (used by Driver debounce to ignore bot's own messages
  // when deciding whether new external input arrived). True for all messages from this
  // bot regardless of origin — including messages sent by other programs controlling
  // the same bot account.
  readonly isMyself?: boolean;
  // Message originated from this bot instance's send_message tool call (used by
  // trimSelfMessagesCoveredBySendToolCalls to deduplicate — these messages already
  // exist as tool results in TRs). A message can be isMyself without isSelfSent
  // if another program sent it through the same bot account.
  readonly isSelfSent?: boolean;
  // Content contains a <mention> node targeting this bot's userId
  readonly mentionsMe?: boolean;
  // Reply-to target is a message sent by this bot
  readonly repliesToMe?: boolean;
  // Segment is a runtime event (e.g. background task completion). Runtime events
  // wake scheduling but still pass through the mandatory probe gate.
  readonly isRuntimeEvent?: boolean;
}

export type RenderedContext = readonly RenderedContextSegment[];
