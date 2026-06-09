import { useState, useRef } from "react";
import { invoke } from "../lib/invoke";
import { Message, Mode } from "../types";
import { STRINGS } from "../constants/strings";

export function useChat(
  mode: Mode,
  onAddMessage: (msg: Omit<Message, "id" | "timestamp">) => void,
) {
  const [isLoading, setIsLoadingState] = useState(false);
  const [pendingQueue, setPendingQueueState] = useState<string[]>([]);

  // Refs keep closure-safe copies for use inside async callbacks.
  const isLoadingRef = useRef(false);
  const pendingRef = useRef<string[]>([]);

  function setIsLoading(v: boolean) {
    isLoadingRef.current = v;
    setIsLoadingState(v);
  }

  function setPendingQueue(q: string[]) {
    pendingRef.current = q;
    setPendingQueueState(q);
  }

  function removeFromQueue(index: number) {
    setPendingQueue(pendingRef.current.filter((_, i) => i !== index));
  }

  async function _sendDirect(text: string): Promise<void> {
    onAddMessage({ role: "user", content: text });
    setIsLoading(true);

    const prefix = (STRINGS.modePrefixes as Partial<Record<Mode, string>>)[mode] ?? "";
    const prompt = prefix ? `${prefix}${text}` : text;

    try {
      const answer = await invoke<string>("run_ask_sensei", { prompt });
      onAddMessage({ role: "assistant", content: answer });
    } catch (err) {
      onAddMessage({ role: "error", content: String(err) });
    }

    // Chain to next queued item without flickering isLoading to false between sends.
    const next = pendingRef.current[0];
    if (next !== undefined) {
      setPendingQueue(pendingRef.current.slice(1));
      await _sendDirect(next);
    } else {
      setIsLoading(false);
    }
  }

  function sendMessage(text: string) {
    if (isLoadingRef.current) {
      setPendingQueue([...pendingRef.current, text]);
    } else {
      void _sendDirect(text);
    }
  }

  return { isLoading, sendMessage, pendingQueue, removeFromQueue };
}
