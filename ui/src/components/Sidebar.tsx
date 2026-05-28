import { useState } from "react";
import { SidebarView } from "../types";
import { Theme } from "../App";
import { STRINGS } from "../constants/strings";

interface Props {
  view: SidebarView;
  onViewChange: (v: SidebarView) => void;
  onClearHistory: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const isDark = theme === "dark";
  return (
    <button
      onClick={onToggle}
      className="w-full px-3 py-2 rounded-lg flex items-center gap-2 text-xs text-jp-muted dark:text-gray-400 hover:bg-jp-surface-2 dark:hover:bg-gray-800 transition-colors"
    >
      <span>{isDark ? STRINGS.sidebar.theme.dark : STRINGS.sidebar.theme.light}</span>
      <div className={`relative w-9 h-5 rounded-full transition-colors ${isDark ? "bg-indigo-600" : "bg-jp-accent"}`}>
        <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${isDark ? "translate-x-4" : "translate-x-0.5"}`} />
      </div>
    </button>
  );
}

const NAV_ITEMS: { id: SidebarView; label: string; icon: string }[] = [
  { id: "chat",     ...STRINGS.sidebar.nav.chat     },
  { id: "generate", ...STRINGS.sidebar.nav.generate },
  { id: "outputs",  ...STRINGS.sidebar.nav.outputs  },
];

export default function Sidebar({ view, onViewChange, onClearHistory, theme, onToggleTheme }: Props) {
  const [confirming, setConfirming] = useState(false);

  function handleClearClick() { setConfirming(true); }
  function handleConfirm()    { setConfirming(false); onClearHistory(); }
  function handleCancel()     { setConfirming(false); }

  const s = STRINGS.sidebar;

  return (
    <aside className="w-56 bg-jp-surface dark:bg-gray-900 border-r border-jp-border dark:border-gray-800 flex flex-col py-4 gap-1 px-2 flex-shrink-0">
      <div className="px-3 py-2 mb-2">
        <h1 className="text-base font-bold text-jp-text dark:text-white">{s.title}</h1>
        <p className="text-xs text-jp-muted dark:text-gray-500 mt-0.5">{s.subtitle}</p>
      </div>

      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          onClick={() => onViewChange(item.id)}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left w-full ${
            view === item.id
              ? "bg-jp-accent dark:bg-indigo-600 text-white"
              : "text-jp-muted dark:text-gray-400 hover:bg-jp-surface-2 dark:hover:bg-gray-800 hover:text-jp-text dark:hover:text-white"
          }`}
        >
          <span className="text-base">{item.icon}</span>
          {item.label}
        </button>
      ))}

      <div className="mt-auto pt-4 border-t border-jp-border dark:border-gray-800 mx-1 space-y-1">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        {confirming ? (
          <div className="px-3 py-2 space-y-2">
            <p className="text-xs text-jp-muted dark:text-gray-400">{s.clearHistory.confirm}</p>
            <div className="flex gap-2">
              <button
                onClick={handleConfirm}
                className="flex-1 px-2 py-1 rounded-md text-xs bg-jp-accent dark:bg-red-600 hover:bg-jp-accent-hover dark:hover:bg-red-500 text-white transition-colors"
              >
                {s.clearHistory.yes}
              </button>
              <button
                onClick={handleCancel}
                className="flex-1 px-2 py-1 rounded-md text-xs bg-jp-surface-2 dark:bg-gray-700 hover:bg-jp-border dark:hover:bg-gray-600 text-jp-text dark:text-gray-200 transition-colors"
              >
                {s.clearHistory.no}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={handleClearClick}
            className="w-full px-3 py-2 rounded-lg text-xs text-jp-faint dark:text-gray-600 hover:text-jp-accent dark:hover:text-red-400 hover:bg-jp-surface-2 dark:hover:bg-gray-800 transition-colors text-left"
          >
            {s.clearHistory.button}
          </button>
        )}
      </div>
    </aside>
  );
}
