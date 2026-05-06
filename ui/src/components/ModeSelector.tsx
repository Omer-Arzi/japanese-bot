import { Mode } from "../types";

interface Props {
  mode: Mode;
  onChange: (m: Mode) => void;
}

const MODES: { id: Mode; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "explain", label: "Explain" },
  { id: "correct", label: "Correct" },
  { id: "analyze", label: "Analyze" },
  { id: "practice", label: "Practice" },
];

export default function ModeSelector({ mode, onChange }: Props) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {MODES.map((m) => (
        <button
          key={m.id}
          onClick={() => onChange(m.id)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
            mode === m.id
              ? "bg-indigo-600 text-white"
              : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white"
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
