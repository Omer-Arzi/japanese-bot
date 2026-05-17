import * as fs from "fs";
import * as path from "path";

const PROJECT_DIR = path.join(__dirname, "..", "..");
const REPORT_PATH = path.join(PROJECT_DIR, "evals", "runs", "latest", "critic_report.md");
const OUTPUT_PATH = path.join(PROJECT_DIR, "evals", "runs", "latest", "fix_tasks.md");

// ─── Types ────────────────────────────────────────────────────────────────────

interface CheckFinding {
  check: string;
  excerpt: string | undefined;
  detail: string | undefined;
  likelyCause: string | undefined;
  suggestedFix: string | undefined;
}

interface FailedQuestion {
  id: string;
  topic: string;
  question: string;
  findings: CheckFinding[];
}

// Groups multiple questions that share the same check + suggestedFix into one task.
interface FixTask {
  check: string;
  questions: Array<{ id: string; topic: string; question: string; excerpt: string | undefined }>;
  detail: string | undefined;
  likelyCause: string | undefined;
  suggestedFix: string | undefined;
}

// ─── Report metadata ──────────────────────────────────────────────────────────

function parseRunTimestamp(md: string): string | undefined {
  const m = md.match(/Run timestamp:\s*(\S+)/);
  return m?.[1];
}

// ─── Markdown parser ──────────────────────────────────────────────────────────

function parseFailedQuestions(md: string): FailedQuestion[] {
  const failed: FailedQuestion[] = [];

  // Each question section starts with "## " — split on that, skip the preamble block.
  const sections = md.split(/^## /m).slice(1);

  for (const section of sections) {
    const headerMatch = section.match(/^(q\d+) — ([\w-]+) — FAIL ❌/);
    if (!headerMatch) continue;

    const id = headerMatch[1]!;
    const topic = headerMatch[2]!;

    const questionMatch = section.match(/\*\*Question:\*\*\s*(.+)/);
    const question = questionMatch?.[1]?.trim() ?? "";

    const problemsIdx = section.indexOf("### Problems");
    if (problemsIdx === -1) continue;

    // Each check finding starts with "#### `check-name`"
    const findings: CheckFinding[] = [];
    const checkBlocks = section.slice(problemsIdx).split(/^#### /m).slice(1);

    for (const block of checkBlocks) {
      const checkMatch = block.match(/^`([^`]+)`/);
      if (!checkMatch) continue;

      findings.push({
        check: checkMatch[1]!,
        excerpt:     block.match(/\*\*Excerpt:\*\*\s*(.+)/)?.[1]?.trim(),
        detail:      block.match(/\*\*Detail:\*\*\s*(.+)/)?.[1]?.trim(),
        likelyCause: block.match(/\*\*Likely cause:\*\*\s*(.+)/)?.[1]?.trim(),
        suggestedFix: block.match(/\*\*Suggested fix:\*\*\s*(.+)/)?.[1]?.trim(),
      });
    }

    if (findings.length > 0) {
      failed.push({ id, topic, question, findings });
    }
  }

  return failed;
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

// Group findings by check type. When multiple questions share the same check,
// they are merged into one task so the fix prompt covers all affected questions.
function groupIntoTasks(questions: FailedQuestion[]): FixTask[] {
  const byCheck = new Map<string, FixTask>();

  for (const q of questions) {
    for (const f of q.findings) {
      const existing = byCheck.get(f.check);
      const entry = {
        id: q.id,
        topic: q.topic,
        question: q.question,
        excerpt: f.excerpt,
      };

      if (existing) {
        existing.questions.push(entry);
        // Prefer the most detailed version of these fields when merging.
        existing.detail       ??= f.detail;
        existing.likelyCause  ??= f.likelyCause;
        existing.suggestedFix ??= f.suggestedFix;
      } else {
        byCheck.set(f.check, {
          check: f.check,
          questions: [entry],
          detail: f.detail,
          likelyCause: f.likelyCause,
          suggestedFix: f.suggestedFix,
        });
      }
    }
  }

  return [...byCheck.values()];
}

// ─── Files to inspect heuristic ──────────────────────────────────────────────

// Returns a short list of files most relevant to each check type.
function filesForCheck(check: string): string[] {
  const map: Record<string, string[]> = {
    "overconfident-phrasing":    ["src/ask.ts (TEACHING_STYLE, GRAMMAR_ACCURACY_RULES)", "src/eval/critic.ts (checkOverconfidentPhrases)"],
    "romaji-accuracy":           ["src/ask.ts (GRAMMAR_ACCURACY_RULES — Romaji accuracy section)", "src/eval/critic.ts (ROMAJI_MISTAKES table)"],
    "mixed-language-garbage":    ["src/ask.ts (OUTPUT_RULES)", "src/eval/critic.ts (checkMixedLanguageGarbage)"],
    "kirei-classification":      ["src/ask.ts (GRAMMAR_ACCURACY_RULES — Known exceptions)", "src/eval/critic.ts (checkKireiClassification)"],
    "semantic-mismatch":         ["src/ask.ts (GRAMMAR_ACCURACY_RULES — Example quality rules)", "src/eval/critic.ts (SEMANTIC_VIOLATIONS)"],
    "known-verb-error":          ["src/ask.ts (GRAMMAR_ACCURACY_RULES — Known exceptions)", "src/eval/critic.ts (TE_FORM_ERRORS)"],
    "particle-confusion":        ["src/ask.ts (GRAMMAR_ACCURACY_RULES — particle rules)", "src/eval/critic.ts (checkParticleConfusion)"],
    "hebrew-repetition":         ["src/ask.ts (HEBREW_BASE_RULES)", "src/eval/critic.ts (checkHebrewRepetition)"],
    "hebrew-duplicate-sentence": ["src/ask.ts (HEBREW_BASE_RULES)", "src/eval/critic.ts (checkHebrewDuplicateSentences)"],
    "romaji-in-example":         ["src/ask.ts (GRAMMAR_ACCURACY_RULES)", "src/eval/critic.ts (checkRomajiPresence)"],
    "suki-particle":             ["src/ask.ts (GRAMMAR_ACCURACY_RULES)", "src/eval/critic.ts (checkSukiParticle)"],
    "to-vs-wo":                  ["src/ask.ts (GRAMMAR_ACCURACY_RULES)", "src/eval/critic.ts (checkToVsWo)"],
    "empty-parentheses":         ["src/ask.ts (cleanOutput)", "src/eval/critic.ts (checkEmptyParens)"],
    "weird-numbering":           ["src/ask.ts (cleanOutput)", "src/eval/critic.ts (checkWeirdNumbering)"],
  };
  return map[check] ?? ["src/ask.ts", "src/eval/critic.ts"];
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function renderTask(task: FixTask, index: number): string {
  const affectedIds = task.questions.map((q) => `${q.id} (${q.topic})`).join(", ");
  const files = filesForCheck(task.check).map((f) => `- \`${f}\``).join("\n");

  const excerptLines = task.questions
    .filter((q) => q.excerpt)
    .map((q) => `- **${q.id}:** ${q.excerpt}`)
    .join("\n");

  const questionLines = task.questions
    .map((q) => `- **${q.id}** (${q.topic}): ${q.question}`)
    .join("\n");

  return [
    `## Task ${index}: Fix \`${task.check}\``,
    "",
    `**Check:** \`${task.check}\``,
    `**Affected questions:** ${affectedIds}`,
    "",
    "### Affected question(s)",
    "",
    questionLines,
    "",
    excerptLines ? "### Offending excerpt(s)\n\n" + excerptLines : "",
    task.detail      ? `### Problem summary\n\n${task.detail}` : "",
    task.likelyCause ? `### Likely cause\n\n${task.likelyCause}` : "",
    task.suggestedFix ? `### Suggested fix\n\n${task.suggestedFix}` : "",
    "### Files to inspect",
    "",
    files,
    "",
    "### Instructions",
    "",
    "- Do not change eval questions unless the question itself is the source of the error.",
    "- Prefer fixing the model prompt (`src/ask.ts`) over silencing the critic check.",
    "- If the critic check is a false positive, narrow the check in `src/eval/critic.ts` and document why.",
    "- After making changes, re-run `npm run eval:sensei` then `npm run eval:critic` to verify the fix.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function renderReport(tasks: FixTask[], runTimestamp: string | undefined, generatedAt: string): string {
  const lines: string[] = [
    "# Sensei Eval — Fix Tasks",
    "",
    `Generated: ${generatedAt}`,
    `Source: evals/runs/latest/critic_report.md`,
    runTimestamp ? `Run timestamp: ${runTimestamp}` : "",
    `Total tasks: ${tasks.length}`,
    "",
    "---",
    "",
    "> Copy each task block below into a Claude Code prompt.",
    "> Each task is self-contained: it describes the problem, the affected questions, and where to look.",
    "",
    "---",
    "",
  ].filter((l) => l !== undefined) as string[];

  tasks.forEach((task, i) => {
    lines.push(renderTask(task, i + 1));
    lines.push("");
    lines.push("---");
    lines.push("");
  });

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  if (!fs.existsSync(REPORT_PATH)) {
    console.error("Critic report not found:", REPORT_PATH);
    console.error("Run `npm run eval:critic` first.");
    process.exit(1);
  }

  const md = fs.readFileSync(REPORT_PATH, "utf-8");
  const runTimestamp = parseRunTimestamp(md);
  const failed = parseFailedQuestions(md);

  if (failed.length === 0) {
    console.log("No failed questions found in the critic report. Nothing to generate.");
    process.exit(0);
  }

  const tasks = groupIntoTasks(failed);
  const output = renderReport(tasks, runTimestamp, new Date().toISOString());

  fs.writeFileSync(OUTPUT_PATH, output, "utf-8");

  console.log(`Generated ${tasks.length} fix task(s) from ${failed.length} failed question(s).`);
  console.log(`Saved to: ${OUTPUT_PATH}`);
}

main();
