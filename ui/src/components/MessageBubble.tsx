import ReactMarkdown from "react-markdown";
import { Message } from "../types";

interface Props {
  message: Message;
}

const HEBREW_RE = /[א-ת]/;

function dir(text: string): "rtl" | "ltr" {
  return HEBREW_RE.test(text) ? "rtl" : "ltr";
}

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";
  const isError = message.role === "error";
  const textDir = dir(message.content);

  return (
    <div className={`flex mb-4 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-jp-accent dark:bg-indigo-700 flex items-center justify-center text-xs mr-2 mt-1 flex-shrink-0">
          🎌
        </div>
      )}

      <div
        className={`max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? "bg-jp-accent dark:bg-indigo-600 text-white rounded-br-sm"
            : isError
            ? "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border border-red-300 dark:border-red-800 rounded-bl-sm"
            : "bg-jp-surface dark:bg-gray-800 text-jp-text dark:text-gray-100 border border-jp-border dark:border-transparent rounded-bl-sm"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap" dir={textDir}>
            {message.content}
          </p>
        ) : (
          <div
            className="prose dark:prose-invert prose-sm max-w-none"
            dir={textDir}
          >
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}
        <p
          className={`text-[10px] mt-1.5 ${
            isUser ? "text-red-200 dark:text-indigo-300 text-right" : "text-jp-faint dark:text-gray-500"
          }`}
        >
          {message.timestamp.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
    </div>
  );
}
