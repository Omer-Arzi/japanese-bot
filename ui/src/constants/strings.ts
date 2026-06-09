import { Mode } from "../types";

export const STRINGS = {
  app: {
    notInTauri: {
      icon: "⚠️",
      title: "Not running inside Tauri",
      body: "This page is open in a plain browser. The AI backend won't work here. Open the desktop app instead:",
      command: "npm run tauri:dev",
      hint: "If the command ran but no window appeared, check the terminal for Rust compile errors.",
    },
  },

  sidebar: {
    title: "🎌 Japanese Sensei",
    subtitle: "Local AI Tutor",
    theme: {
      dark: "🌙 Dark",
      light: "🌸 Light",
    },
    nav: {
      chat: { label: "Chat", icon: "💬" },
      generate: { label: "Generate File", icon: "📄" },
      outputs: { label: "Outputs", icon: "📁" },
    },
    clearHistory: {
      button: "🗑 Clear history",
      confirm: "Clear all history?",
      yes: "Yes",
      no: "No",
    },
  },

  chat: {
    heading: "Grammar Chat",
    emptyState: {
      icon: "🎌",
      title: "Japanese Sensei",
      description: "Ask a grammar question, request a correction, or have a sentence analyzed.",
    },
    loadingAvatar: "🎌",
  },

  inputBar: {
    placeholder: "Ask a question... (Enter to send, Shift+Enter for newline)",
    sendButton: "Send",
    queueButton: "+",
    loadingIndicator: "●●●",
    queueLabel: "Queued questions",
  },

  modes: {
    auto:     "Auto",
    explain:  "Explain",
    correct:  "Correct",
    analyze:  "Analyze",
    practice: "Practice",
  } satisfies Record<Mode, string>,

  modePrefixes: {
    explain:  "explain ",
    correct:  "is this correct: ",
    analyze:  "break down: ",
    practice: "practice ",
  } satisfies Partial<Record<Mode, string>>,

  fileGenerator: {
    heading:           "Generate File",
    subheading:        "Creates worksheets, workbooks, and exercise files",
    promptLabel:       "Prompt",
    promptPlaceholder: 'e.g. "Create a beginner workbook for lesson 3"',
    generateButton:    "Generate",
    generatingButton:  "Generating… (this may take a minute)",
    savedToLabel:      "Saved to: ",
    previewHeading:    "Preview",
    suggestions: [
      "Create a beginner vocabulary worksheet for lesson 3",
      "Generate a comprehensive workbook on particles は, が, を",
      "Make a hiragana practice drill (easy)",
      "Generate a grammar worksheet on て-form verbs",
    ],
  },

  outputs: {
    emptyState: {
      icon:        "📁",
      title:       "No outputs yet",
      description: "Generated files will appear here.",
    },
    selectFileHint: "Select a file to preview",
  },

  errors: {
    notInTauri:
      "Not running inside the Tauri window.\n" +
      "Start the app with:\n  npm run tauri:dev\n\n" +
      "Do not open localhost:5173 directly in a browser.",
  },
};
