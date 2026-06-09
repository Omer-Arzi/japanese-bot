import * as fs from "fs";
import * as path from "path";
import type { ChatLogEntry } from "../chat-logger";

const PROJECT_DIR   = path.join(__dirname, "..", "..");
const LOG_PATH      = path.join(PROJECT_DIR, "logs", "recent-chat-runs.json");
const OUT_DIR       = path.join(PROJECT_DIR, "evals", "runs", "latest");
const EXPORT_PATH   = path.join(OUT_DIR, "recent_for_claude.md");
const CRITIC_REPORT = path.join(OUT_DIR, "recent_chat_critic_report.md");

function formatEntry(entry: ChatLogEntry, index: number): string {
  const lines: string[] = [];

  lines.push(`## Interaction ${index + 1}`);
  lines.push("");
  lines.push(`**Timestamp:** ${entry.timestamp}`);
  if (entry.model || entry.provider) {
    lines.push(`**Model/Provider:** ${[entry.model, entry.provider].filter(Boolean).join(" / ")}`);
  }
  if (entry.mode || entry.intent) {
    lines.push(`**Detected mode:** ${[entry.mode, entry.intent].filter(Boolean).join(" | ")}`);
  }
  if (entry.topicIndexKey) {
    lines.push(`**Topic index key:** ${entry.topicIndexKey}`);
  }
  lines.push(`**Duration:** ${entry.durationMs}ms`);
  if (entry.error) {
    lines.push(`**Error:** ${entry.error}`);
  }
  lines.push("");

  lines.push("### Question");
  lines.push("");
  lines.push(entry.question);
  lines.push("");

  lines.push("### Answer");
  lines.push("");
  lines.push(entry.answer);
  lines.push("");

  if (entry.retrievedChunks && entry.retrievedChunks.length > 0) {
    lines.push("### Retrieved evidence");
    lines.push("");
    for (const chunk of entry.retrievedChunks) {
      const score = chunk.score !== undefined ? `  score=${chunk.score.toFixed(4)}` : "";
      lines.push(`- \`${chunk.id}\`  [${chunk.sourceType ?? "?"}]${score}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  return lines.join("\n");
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
    console.error("Log file is empty — no interactions to export.");
    process.exit(1);
  }

  const criticReportExists = fs.existsSync(CRITIC_REPORT);
  const criticSection = criticReportExists
    ? fs.readFileSync(CRITIC_REPORT, "utf-8")
    : null;

  const lines: string[] = [];

  lines.push("<!-- Claude Code: review these real user interactions and identify issues the rule-based critic missed. Do not edit files unless explicitly asked. -->");
  lines.push("");
  lines.push("# Recent Real User Interactions — Review for Claude Code");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: logs/recent-chat-runs.json  (${entries.length} interaction${entries.length !== 1 ? "s" : ""})`);
  lines.push(criticReportExists
    ? "Critic results: included below (run `npm run eval:recent` to refresh)"
    : "Critic results: not yet run — run `npm run eval:recent` to generate, then re-run this script");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Instructions");
  lines.push("");
  lines.push("Claude Code: review these real user interactions and identify issues the rule-based critic missed. Do not edit files unless explicitly asked.");
  lines.push("");
  lines.push("Focus on:");
  lines.push("- Incorrect Japanese grammar or vocabulary not caught by the rule-based checks");
  lines.push("- Misleading or confusing explanations");
  lines.push("- Answers that don't match the mode/intent (e.g., lookup gave a general explanation instead of a lesson reference)");
  lines.push("- Retrieved evidence that doesn't support the answer");
  lines.push("- Tone or pedagogy issues for beginner learners");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Interactions");
  lines.push("");

  for (const [i, entry] of entries.entries()) {
    lines.push(formatEntry(entry, i));
  }

  if (criticSection) {
    lines.push("---");
    lines.push("");
    lines.push("## Critic Report (rule-based checks)");
    lines.push("");
    lines.push(criticSection);
  }

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  fs.writeFileSync(EXPORT_PATH, lines.join("\n"), "utf-8");
  console.log(`Exported to: ${EXPORT_PATH}`);
  if (!criticReportExists) {
    console.log("Tip: run `npm run eval:recent` first, then re-run this script to include critic results.");
  }
}

main();
