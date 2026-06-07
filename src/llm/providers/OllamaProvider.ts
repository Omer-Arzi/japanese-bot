import { Ollama } from "ollama";
import type { LlmProvider, ChatMessage, ChatOptions } from "../types";

export class OllamaProvider implements LlmProvider {
  private client: Ollama;
  private readonly host: string;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly embedModel: string,
  ) {
    // Strip /v1 suffix — Ollama native API does not use it
    this.host = baseUrl.replace(/\/v1\/?$/, "");
    this.client = new Ollama({ host: this.host });
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const response = await this.client.chat({
      model: options?.model ?? this.model,
      messages,
    });
    return response.message.content;
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string> {
    const stream = await this.client.chat({
      model: options?.model ?? this.model,
      messages,
      stream: true,
    });
    for await (const part of stream) {
      if (part.message.content) yield part.message.content;
    }
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embed({ model: this.embedModel, input: text });
    return response.embeddings[0]!;
  }

  async healthCheck(): Promise<void> {
    const url = `${this.host.replace(/\/$/, "")}/api/tags`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND")) {
        throw new Error(
          `Ollama is not running.\n  Start it with: ollama serve\n  Expected at: ${this.host}`,
        );
      }
      throw err;
    }
  }
}
