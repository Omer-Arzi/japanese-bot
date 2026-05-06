import { SidebarView } from "../types";

interface Props {
  view: SidebarView;
  onViewChange: (v: SidebarView) => void;
}

const NAV_ITEMS: { id: SidebarView; label: string; icon: string }[] = [
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "generate", label: "Generate File", icon: "📄" },
  { id: "outputs", label: "Outputs", icon: "📁" },
];

export default function Sidebar({ view, onViewChange }: Props) {
  return (
    <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col py-4 gap-1 px-2 flex-shrink-0">
      <div className="px-3 py-2 mb-2">
        <h1 className="text-base font-bold text-white">🎌 Japanese Sensei</h1>
        <p className="text-xs text-gray-500 mt-0.5">Local AI Tutor</p>
      </div>

      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          onClick={() => onViewChange(item.id)}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left w-full ${
            view === item.id
              ? "bg-indigo-600 text-white"
              : "text-gray-400 hover:bg-gray-800 hover:text-white"
          }`}
        >
          <span className="text-base">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </aside>
  );
}
