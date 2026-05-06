import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { GeneratedFile } from "../types";

interface Props {
  files: GeneratedFile[];
}

export default function OutputsPanel({ files }: Props) {
  const [selected, setSelected] = useState<number | null>(null);

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center">
        <p className="text-4xl mb-3">📁</p>
        <p className="text-sm font-medium text-gray-500">No outputs yet</p>
        <p className="text-xs text-gray-600 mt-1">
          Generated files will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="w-64 border-r border-gray-800 overflow-y-auto flex-shrink-0">
        {files.map((file, i) => (
          <button
            key={i}
            onClick={() => setSelected(i)}
            className={`w-full text-left px-4 py-3 border-b border-gray-800 transition-colors hover:bg-gray-800 ${
              selected === i ? "bg-gray-800 border-l-2 border-l-indigo-500" : ""
            }`}
          >
            <p className="text-xs text-gray-300 font-medium line-clamp-2 leading-snug">
              {file.prompt}
            </p>
            {file.filePath && (
              <p className="text-[10px] text-green-500 font-mono mt-1 truncate">
                {file.filePath}
              </p>
            )}
            <p className="text-[10px] text-gray-600 mt-0.5">
              {file.timestamp.toLocaleDateString()} ·{" "}
              {file.timestamp.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {selected === null ? (
          <div className="h-full flex items-center justify-center text-gray-600 text-sm">
            Select a file to preview
          </div>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown>{files[selected]!.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
