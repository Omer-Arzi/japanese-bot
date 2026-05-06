import { useState } from "react";
import { invoke } from "../lib/invoke";
import { Message, Mode } from "../types";

const MODE_PREFIXES: Partial<Record<Mode, string>> = {
  explain: "explain ",
  correct: "is this correct: ",
  analyze: "break down: ",
  practice: "practice ",
};

export function useChat(
  mode: Mode,
  onAddMessage: (msg: Omit<Message, "id" | "timestamp">) => void,
) {
  const [isLoading, setIsLoading] = useState(false);

  async function sendMessage(text: string) {
    onAddMessage({ role: "user", content: text });
    setIsLoading(true);

    const prefix = MODE_PREFIXES[mode] ?? "";
    const prompt = prefix ? `${prefix}${text}` : text;

    try {
      const answer = await invoke<string>("run_ask_sensei", { prompt });
      onAddMessage({ role: "assistant", content: answer });
    } catch (err) {
      onAddMessage({ role: "error", content: String(err) });
    } finally {
      setIsLoading(false);
    }
  }

  return { isLoading, sendMessage };
}
