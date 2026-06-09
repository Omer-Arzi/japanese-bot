import * as fs from "fs";
import * as path from "path";

const LOG_PATH = path.join(process.cwd(), "logs", "recent-chat-runs.json");
const MAX_ENTRIES = 10;
const DEBUG = process.env.DEBUG === "true" || process.env.NODE_ENV === "development";

export interface RetrievedChunkSummary {
  id: string;
  sourceType?: string;
  score?: number;
}

export interface ChatLogEntry {
  timestamp: string;
  question: string;
  answer: string;
  mode?: string;
  intent?: string;
  model?: string;
  provider?: string;
  retrievedChunks?: RetrievedChunkSummary[];
  topicIndexKey?: string;
  durationMs: number;
  error?: string;
}

// Patterns that indicate the LLM server was unreachable — skip logging these.
const OFFLINE_PATTERNS = [
  /ollama.*offline/i,
  /connection refused/i,
  /econnrefused/i,
  /failed to fetch/i,
  /llm server.*unreachable/i,
  /health.*check.*fail/i,
  /connect ECONNREFUSED/i,
  /socket hang up/i,
  /ENOTFOUND/i,
];

export function isOllamaOfflineError(message: string): boolean {
  return OFFLINE_PATTERNS.some((p) => p.test(message));
}

export function appendChatLog(entry: ChatLogEntry): void {
  try {
    const logsDir = path.dirname(LOG_PATH);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    let entries: ChatLogEntry[] = [];
    if (fs.existsSync(LOG_PATH)) {
      try {
        entries = JSON.parse(fs.readFileSync(LOG_PATH, "utf-8")) as ChatLogEntry[];
      } catch {
        entries = [];
      }
    }

    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(entries.length - MAX_ENTRIES);
    }

    fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2) + "\n", "utf-8");
  } catch (err) {
    if (DEBUG) {
      console.warn("[chat-logger] Failed to write log:", err instanceof Error ? err.message : String(err));
    }
  }
}
