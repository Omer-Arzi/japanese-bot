import { useState } from "react";
import Sidebar from "./components/Sidebar";
import ChatArea from "./components/ChatArea";
import FileGeneratorPanel from "./components/FileGeneratorPanel";
import OutputsPanel from "./components/OutputsPanel";
import { SidebarView, Message, GeneratedFile, Mode } from "./types";
import { isTauri } from "./lib/invoke";

export default function App() {
  const [view, setView] = useState<SidebarView>("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [mode, setMode] = useState<Mode>("auto");

  function addMessage(msg: Omit<Message, "id" | "timestamp">) {
    setMessages((prev) => [
      ...prev,
      { ...msg, id: crypto.randomUUID(), timestamp: new Date() },
    ]);
  }

  function addFile(file: Omit<GeneratedFile, "timestamp">) {
    setFiles((prev) => [{ ...file, timestamp: new Date() }, ...prev]);
  }

  if (!isTauri()) {
    return (
      <div className="flex h-screen bg-gray-950 text-gray-100 items-center justify-center p-8">
        <div className="max-w-md text-center space-y-4">
          <p className="text-4xl">⚠️</p>
          <p className="text-lg font-semibold text-yellow-400">
            Not running inside Tauri
          </p>
          <p className="text-sm text-gray-400 leading-relaxed">
            This page is open in a plain browser. The AI backend won't work
            here. Open the desktop app instead:
          </p>
          <pre className="bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-green-400 text-left">
            npm run tauri:dev
          </pre>
          <p className="text-xs text-gray-600">
            If the command ran but no window appeared, check the terminal for
            Rust compile errors.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 overflow-hidden">
      <Sidebar view={view} onViewChange={setView} />
      <main className="flex-1 flex flex-col overflow-hidden">
        {view === "chat" && (
          <ChatArea
            messages={messages}
            mode={mode}
            onModeChange={setMode}
            onAddMessage={addMessage}
          />
        )}
        {view === "generate" && (
          <FileGeneratorPanel onFileGenerated={addFile} />
        )}
        {view === "outputs" && <OutputsPanel files={files} />}
      </main>
    </div>
  );
}
