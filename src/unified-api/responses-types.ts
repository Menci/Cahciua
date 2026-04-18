// OpenAI Responses API wire format — shape of outbound input items / inbound output items.

import type { ResponsesInputContent } from './chat-types';

export type { ResponsesInputContent } from './chat-types';

export interface ResponsesOutputText {
  type: 'output_text';
  text: string;
  [key: string]: unknown;
}

export interface ResponsesOutputRefusal {
  type: 'refusal';
  refusal: string;
  [key: string]: unknown;
}

export type ResponsesOutputContentBlock = ResponsesOutputText | ResponsesOutputRefusal;

export interface ResponsesOutputMessage {
  type: 'message';
  role: string;
  content: ResponsesOutputContentBlock[];
  [key: string]: unknown;
}

export interface ResponsesOutputFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  [key: string]: unknown;
}

export interface ResponsesOutputReasoning {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
  encrypted_content?: string;
  [key: string]: unknown;
}

export interface ResponsesFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string | ResponsesInputContent[];
  [key: string]: unknown;
}

export type ResponsesDataItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesOutputReasoning
  | ResponsesFunctionCallOutput;

/** Subset of `ResponsesDataItem` that an assistant can produce (excludes client-authored `function_call_output`). */
export type ResponsesAssistantItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesOutputReasoning;
