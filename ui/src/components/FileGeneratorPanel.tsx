import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { GeneratedFile } from "../types";
import { useFileGen } from "../hooks/useFileGen";

interface Props {
  onFileGenerated: (file: Omit<GeneratedFile, "timestamp">) => void;
}

const SUGGESTIONS = [
  "Create a beginner vocabulary worksheet for lesson 3",
  "Generate a comprehensive workbook on particles は, が, を",
  "Make a hiragana practice drill (easy)",
  "Generate a grammar worksheet on て-form verbs",
];

export default function FileGeneratorPanel({ onFileGenerated }: Props) {
  const [prompt, setPrompt] = useState("");
  const [lastResult, setLastResult] = useState<Omit<
    GeneratedFile,
    "timestamp"
  > | null>(null);
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

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-800 flex-shrink-0">
        <h2 className="text-sm font-semibold text-gray-300">Generate File</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Creates worksheets, workbooks, and exercise files
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-2xl mx-auto space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-2">
              Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isLoading}
              placeholder='e.g. "Create a beginner workbook for lesson 3"'
              rows={3}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-indigo-500 transition-colors disabled:opacity-50"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setPrompt(s)}
                disabled={isLoading}
                className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>

          <button
            onClick={handleGenerate}
            disabled={isLoading || !prompt.trim()}
            className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-xl text-sm font-medium transition-colors"
          >
            {isLoading ? "Generating… (this may take a minute)" : "Generate"}
          </button>

          {error && (
            <div className="p-3 bg-red-900/30 border border-red-800 rounded-xl text-sm text-red-300 whitespace-pre-wrap">
              {error}
            </div>
          )}

          {lastResult && (
            <div className="space-y-3">
              {lastResult.filePath && (
                <div className="p-3 bg-gray-800 border border-gray-700 rounded-xl text-xs">
                  <span className="text-gray-500">Saved to: </span>
                  <span className="text-green-400 font-mono">
                    {lastResult.filePath}
                  </span>
                </div>
              )}
              <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
                <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-3">
                  Preview
                </p>
                <div className="prose prose-invert prose-sm max-w-none">
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
