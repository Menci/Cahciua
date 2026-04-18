import type { Sharp } from 'sharp';

/**
 * Unified IR invariants (hold across all producers and consumers):
 *
 * - `ConversationEntry` is `Message | ToolResult`, discriminated by `kind`.
 *   `Message` is further discriminated by `role`: `system`/`user` → `InputMessage`,
 *   `assistant` → `OutputMessage`.
 * - System messages carry only `TextPart`; images/tools on `role: 'system'`
 *   are invalid and rejected at emit time (`assertSystemTextOnly`).
 * - `ToolResult` is a user-side entry — it never appears in `from-*Output`
 *   responses. Historical decoding of stored tool results lives in `migrations.ts`.
 * - `ToolCallPart.args` is the raw wire JSON string. Only the Anthropic emitter
 *   boundary parses it (falling back to `{}` on invalid JSON, since Anthropic's
 *   schema requires an object `input`).
 * - `Extra<S>` is source-tagged: an emitter applies `extra.fields` only when
 *   `extra.source` matches its own target format; otherwise the fields are
 *   dropped. `Extra` lives on model-output nodes only — never on client-authored
 *   `InputMessage` / `ToolResult`.
 * - Reasoning has two carriers: block-level `ReasoningPart` (Responses,
 *   Anthropic, Chat content-part variants) and message-level `MessageReasoning`
 *   (Chat Completions string aliases). Emitters for Chat / Anthropic normalize
 *   opaque-only reasoning to `redacted_thinking` so cross-format round-trip
 *   stays symmetric.
 */

export type ExtraSource = 'openaiChatCompletion' | 'openaiResponses' | 'anthropicMessages';

/** Source-tagged container of provider-specific unknown fields. See IR invariants above. */
export type Extra<S extends ExtraSource = ExtraSource> = {
  readonly source: S;
  readonly fields: Record<string, unknown>;
};

export interface ThinkingData {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingData {
  type: 'redacted_thinking';
  data: string;
}

export interface ResponsesReasoningData {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
  encrypted_content?: string;
}

export type ReasoningData =
  | { source: 'openaiChatCompletion'; data: ThinkingData | RedactedThinkingData }
  | { source: 'openaiResponses'; data: ResponsesReasoningData }
  | { source: 'anthropicMessages'; data: ThinkingData | RedactedThinkingData };

/** Only Chat Completions produces message-level reasoning. Field aliases vary. */
export interface MessageReasoning {
  reasoning_content?: string;
  reasoning?: string;
  reasoning_text?: string;
  reasoning_opaque?: string;
}

export interface TextPart {
  kind: 'text';
  text: string;
  /** `true` marks Responses `refusal` blocks so round-trip preserves the block type. */
  refusal?: true;
  extra?: Extra;
}

export interface ImagePart {
  kind: 'image';
  image: Sharp;
  detail: 'high' | 'low' | undefined;
}

export interface ToolCallPart {
  kind: 'toolCall';
  callId: string;
  name: string;
  /** Raw JSON string from the wire. Anthropic input is stringified at the boundary;
   *  emission back to Anthropic parses and falls back to `{}` on invalid JSON. */
  args: string;
  extra?: Extra;
}

export interface ReasoningPart {
  kind: 'reasoning';
  data: ReasoningData;
  extra?: Extra;
}

/**
 * A Responses `message` item's text blocks, preserved as a group so the item
 * boundary (and its id/status/etc. in `extra`) survives round-trip. Chat and
 * Anthropic don't emit this; cross-format conversion flattens to TextPart[].
 */
export interface TextGroupPart {
  kind: 'textGroup';
  content: TextPart[];
  extra?: Extra<'openaiResponses'>;
}

export type InputPart = TextPart | ImagePart;

export type OutputPart = TextPart | ToolCallPart | ReasoningPart | TextGroupPart;

export interface InputMessage {
  kind: 'message';
  role: 'system' | 'user';
  parts: InputPart[];
}

export interface OutputMessage {
  kind: 'message';
  role: 'assistant';
  parts: OutputPart[];
  reasoning: MessageReasoning | undefined;
  extra?: Extra;
}

export type Message = InputMessage | OutputMessage;

export interface ToolResult {
  kind: 'toolResult';
  callId: string;
  payload: string | InputPart[];
  requiresFollowUp: boolean;
}

export type ConversationEntry = Message | ToolResult;
