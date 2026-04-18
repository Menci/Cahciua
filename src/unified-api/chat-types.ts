// OpenAI Chat Completions wire format — shape of outbound requests / inbound responses.

export interface ChatCompletionsToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  [key: string]: unknown;
}

export interface ChatCompletionsContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ChatCompletionsAssistantMessage {
  role: 'assistant';
  content?: string | null | ChatCompletionsContentPart[];
  tool_calls?: ChatCompletionsToolCall[];
  [key: string]: unknown;
}

export interface ChatCompletionsToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string | ChatCompletionsContentPart[];
  [key: string]: unknown;
}

export type ChatCompletionsEntry = ChatCompletionsAssistantMessage | ChatCompletionsToolMessage;

// --- Responses input content (used by Responses API and shared helpers) ---

export interface ResponsesInputText {
  type: 'input_text' | 'output_text';
  text: string;
}

export interface ResponsesInputImage {
  type: 'input_image';
  image_url: string;
  detail: 'auto' | 'low' | 'high';
}

export type ResponsesInputContent = ResponsesInputText | ResponsesInputImage;
