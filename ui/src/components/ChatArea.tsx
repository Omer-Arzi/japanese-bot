import { useRef, useEffect } from "react";
import { Message, Mode } from "../types";
import MessageBubble from "./MessageBubble";
import InputBar from "./InputBar";
import ModeSelector from "./ModeSelector";
import { useChat } from "../hooks/useChat";

interface Props {
  messages: Message[];
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onAddMessage: (msg: Omit<Message, "id" | "timestamp">) => void;
}

export default function ChatArea({
  messages,
  mode,
  onModeChange,
  onAddMessage,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { isLoading, sendMessage } = useChat(mode, onAddMessage);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-800 bg-gray-950 flex items-center justify-between gap-4 flex-shrink-0">
        <h2 className="text-sm font-semibold text-gray-300 whitespace-nowrap">
          Grammar Chat
        </h2>
        <ModeSelector mode={mode} onChange={onModeChange} />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full text-center pb-16">
            <p className="text-5xl mb-4">🎌</p>
            <p className="text-base font-semibold text-gray-400">
              Japanese Sensei
            </p>
            <p className="text-sm text-gray-600 mt-2 max-w-sm">
              Ask a grammar question, request a correction, or have a sentence
              analyzed.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isLoading && (
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-full bg-indigo-700 flex items-center justify-center text-xs flex-shrink-0">
              🎌
            </div>
            <div className="bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3">
              <span className="flex gap-1 text-gray-400">
                <span className="animate-bounce [animation-delay:0ms]">●</span>
                <span className="animate-bounce [animation-delay:150ms]">●</span>
                <span className="animate-bounce [animation-delay:300ms]">●</span>
              </span>
            </div>
          </div>
        )}
      </div>

      <InputBar onSend={sendMessage} disabled={isLoading} />
    </div>
  );
}
