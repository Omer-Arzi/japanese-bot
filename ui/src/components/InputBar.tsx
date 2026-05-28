import { useState, useRef, useLayoutEffect, KeyboardEvent, ChangeEvent } from "react";
import { STRINGS } from "../constants/strings";

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  // User message history passed in from parent, ordered newest-first.
  // ArrowUp walks toward index 0 (newest), ArrowDown walks back toward draft.
  history?: string[];
}

export default function InputBar({ onSend, disabled, placeholder, history = [] }: Props) {
  const [text, setText] = useState("");

  // -1 = not in history mode (showing live draft or empty input)
  // 0  = most recent user message
  // n  = oldest user message in history
  const [historyIndex, setHistoryIndex] = useState(-1);

  // The unsent text the user had typed before pressing ArrowUp.
  // Restored when ArrowDown is pressed past the newest history entry.
  const [draft, setDraft] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // After a history navigation sets new text, move the cursor to the end.
  // useLayoutEffect runs synchronously after the DOM is updated, preventing
  // any visible cursor flicker to position 0.
  const moveCursorToEndRef = useRef(false);
  useLayoutEffect(() => {
    if (moveCursorToEndRef.current && textareaRef.current) {
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
      moveCursorToEndRef.current = false;
    }
  });

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    // Reset everything — next ArrowUp will show the message we just sent
    // (it will have been added to history by the parent by the next render).
    setText("");
    setHistoryIndex(-1);
    setDraft("");
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    // If the user types anything while browsing history, exit history mode.
    // We do NOT restore the draft here — the user is now editing a modified
    // copy of the history entry they were viewing.
    if (historyIndex !== -1) {
      setHistoryIndex(-1);
      setDraft("");
    }
    setText(e.target.value);
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter-to-send — unchanged, Shift+Enter inserts a newline as usual.
    // Skip when IME is composing (Japanese input candidate selection).
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      handleSend();
      return;
    }

    // ── History navigation ──────────────────────────────────────────────────
    // Also skip during IME composition (ArrowUp/Down selects candidates).
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (e.nativeEvent.isComposing) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    if (e.key === "ArrowUp") {
      // Only intercept ArrowUp when the cursor is on the very first line.
      // If it's on a lower line, let the browser move the cursor normally.
      const textBeforeCursor = textarea.value.slice(0, textarea.selectionStart);
      if (textBeforeCursor.includes("\n")) return;

      if (history.length === 0) return;

      const nextIndex = historyIndex === -1 ? 0 : historyIndex + 1;
      if (nextIndex >= history.length) return; // Already at the oldest entry

      // Save whatever the user had typed before entering history mode.
      if (historyIndex === -1) setDraft(text);

      e.preventDefault(); // Prevent cursor from jumping to start of line
      setHistoryIndex(nextIndex);
      setText(history[nextIndex]!);
      moveCursorToEndRef.current = true;

    } else {
      // ArrowDown: only active while in history mode.
      if (historyIndex === -1) return; // Not in history mode; let browser handle

      // Only intercept when the cursor is on the very last line.
      const textAfterCursor = textarea.value.slice(textarea.selectionEnd);
      if (textAfterCursor.includes("\n")) return;

      e.preventDefault();

      if (historyIndex === 0) {
        // We were at the newest message — step back to the saved draft.
        setHistoryIndex(-1);
        setText(draft);
        moveCursorToEndRef.current = true;
      } else {
        // Move forward toward the newest entry.
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        setText(history[nextIndex]!);
        moveCursorToEndRef.current = true;
      }
    }
  }

  const s = STRINGS.inputBar;

  return (
    <div className="flex gap-2 items-end p-4 border-t border-jp-border dark:border-gray-800 bg-jp-bg dark:bg-gray-950">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKey}
        disabled={disabled}
        placeholder={placeholder ?? s.placeholder}
        rows={2}
        className="flex-1 bg-white dark:bg-gray-800 border border-jp-border dark:border-gray-700 rounded-xl px-4 py-3 text-sm text-jp-text dark:text-gray-100 placeholder-jp-faint dark:placeholder-gray-500 resize-none focus:outline-none focus:border-jp-accent dark:focus:border-indigo-500 transition-colors disabled:opacity-50"
      />
      <button
        onClick={handleSend}
        disabled={disabled || !text.trim()}
        className="px-4 py-3 bg-jp-accent dark:bg-indigo-600 hover:bg-jp-accent-hover dark:hover:bg-indigo-500 disabled:bg-jp-surface-2 dark:disabled:bg-gray-700 disabled:text-jp-faint dark:disabled:text-gray-500 text-white rounded-xl text-sm font-medium transition-colors flex-shrink-0 h-[52px]"
      >
        {disabled ? s.loadingIndicator : s.sendButton}
      </button>
    </div>
  );
}
