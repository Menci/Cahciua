export interface MessagesTextBlock {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

export interface MessagesImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: `image/${string}`;
    data: string;
  } | {
    type: 'url';
    url: string;
  };
  [key: string]: unknown;
}

export interface MessagesToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MessagesToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | MessagesContentBlock[];
  is_error?: boolean;
  [key: string]: unknown;
}

export interface MessagesThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
  [key: string]: unknown;
}

export interface MessagesRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
  [key: string]: unknown;
}

export type MessagesUserContentBlock =
  | MessagesTextBlock
  | MessagesImageBlock
  | MessagesToolResultBlock;

export type MessagesAssistantContentBlock =
  | MessagesTextBlock
  | MessagesToolUseBlock
  | MessagesThinkingBlock
  | MessagesRedactedThinkingBlock;

export type MessagesContentBlock =
  | MessagesUserContentBlock
  | MessagesAssistantContentBlock;

export interface MessagesUserMessage {
  role: 'user';
  content: string | MessagesUserContentBlock[];
}

export interface MessagesAssistantMessage {
  role: 'assistant';
  content: string | MessagesAssistantContentBlock[];
}

export type MessagesMessage = MessagesUserMessage | MessagesAssistantMessage;

export interface MessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: MessagesAssistantContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}
