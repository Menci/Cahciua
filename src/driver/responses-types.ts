// OpenAI Responses API type definitions

// ── Request types ──

export interface ResponsesPayload {
  model: string;
  input: string | ResponseInputItem[];
  instructions: string | null;
  temperature: number | null;
  top_p: number | null;
  max_output_tokens: number | null;
  tools: ResponseTool[] | null;
  tool_choice: ResponseToolChoice;
  stream: boolean | null;
  store: boolean;
  parallel_tool_calls: boolean;
  reasoning?: {
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'none' | 'minimal';
    summary: 'detailed' | 'auto' | 'concise';
  };
  include?: string[];
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseInputReasoning;

export interface ResponseInputMessage {
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponseInputContent[];
}

export type ResponseInputContent =
  | ResponseInputText
  | ResponseInputImage;

export interface ResponseInputText {
  type: 'input_text' | 'output_text';
  text: string;
}

export interface ResponseInputImage {
  type: 'input_image';
  image_url: string;
  detail: 'auto' | 'low' | 'high';
}

export interface ResponseInputReasoning {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
  encrypted_content: string;
}

export interface ResponseFunctionToolCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed' | 'in_progress' | 'incomplete';
}

export interface ResponseFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string | ResponseInputContent[];
  status?: 'completed' | 'incomplete';
  requiresFollowUp?: boolean;
}

export interface ResponseTool {
  type: 'function';
  name: string;
  parameters: Record<string, unknown>;
  strict: boolean;
  description?: string;
}

export type ResponseToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string };

// ── Response types ──

export interface ResponsesResult {
  id: string;
  object: string;
  model: string;
  output: ResponseOutputItem[];
  output_text: string;
  status: 'completed' | 'incomplete' | 'failed' | 'in_progress';
  incomplete_details?: { reason: string };
  error?: { message: string; type: string; code: string };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens: number };
    output_tokens_details?: { reasoning_tokens: number };
  };
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputFunctionCall
  | ResponseOutputReasoning;

export interface ResponseOutputMessage {
  type: 'message';
  role: 'assistant';
  content: ResponseOutputContentBlock[];
}

export type ResponseOutputContentBlock =
  | ResponseOutputText
  | ResponseOutputRefusal;

export interface ResponseOutputText {
  type: 'output_text';
  text: string;
}

export interface ResponseOutputRefusal {
  type: 'refusal';
  refusal: string;
}

export interface ResponseOutputFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status: string;
}

export interface ResponseOutputReasoning {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
  encrypted_content?: string;
}
