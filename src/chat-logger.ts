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
  isFollowUp?: boolean;
  previousTurnId?: string;
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

// Short, context-dependent phrases that signal a follow-up question.
const FOLLOWUP_PATTERNS = [
  /^why\??\s*$/i,
  /^how\s+so\??\s*$/i,
  /^what\s+do\s+you\s+mean\??\s*$/i,
  /^why\s+lesson\s+\d+/i,
  /^why\s+(those|these|them|that)\b/i,
  /^what\s+about\s+\w/i,
  /^and\s+(why|how|what)\b/i,
  /^can\s+you\s+explain\s+(that|why|more)\b/i,
  /^(so|but)\s+why\b/i,
];

// "Why is/do/does/are/..." is ambiguous: could be a short follow-up ("Why is that?")
// or a full standalone grammar question ("Why do we say Sushi ga suki desu?").
// Only treat it as a follow-up if it is short enough to be a contextual question.
const WHY_VERB_PATTERN = /^why\s+(not|is|are|was|were|did|do|does)\b/i;
const WHY_VERB_MAX_LEN = 28;

// Japanese characters anywhere in the question signal a standalone grammar question.
const JAPANESE_CHARS = /[぀-ヿ一-鿿]/;

export function isOllamaOfflineError(message: string): boolean {
  return OFFLINE_PATTERNS.some((p) => p.test(message));
}

export function detectFollowUp(question: string): boolean {
  const trimmed = question.trim();
  if (trimmed.length > 120) return false;
  // Questions containing Japanese text are always standalone grammar questions.
  if (JAPANESE_CHARS.test(trimmed)) return false;
  if (FOLLOWUP_PATTERNS.some((p) => p.test(trimmed))) return true;
  // "Why is/do/does/are..." only counts as a follow-up when short enough to be contextual.
  return WHY_VERB_PATTERN.test(trimmed) && trimmed.length <= WHY_VERB_MAX_LEN;
}

export function getLastEntry(): ChatLogEntry | null {
  try {
    if (!fs.existsSync(LOG_PATH)) return null;
    const entries = JSON.parse(fs.readFileSync(LOG_PATH, "utf-8")) as ChatLogEntry[];
    return entries.length > 0 ? (entries[entries.length - 1] ?? null) : null;
  } catch {
    return null;
  }
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
