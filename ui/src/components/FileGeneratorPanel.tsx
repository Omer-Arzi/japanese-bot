import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { GeneratedFile } from "../types";
import { useFileGen } from "../hooks/useFileGen";
import { STRINGS } from "../constants/strings";

interface Props {
  onFileGenerated: (file: Omit<GeneratedFile, "timestamp">) => void;
}

export default function FileGeneratorPanel({ onFileGenerated }: Props) {
  const [prompt, setPrompt] = useState("");
  const [lastResult, setLastResult] = useState<Omit<GeneratedFile, "timestamp"> | null>(null);
  const { isLoading, error, generate } = useFileGen();

  async function handleGenerate() {
    if (!prompt.trim() || isLoading) return;
    const res = await generate(prompt.trim());
    if (res) {
      const file: Omit<GeneratedFile, "timestamp"> = {
        prompt: prompt.trim(),
        content: res.output,
        filePath: res.file_path,
      };
      setLastResult(file);
      onFileGenerated(file);
    }
  }

  const s = STRINGS.fileGenerator;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-jp-border dark:border-gray-800 flex-shrink-0">
        <h2 className="text-sm font-semibold text-jp-muted dark:text-gray-300">{s.heading}</h2>
        <p className="text-xs text-jp-faint dark:text-gray-500 mt-0.5">{s.subheading}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-2xl mx-auto space-y-4">
          <div>
            <label className="block text-xs font-medium text-jp-muted dark:text-gray-400 mb-2">
              {s.promptLabel}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isLoading}
              placeholder={s.promptPlaceholder}
              rows={3}
              className="w-full bg-white dark:bg-gray-800 border border-jp-border dark:border-gray-700 rounded-xl px-4 py-3 text-sm text-jp-text dark:text-gray-100 placeholder-jp-faint dark:placeholder-gray-500 resize-none focus:outline-none focus:border-jp-accent dark:focus:border-indigo-500 transition-colors disabled:opacity-50"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {s.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => setPrompt(suggestion)}
                disabled={isLoading}
                className="text-xs px-3 py-1.5 bg-jp-surface dark:bg-gray-800 hover:bg-jp-surface-2 dark:hover:bg-gray-700 text-jp-muted dark:text-gray-400 hover:text-jp-text dark:hover:text-white rounded-lg transition-colors disabled:opacity-40"
              >
                {suggestion}
              </button>
            ))}
          </div>

          <button
            onClick={handleGenerate}
            disabled={isLoading || !prompt.trim()}
            className="w-full py-3 bg-jp-accent dark:bg-indigo-600 hover:bg-jp-accent-hover dark:hover:bg-indigo-500 disabled:bg-jp-surface-2 dark:disabled:bg-gray-700 disabled:text-jp-faint dark:disabled:text-gray-500 text-white rounded-xl text-sm font-medium transition-colors"
          >
            {isLoading ? s.generatingButton : s.generateButton}
          </button>

          {error && (
            <div className="p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-800 rounded-xl text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap">
              {error}
            </div>
          )}

          {lastResult && (
            <div className="space-y-3">
              {lastResult.filePath && (
                <div className="p-3 bg-jp-surface dark:bg-gray-800 border border-jp-border dark:border-gray-700 rounded-xl text-xs">
                  <span className="text-jp-faint dark:text-gray-500">{s.savedToLabel}</span>
                  <span className="text-green-600 dark:text-green-400 font-mono">{lastResult.filePath}</span>
                </div>
              )}
              <div className="bg-jp-surface dark:bg-gray-800 border border-jp-border dark:border-gray-700 rounded-xl p-4">
                <p className="text-[10px] font-medium text-jp-faint dark:text-gray-500 uppercase tracking-wide mb-3">
                  {s.previewHeading}
                </p>
                <div className="prose dark:prose-invert prose-sm max-w-none">
                  <ReactMarkdown>{lastResult.content}</ReactMarkdown>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
