export interface RenderParams {
  compactCursorMs?: number;
  botUserId?: string;
  contactNames?: Map<string, string>;
  // Users whose messages should render as a self-closing `<message blocked="true"/>`
  // with no content. Sender info is kept so the model can see who was blocked.
  // Blocked messages also suppress `mentionsMe` / `repliesToMe`, so they can't
  // trick the bot into responding. Lookup is per-chat, computed lazily at render
  // time — so toggling a user in/out of the block list takes effect on next
  // re-render (e.g. after restart). Nothing is filtered at ingress or in storage.
  blockedUserIds?: ReadonlySet<string>;
}

import type { Sharp } from 'sharp';

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
  // Segment is a runtime event (e.g. background task completion). These bypass
  // the probe gate — the bot always responds to runtime notifications.
  isRuntimeEvent?: boolean;
}

export type RenderedContext = RenderedContextSegment[];
