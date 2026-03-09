export interface SessionState {
  systemPrompt: string;
  compactionSummary?: string;
  lateBindingContext?: string;
}

export interface RenderedMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type RenderedOutput = RenderedMessage[];
