import * as fs from "fs";
import * as path from "path";
import { critiqueOne, formatReport, type EvalResult } from "./critic";
import type { ChatLogEntry } from "../chat-logger";

const PROJECT_DIR = path.join(__dirname, "..", "..");
const LOG_PATH    = path.join(PROJECT_DIR, "logs", "recent-chat-runs.json");
const OUT_DIR     = path.join(PROJECT_DIR, "evals", "runs", "latest");
const REPORT_PATH = path.join(OUT_DIR, "recent_chat_critic_report.md");

function toEvalResult(entry: ChatLogEntry, index: number): EvalResult {
  return {
    id: `recent-${index + 1}`,
    topic: entry.mode ?? "general",
    question: entry.question,
    answer: entry.answer,
    retrievedChunks: (entry.retrievedChunks ?? []) as unknown[],
    timestamp: entry.timestamp,
    durationMs: entry.durationMs,
    ...(entry.error ? { error: entry.error } : {}),
  };
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

  console.log(`Running critic on ${entries.length} recent chat interaction(s)...`);

  const evalResults = entries.map(toEvalResult);
  const reports = evalResults.map(critiqueOne);

  const runTimestamp = entries[0]?.timestamp ?? new Date().toISOString();
  let report = formatReport(reports, runTimestamp);

  // Retitle the report header so it's clearly for recent chats
  report = report.replace(
    "# Sensei Eval — Critic Report",
    "# Recent Chat — Critic Report",
  );
  report = report.replace(
    "Source: evals/runs/latest/answers.json",
    "Source: logs/recent-chat-runs.json",
  );

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  fs.writeFileSync(REPORT_PATH, report, "utf-8");

  const passed = reports.filter((r) => r.status === "PASS").length;
  console.log(`Result: ${passed}/${reports.length} passed`);
  console.log(`Report saved to: ${REPORT_PATH}`);
}

main();
