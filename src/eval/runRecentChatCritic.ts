import * as fs from "fs";
import * as path from "path";
import { critiqueOne, formatReport, makeSkipReport, type EvalResult, type QuestionReport } from "./critic";
import type { ChatLogEntry } from "../chat-logger";

const PROJECT_DIR = path.join(__dirname, "..", "..");
const LOG_PATH    = path.join(PROJECT_DIR, "logs", "recent-chat-runs.json");
const OUT_DIR     = path.join(PROJECT_DIR, "evals", "runs", "latest");
const REPORT_PATH = path.join(OUT_DIR, "recent_chat_critic_report.md");

function toEvalResult(entry: ChatLogEntry, index: number, entries: ChatLogEntry[]): EvalResult {
  let previousTurn: { question: string; answer: string } | undefined;

  if (entry.isFollowUp && entry.previousTurnId) {
    const prev = entries.find((e) => e.timestamp === entry.previousTurnId);
    if (prev) {
      previousTurn = { question: prev.question, answer: prev.answer };
    }
  }

  return {
    id: `recent-${index + 1}`,
    topic: entry.mode ?? "general",
    question: entry.question,
    answer: entry.answer,
    retrievedChunks: (entry.retrievedChunks ?? []) as unknown[],
    timestamp: entry.timestamp,
    durationMs: entry.durationMs,
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.isFollowUp ? { type: "followup" as const } : {}),
    ...(previousTurn ? { previousTurn } : {}),
  };
}

function critiqueEntry(entry: ChatLogEntry, index: number, entries: ChatLogEntry[]): QuestionReport {
  const id    = `recent-${index + 1}`;
  const topic = entry.mode ?? "general";

  // Followup without resolvable previous context → SKIP instead of false FAIL
  if (entry.isFollowUp && entry.previousTurnId) {
    const prev = entries.find((e) => e.timestamp === entry.previousTurnId);
    if (!prev) {
      return makeSkipReport(
        id,
        topic,
        entry.question,
        `Follow-up question but previous turn (id=${entry.previousTurnId}) is no longer in the rolling log — cannot evaluate context-dependent checks`,
      );
    }
  } else if (entry.isFollowUp && !entry.previousTurnId) {
    return makeSkipReport(
      id,
      topic,
      entry.question,
      "Follow-up question detected but no previousTurnId was recorded — cannot evaluate context-dependent checks",
    );
  }

  return critiqueOne(toEvalResult(entry, index, entries));
}

function main(): void {
  if (!fs.existsSync(LOG_PATH)) {
    console.error("No recent chat log found:", LOG_PATH);
    console.error("Run the Tauri app or ask-sensei first to generate interactions.");
    process.exit(1);
  }

  let entries: ChatLogEntry[];
  try {
    entries = JSON.parse(fs.readFileSync(LOG_PATH, "utf-8")) as ChatLogEntry[];
  } catch (err) {
    console.error("Failed to parse log file:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (entries.length === 0) {
    console.error("Log file is empty — no interactions to critique.");
    process.exit(1);
  }

  const followupCount = entries.filter((e) => e.isFollowUp).length;
  console.log(`Running critic on ${entries.length} recent chat interaction(s)${followupCount > 0 ? ` (${followupCount} follow-up)` : ""}...`);

  const reports = entries.map((entry, i) => critiqueEntry(entry, i, entries));

  const runTimestamp = entries[0]?.timestamp ?? new Date().toISOString();
  let report = formatReport(reports, runTimestamp);

  // Retitle the report header so it's clearly for recent chats
  report = report
    .replace("# Sensei Eval — Critic Report", "# Recent Chat — Critic Report")
    .replace("Source: evals/runs/latest/answers.json", "Source: logs/recent-chat-runs.json");

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  fs.writeFileSync(REPORT_PATH, report, "utf-8");

  const passed  = reports.filter((r) => r.status === "PASS").length;
  const skipped = reports.filter((r) => r.status === "SKIP").length;
  console.log(`Result: ${passed}/${reports.length} passed${skipped > 0 ? `, ${skipped} skipped (needs context)` : ""}`);
  console.log(`Report saved to: ${REPORT_PATH}`);
}

main();
