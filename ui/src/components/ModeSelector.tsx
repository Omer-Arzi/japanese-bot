import { Mode } from "../types";
import { STRINGS } from "../constants/strings";

interface Props {
  mode: Mode;
  onChange: (m: Mode) => void;
}

const MODES: Mode[] = ["auto", "explain", "correct", "analyze", "practice"];

export default function ModeSelector({ mode, onChange }: Props) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {MODES.map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
            mode === m
              ? "bg-jp-accent dark:bg-indigo-600 text-white"
              : "bg-jp-surface dark:bg-gray-800 text-jp-muted dark:text-gray-400 hover:bg-jp-surface-2 dark:hover:bg-gray-700 hover:text-jp-text dark:hover:text-white"
          }`}
        >
          {STRINGS.modes[m]}
        </button>
      ))}
    </div>
  );
}
