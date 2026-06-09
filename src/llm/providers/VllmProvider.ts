import type { LlmProvider, ChatMessage, ChatOptions } from "../types";

interface OpenAiChatChunk {
  choices: Array<{ delta: { content?: string }; finish_reason: string | null }>;
}

interface OpenAiChatResponse {
  choices: Array<{ message: { content: string } }>;
}

interface OpenAiEmbedResponse {
  data: Array<{ embedding: number[] }>;
}

export class VllmProvider implements LlmProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly embedModel: string,
    private readonly apiKey?: string | undefined,
  ) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey ?? "none"}`,
    };
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: options?.model ?? this.model,
        messages,
        temperature: options?.temperature ?? 0.7,
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`vLLM chat failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as OpenAiChatResponse;
    return json.choices[0]!.message.content;
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: options?.model ?? this.model,
        messages,
        temperature: options?.temperature ?? 0.7,
        stream: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`vLLM stream failed: ${res.status} ${res.statusText}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const chunk = JSON.parse(data) as OpenAiChatChunk;
          const content = chunk.choices[0]?.delta.content;
          if (content) yield content;
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: this.embedModel, input: text }),
    });
    if (!res.ok) {
      throw new Error(`vLLM embed failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as OpenAiEmbedResponse;
    return json.data[0]!.embedding;
  }

  async healthCheck(): Promise<void> {
    const base = this.baseUrl.replace(/\/v1\/?$/, "");
    const url = `${base}/health`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND")) {
        throw new Error(
          `vLLM server is not running.\n  Expected at: ${this.baseUrl}`,
        );
      }
      throw err;
    }
  }
}
