import { useState } from "react";
import { invoke } from "../lib/invoke";
import { Message, Mode } from "../types";
import { STRINGS } from "../constants/strings";

export function useChat(
  mode: Mode,
  onAddMessage: (msg: Omit<Message, "id" | "timestamp">) => void,
) {
  const [isLoading, setIsLoading] = useState(false);

  async function sendMessage(text: string) {
    onAddMessage({ role: "user", content: text });
    setIsLoading(true);

    const prefix = (STRINGS.modePrefixes as Partial<Record<Mode, string>>)[mode] ?? "";
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
