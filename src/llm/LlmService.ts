import { loadConfig } from "./config";
import { OllamaProvider } from "./providers/OllamaProvider";
import { VllmProvider } from "./providers/VllmProvider";
import type { LlmProvider, ChatMessage, ChatOptions } from "./types";

export type { ChatMessage, ChatOptions };

let provider: LlmProvider | null = null;

async function getProvider(): Promise<LlmProvider> {
  if (provider) return provider;

  const cfg = await loadConfig();

  if (cfg.provider === "vllm") {
    provider = new VllmProvider(cfg.baseUrl, cfg.model, cfg.embedModel, cfg.apiKey);
  } else {
    provider = new OllamaProvider(cfg.baseUrl, cfg.model, cfg.embedModel);
  }

  return provider;
}

export const llm = {
  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    return (await getProvider()).chat(messages, options);
  },

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string> {
    yield* (await getProvider()).chatStream(messages, options);
  },

  async embed(text: string): Promise<number[]> {
    return (await getProvider()).embed(text);
  },

  async healthCheck(): Promise<void> {
    return (await getProvider()).healthCheck();
  },
};
