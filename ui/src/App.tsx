import { useState, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import ChatArea from "./components/ChatArea";
import FileGeneratorPanel from "./components/FileGeneratorPanel";
import OutputsPanel from "./components/OutputsPanel";
import { SidebarView, Message, GeneratedFile, Mode } from "./types";
import { isTauri } from "./lib/invoke";
import { loadMessages, saveMessages, loadFiles, saveFiles, clearStorage } from "./lib/storage";
import { STRINGS } from "./constants/strings";

export type Theme = "dark" | "light";

function loadTheme(): Theme {
  const stored = localStorage.getItem("theme");
  return stored === "light" || stored === "dark" ? stored : "dark";
}

export default function App() {
  const [view, setView] = useState<SidebarView>("chat");
  const [messages, setMessages] = useState<Message[]>(() => loadMessages());
  const [files, setFiles] = useState<GeneratedFile[]>(() => loadFiles());
  const [mode, setMode] = useState<Mode>("auto");
  const [theme, setTheme] = useState<Theme>(loadTheme);

  useEffect(() => { saveMessages(messages); }, [messages]);
  useEffect(() => { saveFiles(files); }, [files]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem("theme", theme);
  }, [theme]);

  function toggleTheme() { setTheme((t) => (t === "dark" ? "light" : "dark")); }

  function addMessage(msg: Omit<Message, "id" | "timestamp">) {
    setMessages((prev) => [...prev, { ...msg, id: crypto.randomUUID(), timestamp: new Date() }]);
  }

  function addFile(file: Omit<GeneratedFile, "timestamp">) {
    setFiles((prev) => [{ ...file, timestamp: new Date() }, ...prev]);
  }

  function clearHistory() {
    clearStorage();
    setMessages([]);
    setFiles([]);
  }

  const s = STRINGS.app.notInTauri;

  if (!isTauri()) {
    return (
      <div className="flex h-screen bg-jp-bg dark:bg-gray-950 text-jp-text dark:text-gray-100 items-center justify-center p-8">
        <div className="max-w-md text-center space-y-4">
          <p className="text-4xl">{s.icon}</p>
          <p className="text-lg font-semibold text-yellow-600 dark:text-yellow-400">{s.title}</p>
          <p className="text-sm text-jp-muted dark:text-gray-400 leading-relaxed">{s.body}</p>
          <pre className="bg-jp-surface dark:bg-gray-900 border border-jp-border dark:border-gray-700 rounded-xl px-4 py-3 text-sm text-jp-accent dark:text-green-400 text-left">
            {s.command}
          </pre>
          <p className="text-xs text-jp-faint dark:text-gray-600">{s.hint}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-jp-bg dark:bg-gray-950 text-jp-text dark:text-gray-100 overflow-hidden">
      <Sidebar
        view={view}
        onViewChange={setView}
        onClearHistory={clearHistory}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        {view === "chat"     && <ChatArea messages={messages} mode={mode} onModeChange={setMode} onAddMessage={addMessage} />}
        {view === "generate" && <FileGeneratorPanel onFileGenerated={addFile} />}
        {view === "outputs"  && <OutputsPanel files={files} />}
      </main>
    </div>
  );
}
