import { Ollama } from "ollama";
import type { LlmProvider, ChatMessage, ChatOptions } from "../types";

export class OllamaProvider implements LlmProvider {
  private client: Ollama;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly embedModel: string,
  ) {
    // Strip /v1 suffix — Ollama native API does not use it
    const host = baseUrl.replace(/\/v1\/?$/, "");
    this.client = new Ollama({ host });
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
}
