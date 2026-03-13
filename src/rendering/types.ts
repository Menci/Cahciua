export interface RenderParams {
  compactCursorMs?: number;
  botUserId?: string;
  // TODO: Late-binding context (recalled memory, cross-session awareness, action directives)
  // will be injected at the end of the last user message. Exact fields TBD when implementing
  // the Driver layer. See docs/dcp-design.md §Rendering Parameters and §Cross-Session Interaction.
}

// Provider-agnostic content piece — maps to LLM API content parts.
// Driver converts to provider-specific format (OpenAI image_url / Anthropic base64 image).
export type RenderedContentPiece =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string };

// Rendered Context (RC) — the output of the Rendering layer.
// One segment per IC node. Carries receivedAtMs from the source event for merge ordering.
// Driver merges RC + TRs by timestamp, grouping consecutive segments between TRs
// into user messages.
export interface RenderedContextSegment {
  receivedAtMs: number;
  content: RenderedContentPiece[];
  isMyself?: boolean;
}

export type RenderedContext = RenderedContextSegment[];
