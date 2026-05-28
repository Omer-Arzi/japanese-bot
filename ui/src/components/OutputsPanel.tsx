import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { GeneratedFile } from "../types";
import { STRINGS } from "../constants/strings";

interface Props {
  files: GeneratedFile[];
}

export default function OutputsPanel({ files }: Props) {
  const [selected, setSelected] = useState<number | null>(null);

  const s = STRINGS.outputs;

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center">
        <p className="text-4xl mb-3">{s.emptyState.icon}</p>
        <p className="text-sm font-medium text-jp-muted dark:text-gray-500">{s.emptyState.title}</p>
        <p className="text-xs text-jp-faint dark:text-gray-600 mt-1">{s.emptyState.description}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="w-64 border-r border-jp-border dark:border-gray-800 overflow-y-auto flex-shrink-0">
        {files.map((file, i) => (
          <button
            key={i}
            onClick={() => setSelected(i)}
            className={`w-full text-left px-4 py-3 border-b border-jp-border dark:border-gray-800 transition-colors hover:bg-jp-surface dark:hover:bg-gray-800 ${
              selected === i ? "bg-jp-surface dark:bg-gray-800 border-l-2 border-l-jp-accent dark:border-l-indigo-500" : ""
            }`}
          >
            <p className="text-xs text-jp-text dark:text-gray-300 font-medium line-clamp-2 leading-snug">
              {file.prompt}
            </p>
            {file.filePath && (
              <p className="text-[10px] text-green-600 dark:text-green-500 font-mono mt-1 truncate">
                {file.filePath}
              </p>
            )}
            <p className="text-[10px] text-jp-faint dark:text-gray-600 mt-0.5">
              {file.timestamp.toLocaleDateString()} ·{" "}
              {file.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </p>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {selected === null ? (
          <div className="h-full flex items-center justify-center text-jp-faint dark:text-gray-600 text-sm">
            {s.selectFileHint}
          </div>
        ) : (
          <div className="prose dark:prose-invert prose-sm max-w-none">
            <ReactMarkdown>{files[selected]!.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
