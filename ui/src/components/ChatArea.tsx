import { useRef, useEffect } from "react";
import { Message, Mode } from "../types";
import MessageBubble from "./MessageBubble";
import InputBar from "./InputBar";
import ModeSelector from "./ModeSelector";
import { useChat } from "../hooks/useChat";
import { STRINGS } from "../constants/strings";

interface Props {
  messages: Message[];
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onAddMessage: (msg: Omit<Message, "id" | "timestamp">) => void;
}

export default function ChatArea({ messages, mode, onModeChange, onAddMessage }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { isLoading, sendMessage, pendingQueue, removeFromQueue } = useChat(mode, onAddMessage);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const s = STRINGS.chat;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-jp-border dark:border-gray-800 bg-jp-bg dark:bg-gray-950 flex items-center justify-between gap-4 flex-shrink-0">
        <h2 className="text-sm font-semibold text-jp-muted dark:text-gray-300 whitespace-nowrap">
          {s.heading}
        </h2>
        <ModeSelector mode={mode} onChange={onModeChange} />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full text-center pb-16">
            <p className="text-5xl mb-4">{s.emptyState.icon}</p>
            <p className="text-base font-semibold text-jp-muted dark:text-gray-400">
              {s.emptyState.title}
            </p>
            <p className="text-sm text-jp-faint dark:text-gray-600 mt-2 max-w-sm">
              {s.emptyState.description}
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isLoading && (
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-full bg-jp-accent dark:bg-indigo-700 flex items-center justify-center text-xs flex-shrink-0">
              {s.loadingAvatar}
            </div>
            <div className="bg-jp-surface dark:bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3">
              <span className="flex gap-1 text-jp-faint dark:text-gray-400">
                <span className="animate-bounce [animation-delay:0ms]">●</span>
                <span className="animate-bounce [animation-delay:150ms]">●</span>
                <span className="animate-bounce [animation-delay:300ms]">●</span>
              </span>
            </div>
          </div>
        )}
      </div>

      <InputBar
        onSend={sendMessage}
        isLoading={isLoading}
        pendingQueue={pendingQueue}
        onRemoveQueued={removeFromQueue}
        history={messages.filter((m) => m.role === "user").map((m) => m.content).reverse()}
      />
    </div>
  );
}
