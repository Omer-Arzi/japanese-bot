export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
}

export interface LlmProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string>;
  embed(text: string): Promise<number[]>;
}

export interface LlmConfig {
  provider: "ollama" | "vllm";
  baseUrl: string;
  model: string;
  embedModel: string;
  apiKey?: string | undefined;
}
