import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { loadConfig } from "../llm/config";

const PROJECT_DIR = path.join(__dirname, "..", "..");
const QUESTIONS_PATH = path.join(PROJECT_DIR, "evals", "questions.json");
const SMOKE_IDS_PATH = path.join(PROJECT_DIR, "evals", "smoke-ids.json");
const OUTPUT_DIR = path.join(PROJECT_DIR, "evals", "runs", "latest");

const IS_SMOKE = process.argv.includes("--smoke");
const OUTPUT_PATH = path.join(OUTPUT_DIR, IS_SMOKE ? "smoke_answers.json" : "answers.json");

// Timeout per question in ms (LLM calls can be slow)
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

interface Question {
  id: string;
  topic: string;
  question: string;
  type?: "standalone" | "followup";
  dependsOn?: string;
  expectedBehavior?: string[];
}

interface ChunkInfo {
  chunkId: string;
  sourceType: string;
  lessonNumber: number | null;
  score: number;
}

interface PreviousTurn {
  question: string;
  answer: string;
}

interface EvalResult {
  id: string;
  topic: string;
  question: string;
  answer: string;
  retrievedChunks: ChunkInfo[];
  timestamp: string;
  durationMs: number;
  error?: string;
  type?: "standalone" | "followup";
  dependsOn?: string;
  expectedBehavior?: string[];
  previousTurn?: PreviousTurn;
}

// Run ask-sensei for a single question, collect stdout.
function runAskSensei(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["bin/ask-sensei", question], {
      cwd: PROJECT_DIR,
    });

    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Timed out"));
    }, QUESTION_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) {
        reject(new Error(`ask-sensei exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Extract the answer text from ask-sensei stdout (everything after the last "Answer:\n").
function extractAnswer(stdout: string): string {
  const marker = "Answer:\n";
  const pos = stdout.lastIndexOf(marker);
  if (pos === -1) return stdout.trim();
  return stdout.slice(pos + marker.length).trim();
}

// Parse the "Selected chunks:" diagnostic block from stdout.
// Lines look like: "    lesson-01-introduction-0  lesson 1  score: 0.8421"
function extractChunks(stdout: string): ChunkInfo[] {
  const sectionMatch = stdout.match(/Selected chunks:([\s\S]*?)(?:Asking model|$)/);
  if (!sectionMatch) return [];

  const chunks: ChunkInfo[] = [];
  const sourceTypeRe = /\[(\w+)\]/g;
  const chunkLineRe = /^\s{4}(\S+)(?:\s+lesson\s+(\d+))?\s+score:\s+([\d.]+)/;

  let currentSourceType = "unknown";
  for (const line of sectionMatch[1]!.split("\n")) {
    const typeMatch = sourceTypeRe.exec(line);
    if (typeMatch) {
      currentSourceType = typeMatch[1]!;
      sourceTypeRe.lastIndex = 0;
      continue;
    }
    const chunkMatch = chunkLineRe.exec(line);
    if (chunkMatch) {
      chunks.push({
        chunkId: chunkMatch[1]!,
        sourceType: currentSourceType,
        lessonNumber: chunkMatch[2] != null ? parseInt(chunkMatch[2], 10) : null,
        score: parseFloat(chunkMatch[3]!),
      });
    }
  }

  return chunks;
}

async function checkLlmHealth(): Promise<void> {
  const cfg = await loadConfig();
  const isOllama = cfg.provider === "ollama";
  const base = cfg.baseUrl.replace(/\/v1\/?$/, "");
  const url = isOllama ? `${base}/api/tags` : `${base}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND")) {
      const hint = isOllama
        ? `Ollama is not running.\n  Start it with: ollama serve\n  Expected at: ${base}`
        : `vLLM server is not running.\n  Expected at: ${base}`;
      console.error(`\n✗  ${hint}\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function runEval(): Promise<void> {
  if (!fs.existsSync(QUESTIONS_PATH)) {
    console.error("Questions file not found:", QUESTIONS_PATH);
    process.exit(1);
  }

  await checkLlmHealth();

  let questions: Question[] = JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf-8"));

  if (IS_SMOKE) {
    if (!fs.existsSync(SMOKE_IDS_PATH)) {
      console.error("Smoke IDs file not found:", SMOKE_IDS_PATH);
      process.exit(1);
    }
    const smokeIds: string[] = JSON.parse(fs.readFileSync(SMOKE_IDS_PATH, "utf-8"));
    const smokeSet = new Set(smokeIds);
    questions = questions.filter((q) => smokeSet.has(q.id));
    console.log(`[smoke] Running ${questions.length}/${smokeIds.length} questions...\n`);
  } else {
    console.log(`Running eval for ${questions.length} questions...\n`);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const results: EvalResult[] = [];

  for (const q of questions) {
    const start = Date.now();
    const isFollowup = q.type === "followup" && q.dependsOn != null;
    process.stdout.write(`[${q.id}] ${q.topic}${isFollowup ? " [followup]" : ""} ... `);

    // For followup questions: find the previous result and embed its Q&A as context.
    let previousTurn: PreviousTurn | undefined;
    let questionToSend = q.question;
    if (isFollowup && q.dependsOn) {
      const prev = results.find((r) => r.id === q.dependsOn);
      if (prev && prev.answer) {
        previousTurn = { question: prev.question, answer: prev.answer };
        questionToSend =
          `[Previous question]: ${prev.question}\n` +
          `[Previous answer]: ${prev.answer}\n\n` +
          `[Follow-up question]: ${q.question}`;
      } else {
        console.log(`SKIP (previous question ${q.dependsOn} not found or failed)`);
        results.push({
          id: q.id,
          topic: q.topic,
          question: q.question,
          answer: "",
          retrievedChunks: [],
          timestamp: new Date().toISOString(),
          durationMs: 0,
          error: `Previous question ${q.dependsOn} not found or failed — cannot evaluate follow-up`,
          ...(q.type ? { type: q.type } : {}),
          ...(q.dependsOn ? { dependsOn: q.dependsOn } : {}),
          ...(q.expectedBehavior ? { expectedBehavior: q.expectedBehavior } : {}),
        });
        continue;
      }
    }

    try {
      const stdout = await runAskSensei(questionToSend);
      const answer = extractAnswer(stdout);
      const retrievedChunks = extractChunks(stdout);
      const durationMs = Date.now() - start;

      results.push({
        id: q.id,
        topic: q.topic,
        question: q.question,
        answer,
        retrievedChunks,
        timestamp: new Date().toISOString(),
        durationMs,
        ...(q.type ? { type: q.type } : {}),
        ...(q.dependsOn ? { dependsOn: q.dependsOn } : {}),
        ...(q.expectedBehavior ? { expectedBehavior: q.expectedBehavior } : {}),
        ...(previousTurn ? { previousTurn } : {}),
      });

      console.log(`done (${(durationMs / 1000).toFixed(1)}s, ${retrievedChunks.length} chunks)`);
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      results.push({
        id: q.id,
        topic: q.topic,
        question: q.question,
        answer: "",
        retrievedChunks: [],
        timestamp: new Date().toISOString(),
        durationMs,
        error: message,
        ...(q.type ? { type: q.type } : {}),
        ...(q.dependsOn ? { dependsOn: q.dependsOn } : {}),
        ...(q.expectedBehavior ? { expectedBehavior: q.expectedBehavior } : {}),
        ...(previousTurn ? { previousTurn } : {}),
      });

      console.log(`FAILED: ${message}`);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), "utf-8");

  const passed = results.filter((r) => !r.error).length;
  console.log(`\nCompleted: ${passed}/${results.length} succeeded`);
  console.log(`Saved to: ${OUTPUT_PATH}`);
}

runEval().catch((err) => {
  console.error(err);
  process.exit(1);
});
