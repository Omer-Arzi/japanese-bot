import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

const PROJECT_DIR = path.join(__dirname, "..", "..");
const QUESTIONS_PATH = path.join(PROJECT_DIR, "evals", "questions.json");
const OUTPUT_DIR = path.join(PROJECT_DIR, "evals", "runs", "latest");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "answers.json");

// Timeout per question in ms (LLM calls can be slow)
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

interface Question {
  id: string;
  topic: string;
  question: string;
}

interface ChunkInfo {
  chunkId: string;
  sourceType: string;
  lessonNumber: number | null;
  score: number;
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

async function runEval(): Promise<void> {
  if (!fs.existsSync(QUESTIONS_PATH)) {
    console.error("Questions file not found:", QUESTIONS_PATH);
    process.exit(1);
  }

  const questions: Question[] = JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf-8"));
  console.log(`Running eval for ${questions.length} questions...\n`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const results: EvalResult[] = [];

  for (const q of questions) {
    const start = Date.now();
    process.stdout.write(`[${q.id}] ${q.topic} ... `);

    try {
      const stdout = await runAskSensei(q.question);
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
